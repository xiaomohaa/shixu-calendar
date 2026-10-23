mod dav;
mod storage;
#[cfg(windows)]
mod vault;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
use tauri::{Emitter, Manager};

#[derive(Default)]
struct SyncTracker {
    active: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

struct SyncLease<'a> {
    id: String,
    tracker: &'a SyncTracker,
    app: &'a tauri::AppHandle,
}
impl Drop for SyncLease<'_> {
    fn drop(&mut self) {
        if let Ok(mut active) = self.tracker.active.lock() {
            active.remove(&self.id);
        }
        let _ = self.app.emit("shixu:changed", ());
    }
}

fn check_cancelled(cancel: &AtomicBool) -> Result<(), String> {
    if cancel.load(Ordering::SeqCst) {
        Err("同步已取消".into())
    } else {
        Ok(())
    }
}

async fn sync_account(
    id: &str,
    store: &tauri::State<'_, Mutex<storage::Store>>,
    app: &tauri::AppHandle,
    cancel: &AtomicBool,
) -> Result<(), String> {
    check_cancelled(cancel)?;
    let account = store
        .lock()
        .map_err(|_| "本地数据库暂时不可用")?
        .account(id)?
        .ok_or("账户不存在")?;
    if account.paused {
        return Ok(());
    }
    let password = vault::open(&account.password)?;
    let input = dav::AccountInput {
        id: Some(account.id.clone()),
        name: "同步账户".into(),
        url: account.url,
        username: account.username,
        password: None,
        allow_http: account.allow_http,
        paused: false,
    };
    let client = dav::DavClient::new(&input, password)?;
    let discovered = client.discover(id).await?;
    check_cancelled(cancel)?;
    let calendars = store
        .lock()
        .map_err(|_| "本地数据库暂时不可用")?
        .sync_calendars(id, &discovered)?;
    let _ = app.emit("shixu:changed", ());
    for calendar in calendars {
        check_cancelled(cancel)?;
        let operations = store
            .lock()
            .map_err(|_| "本地数据库暂时不可用")?
            .pending_operations(&calendar.id)?;
        for operation in operations {
            check_cancelled(cancel)?;
            if calendar.read_only {
                return Err("日历当前为只读，本地修改已保留".into());
            }
            let result = if operation.kind == "delete" {
                if let Some(etag) = operation.base_etag.as_deref() {
                    client.delete(&operation.url, etag).await.map(|_| None)
                } else {
                    match client.get(&operation.url).await? {
                        Some(remote) => {
                            store
                                .lock()
                                .map_err(|_| "本地数据库暂时不可用")?
                                .conflict_operation(
                                    &operation,
                                    Some(&remote.ics),
                                    remote.etag.as_deref(),
                                )?;
                            let _ = app.emit("shixu:changed", ());
                            continue;
                        }
                        None => Ok(None),
                    }
                }
            } else {
                let etag = client
                    .put(
                        &operation.url,
                        &operation.ics,
                        operation.base_etag.as_deref(),
                    )
                    .await;
                match etag {
                    Ok(Some(etag)) => Ok(Some(etag)),
                    Ok(None) => client
                        .get(&operation.url)
                        .await
                        .map(|remote| remote.and_then(|r| r.etag)),
                    Err(error) => Err(error),
                }
            };
            match result {
                Ok(etag) => store
                    .lock()
                    .map_err(|_| "本地数据库暂时不可用")?
                    .complete_operation(&operation, etag.as_deref())?,
                Err(error) if error.ends_with("HTTP 412") => {
                    let remote = client.get(&operation.url).await?;
                    store
                        .lock()
                        .map_err(|_| "本地数据库暂时不可用")?
                        .conflict_operation(
                            &operation,
                            remote.as_ref().map(|r| r.ics.as_str()),
                            remote.as_ref().and_then(|r| r.etag.as_deref()),
                        )?;
                }
                Err(error) => {
                    store
                        .lock()
                        .map_err(|_| "本地数据库暂时不可用")?
                        .fail_operation(&operation.id, &error)?;
                    return Err(error);
                }
            }
            let _ = app.emit("shixu:changed", ());
        }
        let token = store
            .lock()
            .map_err(|_| "本地数据库暂时不可用")?
            .sync_token(&calendar.id)?;
        let pull = client.pull(&calendar, token.as_deref()).await?;
        check_cancelled(cancel)?;
        store
            .lock()
            .map_err(|_| "本地数据库暂时不可用")?
            .apply_pull(&calendar.id, pull)?;
        let _ = app.emit("shixu:changed", ());
    }
    store
        .lock()
        .map_err(|_| "本地数据库暂时不可用")?
        .finish_account_sync(id)?;
    let _ = app.emit("shixu:changed", ());
    Ok(())
}

#[tauri::command]
async fn shixu_call(
    method: String,
    args: Vec<Value>,
    store: tauri::State<'_, Mutex<storage::Store>>,
    syncing: tauri::State<'_, SyncTracker>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    if method == "testAccount" {
        let result: Result<Value, String> = async {
            if args.len() != 1 {
                return Err("账户参数无效".into());
            }
            let mut input: dav::AccountInput =
                serde_json::from_value(args.into_iter().next().unwrap())
                    .map_err(|_| "账户参数无效")?;
            input.validate()?;
            let supplied = input.password.take().filter(|value| !value.is_empty());
            let password = if let Some(password) = supplied {
                zeroize::Zeroizing::new(password)
            } else if let Some(id) = &input.id {
                let old = store
                    .lock()
                    .map_err(|_| "本地数据库暂时不可用")?
                    .account(id)?
                    .ok_or("账户已移除，请刷新")?;
                vault::open(&old.password)?
            } else {
                return Err("请输入密码或应用专用密码".into());
            };
            let client = dav::DavClient::new(&input, password)?;
            let calendars = client.discover(input.id.as_deref().unwrap_or("")).await?;
            serde_json::to_value(calendars).map_err(|_| "无法读取日历列表".into())
        }
        .await;
        return Ok(match result {
            Ok(value) => json!({"ok": true, "value": value}),
            Err(error) => json!({"ok": false, "error": error}),
        });
    }
    if method == "saveAccount" {
        let result: Result<Value, String> = async {
            if args.len() != 1 {
                return Err("账户参数无效".into());
            }
            let mut input: dav::AccountInput =
                serde_json::from_value(args.into_iter().next().unwrap())
                    .map_err(|_| "账户参数无效")?;
            input.validate()?;
            input.name = input.name.trim().to_string();
            input.url = dav::normalize_url(&input.url, input.allow_http)?.to_string();
            let id = input
                .id
                .clone()
                .unwrap_or_else(|| uuid::Uuid::new_v4().to_string());
            if syncing
                .active
                .lock()
                .map_err(|_| "同步状态暂时不可用")?
                .contains_key(&id)
            {
                return Err("账户正在同步，请完成或取消后修改".into());
            }
            let existing = store
                .lock()
                .map_err(|_| "本地数据库暂时不可用")?
                .account(&id)?;
            if input.id.is_some() && existing.is_none() {
                return Err("账户已移除，请刷新".into());
            }
            if let Some(existing) = &existing {
                if existing.url != input.url || existing.username != input.username {
                    return Err("服务器地址或用户名变更请添加新账户，防止混淆离线修改".into());
                }
            }
            let supplied = input
                .password
                .take()
                .filter(|password| !password.is_empty())
                .map(zeroize::Zeroizing::new);
            let ciphertext = match (&supplied, &existing) {
                (Some(password), _) => vault::seal(password.as_str())?,
                (None, Some(old)) => old.password.clone(),
                (None, None) => return Err("请输入密码或应用专用密码".into()),
            };
            let calendars = if existing.is_none() {
                let password = supplied.ok_or("请输入密码或应用专用密码")?;
                dav::DavClient::new(&input, password)?.discover(&id).await?
            } else {
                Vec::new()
            };
            store
                .lock()
                .map_err(|_| "本地数据库暂时不可用")?
                .save_account(&id, &input, &ciphertext, &calendars)?;
            let _ = app.emit("shixu:changed", ());
            Ok(json!(id))
        }
        .await;
        return Ok(match result {
            Ok(value) => json!({"ok": true, "value": value}),
            Err(error) => json!({"ok": false, "error": error}),
        });
    }
    if method == "sync" {
        let ids = if args.len() == 1 && args[0].is_string() {
            vec![args[0].as_str().unwrap().to_owned()]
        } else if args.len() == 1 && args[0].is_null() {
            store
                .lock()
                .map_err(|_| "本地数据库暂时不可用")?
                .account_ids()?
        } else {
            return Ok(json!({"ok": false, "error": "同步参数无效"}));
        };
        for id in ids {
            let cancel = Arc::new(AtomicBool::new(false));
            {
                let mut active = syncing.active.lock().map_err(|_| "同步状态暂时不可用")?;
                if active.contains_key(&id) {
                    return Ok(json!({"ok": false, "error": "账户正在同步"}));
                }
                active.insert(id.clone(), cancel.clone());
            }
            let lease = SyncLease {
                id: id.clone(),
                tracker: &syncing,
                app: &app,
            };
            let _ = app.emit("shixu:changed", ());
            let result = sync_account(&id, &store, &app, &cancel).await;
            drop(lease);
            if let Err(error) = result {
                if error == "同步已取消" {
                    return Ok(json!({"ok": true, "value": null}));
                }
                let _ = store
                    .lock()
                    .map_err(|_| "本地数据库暂时不可用")?
                    .set_account_error(&id, Some(&error));
                let _ = app.emit("shixu:changed", ());
                return Ok(json!({"ok": false, "error": error}));
            }
        }
        return Ok(json!({"ok": true, "value": null}));
    }
    if method == "cancelSync" {
        if !args.is_empty() {
            return Ok(json!({"ok": false, "error": "同步参数无效"}));
        }
        for cancel in syncing
            .active
            .lock()
            .map_err(|_| "同步状态暂时不可用")?
            .values()
        {
            cancel.store(true, Ordering::SeqCst);
        }
        return Ok(json!({"ok": true, "value": null}));
    }
    let mut store = store
        .lock()
        .map_err(|_| "本地数据库暂时不可用".to_string())?;
    let mut changed = false;
    let result: Result<Value, String> = match method.as_str() {
        "snapshot" if args.len() == 1 && args[0].is_object() => {
            let mut snapshot = store
                .snapshot(args[0].clone())
                .map_err(|_| "读取本地数据库失败")?;
            snapshot["syncing"] = json!(
                syncing
                    .active
                    .lock()
                    .map_err(|_| "同步状态暂时不可用")?
                    .keys()
                    .collect::<Vec<_>>()
            );
            Ok(snapshot)
        }
        "eventResources" if args.len() == 1 && args[0].is_object() => store
            .event_resources(args[0].clone())
            .map_err(|_| "读取本地日程失败".into()),
        "eventResource" if args.len() == 1 => args[0]
            .as_str()
            .ok_or("日程参数无效".into())
            .and_then(|id| store.event_resource(id)),
        "queueEvent" if args.len() == 5 => {
            changed = true;
            match (
                args[0].as_str(),
                args[1].as_str(),
                args[2].as_str(),
                args[3].as_str(),
                args[4].as_bool(),
            ) {
                (Some(calendar_id), resource_id, expected_ics, Some(ics), Some(delete)) => store
                    .queue_event(calendar_id, resource_id, expected_ics, ics, delete)
                    .map(|_| Value::Null),
                _ => Err("日程参数无效".into()),
            }
        }
        "deleteAccount" if args.len() == 1 => {
            changed = true;
            let id = args[0].as_str().ok_or("账户参数无效")?;
            if syncing
                .active
                .lock()
                .map_err(|_| "同步状态暂时不可用")?
                .contains_key(id)
            {
                Err("账户正在同步，请完成或取消后再删除".into())
            } else {
                store.delete_account(id).map(|_| Value::Null)
            }
        }
        "clearCache" if args.is_empty() => {
            changed = true;
            if !syncing
                .active
                .lock()
                .map_err(|_| "同步状态暂时不可用")?
                .is_empty()
            {
                Err("请等待同步完成后清除缓存".into())
            } else {
                store.clear_cache().map(|_| Value::Null)
            }
        }
        "resolveConflict" if args.len() == 3 => {
            changed = true;
            if !syncing
                .active
                .lock()
                .map_err(|_| "同步状态暂时不可用")?
                .is_empty()
            {
                Err("请等待同步完成后处理冲突".into())
            } else {
                match (args[0].as_str(), args[1].as_str()) {
                    (Some(id), Some(choice)) => store
                        .resolve_conflict(id, choice, args[2].as_str())
                        .map(|_| Value::Null),
                    _ => Err("冲突参数无效".into()),
                }
            }
        }
        "settings" if args.len() == 1 => {
            changed = true;
            store.set_settings(args[0].clone()).map(|_| Value::Null)
        }
        "setCalendar" if args.len() == 3 => {
            changed = true;
            match (args[0].as_str(), args[1].as_bool(), args[2].as_str()) {
                (Some(id), Some(visible), Some(color)) => {
                    store.set_calendar(id, visible, color).map(|_| Value::Null)
                }
                _ => Err("日历参数无效".into()),
            }
        }
        _ => return Ok(json!({"ok": false, "error": "此功能正在迁移到 Tauri，尚未开放"})),
    };
    match result {
        Ok(value) => {
            if changed {
                let _ = app.emit("shixu:changed", ());
            }
            Ok(json!({"ok": true, "value": value}))
        }
        Err(error) => Ok(json!({"ok": false, "error": error})),
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            let data_dir = if app.config().identifier.ends_with(".dev") {
                std::env::var_os("SHIXU_TAURI_TEST_DATA_DIR")
                    .map(std::path::PathBuf::from)
                    .unwrap_or(app.path().app_data_dir()?)
            } else {
                app.path().app_data_dir()?
            };
            std::fs::create_dir_all(&data_dir)?;
            let store = storage::Store::open(&data_dir.join("calendar.db"))?;
            app.manage(Mutex::new(store));
            app.manage(SyncTracker::default());
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![shixu_call])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
