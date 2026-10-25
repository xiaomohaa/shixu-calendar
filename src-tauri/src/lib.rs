mod dav;
mod feeds;
mod notifications;
mod storage;
mod updates;
#[cfg(windows)]
mod vault;
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
};
use tauri::{Emitter, Manager};
use tauri_plugin_autostart::ManagerExt;
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_notification::NotificationExt;

fn desktop_state(app: &tauri::AppHandle) -> Result<Value, String> {
    let installed = !app.config().identifier.ends_with(".dev");
    let enabled = if installed {
        app.autolaunch()
            .is_enabled()
            .map_err(|_| "读取开机自启状态失败")?
    } else {
        false
    };
    Ok(
        json!({"mode": if installed { "installer" } else { "development" },
        "openAtLogin": enabled, "startupEnabled": enabled, "canAutoStart": installed}),
    )
}

fn show_main(app: &tauri::AppHandle) {
    if let Some(window) = app.get_webview_window("main") {
        let _ = window.unminimize();
        let _ = window.show();
        let _ = window.set_focus();
    }
}

#[derive(Default)]
struct SyncTracker {
    active: Mutex<HashMap<String, Arc<AtomicBool>>>,
    immediate: Mutex<HashMap<String, Arc<AtomicBool>>>,
}

fn request_immediate_sync(app: &tauri::AppHandle, id: String) {
    let tracker = app.state::<SyncTracker>();
    let pending = Arc::new(AtomicBool::new(true));
    {
        let Ok(mut requests) = tracker.immediate.lock() else {
            return;
        };
        if let Some(existing) = requests.get(&id) {
            existing.store(true, Ordering::SeqCst);
            return;
        }
        requests.insert(id.clone(), pending.clone());
    }
    let app = app.clone();
    tauri::async_runtime::spawn(async move {
        loop {
            let tracker = app.state::<SyncTracker>();
            let owns = tracker
                .immediate
                .lock()
                .map(|requests| {
                    requests
                        .get(&id)
                        .is_some_and(|owner| Arc::ptr_eq(owner, &pending))
                })
                .unwrap_or(false);
            if !owns {
                return;
            }
            if app.state::<updates::Updates>().is_installing() {
                if let Ok(mut requests) = tracker.immediate.lock() {
                    if requests
                        .get(&id)
                        .is_some_and(|owner| Arc::ptr_eq(owner, &pending))
                    {
                        requests.remove(&id);
                    }
                }
                return;
            }
            if tracker
                .active
                .lock()
                .map(|active| active.contains_key(&id))
                .unwrap_or(true)
            {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                continue;
            }
            pending.store(false, Ordering::SeqCst);
            let result = sync_one(&id, &app).await;
            if matches!(result.as_ref(),Err(error) if error == "账户正在同步") {
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
                continue;
            }
            let Ok(mut requests) = tracker.immediate.lock() else {
                return;
            };
            if !requests
                .get(&id)
                .is_some_and(|owner| Arc::ptr_eq(owner, &pending))
            {
                return;
            }
            if pending.load(Ordering::SeqCst)
                && !matches!(result.as_ref(),Err(error) if error == "同步已取消")
            {
                continue;
            }
            requests.remove(&id);
            return;
        }
    });
}

impl SyncTracker {
    async fn stop_for_update(&self) -> Result<(), String> {
        self.immediate
            .lock()
            .map_err(|_| "同步状态暂时不可用")?
            .clear();
        {
            let active = self.active.lock().map_err(|_| "同步状态暂时不可用")?;
            for cancel in active.values() {
                cancel.store(true, Ordering::SeqCst);
            }
        }
        for _ in 0..100 {
            if self
                .active
                .lock()
                .map_err(|_| "同步状态暂时不可用")?
                .is_empty()
            {
                return Ok(());
            }
            tokio::time::sleep(std::time::Duration::from_millis(100)).await;
        }
        Err("同步尚未停止，请稍后重试安装".into())
    }
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
    let subscription = store
        .lock()
        .map_err(|_| "本地数据库暂时不可用")?
        .is_subscription(id)?;
    if subscription {
        let ics = feeds::fetch(&account.url, account.allow_http).await?;
        check_cancelled(cancel)?;
        store
            .lock()
            .map_err(|_| "本地数据库暂时不可用")?
            .refresh_feed(id, &account.url, &ics)?;
        let _ = app.emit("shixu:changed", ());
        return Ok(());
    }
    if !account.password.starts_with("dpapi:v1:") {
        return Err("旧版密码无法在当前 Windows 用户下解密。请编辑账户，重新输入密码或应用专用密码后再同步。".into());
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

async fn sync_one(id: &str, app: &tauri::AppHandle) -> Result<(), String> {
    let store = app.state::<Mutex<storage::Store>>();
    let tracker = app.state::<SyncTracker>();
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut active = tracker.active.lock().map_err(|_| "同步状态暂时不可用")?;
        if app.state::<updates::Updates>().is_installing() {
            return Err("更新正在安装，暂时无法开始同步".into());
        }
        if active.contains_key(id) {
            return Err("账户正在同步".into());
        }
        active.insert(id.to_owned(), cancel.clone());
    }
    let lease = SyncLease {
        id: id.to_owned(),
        tracker: &tracker,
        app,
    };
    let _ = app.emit("shixu:changed", ());
    let result = sync_account(id, &store, app, &cancel).await;
    drop(lease);
    if let Err(error) = &result {
        if error != "同步已取消" {
            let _ = store
                .lock()
                .map_err(|_| "本地数据库暂时不可用")?
                .set_account_error(id, Some(error));
            let _ = app.emit("shixu:changed", ());
        }
    }
    result
}

#[tauri::command]
async fn shixu_call(
    method: String,
    args: Vec<Value>,
    store: tauri::State<'_, Mutex<storage::Store>>,
    syncing: tauri::State<'_, SyncTracker>,
    app: tauri::AppHandle,
    window: tauri::WebviewWindow,
) -> Result<Value, String> {
    if window.label() != "main" {
        return Err("此窗口不能访问日历命令".into());
    }
    if method == "updateState" {
        if !args.is_empty() {
            return Ok(json!({"ok":false,"error":"更新参数无效"}));
        }
        return Ok(match app.state::<updates::Updates>().state() {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"error":error}),
        });
    }
    if method == "checkForUpdates" || method == "downloadUpdate" || method == "installUpdate" {
        if !args.is_empty() {
            return Ok(json!({"ok":false,"error":"更新参数无效"}));
        }
        let result = match method.as_str() {
            "checkForUpdates" => updates::check(&app).await,
            "downloadUpdate" => updates::download(&app).await,
            _ => updates::install(&app, &syncing).await,
        };
        return Ok(match result {
            Ok(()) => json!({"ok":true,"value":null}),
            Err(error) => json!({"ok":false,"error":error}),
        });
    }
    if method == "cancelUpdateDownload" {
        if !args.is_empty() {
            return Ok(json!({"ok":false,"error":"更新参数无效"}));
        }
        return Ok(match updates::cancel(&app) {
            Ok(()) => json!({"ok":true,"value":null}),
            Err(error) => json!({"ok":false,"error":error}),
        });
    }
    if method == "openReleasePage" {
        if !args.is_empty() {
            return Ok(json!({"ok":false,"error":"更新参数无效"}));
        }
        return Ok(
            match tauri_plugin_opener::open_url(
                "https://github.com/xiaomohaa/shixu-calendar/releases/latest",
                None::<&str>,
            ) {
                Ok(()) => json!({"ok":true,"value":null}),
                Err(_) => json!({"ok":false,"error":"无法打开发布页面"}),
            },
        );
    }
    if app.state::<updates::Updates>().is_installing()
        && matches!(
            method.as_str(),
            "saveAccount"
                | "importCalendarUrl"
                | "deleteAccount"
                | "queueEvent"
                | "resolveConflict"
                | "settings"
                | "setCalendar"
                | "clearCache"
                | "restore"
                | "notifyReminder"
                | "testNotification"
        )
    {
        return Ok(json!({"ok":false,"error":"更新正在安装，请稍后再修改数据"}));
    }
    if method == "importCalendarUrl" {
        let result: Result<Value, String> = async {
            if args.len() != 1 {
                return Err("ICS 导入参数无效".into());
            }
            let mut input: feeds::FeedInput =
                serde_json::from_value(args[0].clone()).map_err(|_| "ICS 导入参数无效")?;
            input.validate()?;
            let ics = feeds::fetch(&input.url, input.allow_http).await?;
            if app.state::<updates::Updates>().is_installing() {
                return Err("更新正在安装，请稍后导入".into());
            }
            let id = store
                .lock()
                .map_err(|_| "本地数据库暂时不可用")?
                .import_feed(&input, &ics)?;
            let _ = app.emit("shixu:changed", ());
            Ok(json!(id))
        }
        .await;
        return Ok(match result {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"error":error}),
        });
    }
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
            if let Err(error) = sync_one(&id, &app).await {
                if error == "同步已取消" {
                    return Ok(json!({"ok": true, "value": null}));
                }
                return Ok(json!({"ok": false, "error": error}));
            }
        }
        return Ok(json!({"ok": true, "value": null}));
    }
    if method == "cancelSync" {
        syncing
            .immediate
            .lock()
            .map_err(|_| "同步状态暂时不可用")?
            .clear();
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
    if method == "desktopState" {
        return Ok(match desktop_state(&app) {
            Ok(value) => json!({"ok": true, "value": value}),
            Err(error) => json!({"ok": false, "error": error}),
        });
    }
    if method == "setAutoStart" {
        let result: Result<Value, String> = (|| {
            if args.len() != 1 {
                return Err("开机自启参数无效".into());
            }
            let enabled = args[0].as_bool().ok_or("开机自启参数无效")?;
            if app.config().identifier.ends_with(".dev") {
                return Err("请安装正式安装版后设置开机自启".into());
            }
            if enabled {
                app.autolaunch().enable().map_err(|_| "开启开机自启失败")?;
            } else {
                app.autolaunch().disable().map_err(|_| "关闭开机自启失败")?;
            }
            desktop_state(&app)
        })();
        return Ok(match result {
            Ok(value) => json!({"ok": true, "value": value}),
            Err(error) => json!({"ok": false, "error": error}),
        });
    }
    if method == "quitApp" {
        if !args.is_empty() {
            return Ok(json!({"ok": false, "error": "退出参数无效"}));
        }
        app.exit(0);
        return Ok(json!({"ok": true, "value": null}));
    }
    if method == "backup" {
        let result: Result<Value, String> = (|| {
            if args.len() != 1 || !args[0].is_object() {
                return Err("备份参数无效".into());
            }
            let settings = store
                .lock()
                .map_err(|_| "本地数据库暂时不可用")?
                .snapshot(args[0].clone())
                .map_err(|_| "读取偏好失败")?["settings"]
                .clone();
            let path = app
                .dialog()
                .file()
                .set_title("备份日历偏好")
                .set_file_name("时序设置.json")
                .add_filter("JSON 设置", &["json"])
                .blocking_save_file();
            let Some(path) = path else {
                return Ok(json!(false));
            };
            let path = path.into_path().map_err(|_| "备份路径无效")?;
            let content = serde_json::to_vec_pretty(
                &json!({"format":"shixu-settings-v1","settings":settings}),
            )
            .map_err(|_| "无法生成偏好备份")?;
            std::fs::write(path, content).map_err(|_| "写入偏好备份失败")?;
            Ok(json!(true))
        })();
        return Ok(match result {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"error":error}),
        });
    }
    if method == "restore" {
        let result: Result<Value, String> = (|| {
            if !args.is_empty() {
                return Err("恢复参数无效".into());
            }
            let path = app
                .dialog()
                .file()
                .set_title("恢复日历偏好")
                .add_filter("JSON 设置", &["json"])
                .blocking_pick_file();
            let Some(path) = path else {
                return Ok(json!(false));
            };
            let path = path.into_path().map_err(|_| "备份路径无效")?;
            if std::fs::metadata(&path).map_err(|_| "读取备份失败")?.len() > 128 * 1024 {
                return Err("偏好备份过大".into());
            }
            let content = std::fs::read(&path).map_err(|_| "读取备份失败")?;
            let backup: Value =
                serde_json::from_slice(&content).map_err(|_| "偏好备份不是有效 JSON")?;
            if backup.get("format").and_then(Value::as_str) != Some("shixu-settings-v1") {
                return Err("偏好备份格式不受支持".into());
            }
            let settings = backup.get("settings").cloned().ok_or("偏好备份缺少设置")?;
            store
                .lock()
                .map_err(|_| "本地数据库暂时不可用")?
                .restore_settings(settings)?;
            let _ = app.emit("shixu:changed", ());
            Ok(json!(true))
        })();
        return Ok(match result {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"error":error}),
        });
    }
    if method == "clearCache" {
        if !args.is_empty() {
            return Ok(json!({"ok":false,"error":"缓存参数无效"}));
        }
        if !syncing
            .active
            .lock()
            .map_err(|_| "同步状态暂时不可用")?
            .is_empty()
        {
            return Ok(json!({"ok":false,"error":"请等待同步完成后清除缓存"}));
        }
        let confirmed = app
            .dialog()
            .message("清除已同步的本地缓存？未同步修改和冲突会保留，下次同步会重新下载日程。")
            .title("时序日历")
            .buttons(tauri_plugin_dialog::MessageDialogButtons::OkCancel)
            .blocking_show();
        if !confirmed {
            return Ok(json!({"ok":true,"value":null}));
        }
        let result = store
            .lock()
            .map_err(|_| "本地数据库暂时不可用")?
            .clear_cache();
        return Ok(match result {
            Ok(()) => {
                let _ = app.emit("shixu:changed", ());
                json!({"ok":true,"value":null})
            }
            Err(error) => json!({"ok":false,"error":error}),
        });
    }
    if method == "reminderResources" {
        let result = if args.len() == 1 && args[0].is_object() {
            store
                .lock()
                .map_err(|_| "本地数据库暂时不可用")?
                .reminder_resources(args[0].clone())
                .map_err(|_| "读取提醒日程失败".to_owned())
        } else {
            Err("提醒参数无效".into())
        };
        return Ok(match result {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"error":error}),
        });
    }
    if method == "takeReminderOpen" {
        if !args.is_empty() {
            return Err("提醒操作参数无效".into());
        }
        return Ok(json!({"ok":true,"value":notifications::take_open(&app)?}));
    }
    if method == "testNotification" {
        if !args.is_empty() {
            return Err("测试通知参数无效".into());
        }
        let notice = notifications::Notice::new(
            format!("test:{}", uuid::Uuid::new_v4()),
            "测试日程提醒".into(),
            "这是一条测试日程提醒，用于确认当前通知方式。".into(),
            None,
            true,
        )?;
        return Ok(json!({"ok":true,"value":notifications::enqueue(&app,notice)?}));
    }
    if method == "notifyReminder" {
        let result: Result<Value, String> = (|| {
            if args.len() != 3 && args.len() != 4 {
                return Err("提醒参数无效".into());
            }
            let (Some(key), Some(title), Some(body)) =
                (args[0].as_str(), args[1].as_str(), args[2].as_str())
            else {
                return Err("提醒参数无效".into());
            };
            let event = if args.len() == 4 {
                Some(
                    serde_json::from_value::<notifications::EventReference>(args[3].clone())
                        .map_err(|_| "提醒日程参数无效")?,
                )
            } else {
                None
            };
            let notice =
                notifications::Notice::new(key.into(), title.into(), body.into(), event, false)?;
            notifications::enqueue(&app, notice).map(|accepted| json!(accepted))
        })();
        return Ok(match result {
            Ok(value) => json!({"ok":true,"value":value}),
            Err(error) => json!({"ok":false,"error":error}),
        });
    }
    let mut store = store
        .lock()
        .map_err(|_| "本地数据库暂时不可用".to_string())?;
    let mut changed = false;
    let mut sync_after = None;
    let result: Result<Value, String> = match method.as_str() {
        "snapshot" if args.len() == 1 && args[0].is_object() => {
            let mut snapshot = store
                .snapshot(args[0].clone())
                .map_err(|_| "读取本地数据库失败")?;
            snapshot["syncing"] = json!(syncing
                .active
                .lock()
                .map_err(|_| "同步状态暂时不可用")?
                .keys()
                .collect::<Vec<_>>());
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
                (Some(calendar_id), resource_id, expected_ics, Some(ics), Some(delete)) => {
                    store.calendar_account(calendar_id).and_then(|id| {
                        store
                            .queue_event(calendar_id, resource_id, expected_ics, ics, delete)
                            .map(|_| {
                                sync_after = Some(id);
                                Value::Null
                            })
                    })
                }
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
    drop(store);
    match result {
        Ok(value) => {
            if let Some(id) = sync_after {
                request_immediate_sync(&app, id);
            }
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
        .plugin(tauri_plugin_single_instance::init(|app, _, _| {
            show_main(app);
        }))
        .setup(|app| {
            let data_dir = if app.config().identifier.ends_with(".dev") {
                std::env::var_os("SHIXU_TAURI_TEST_DATA_DIR")
                    .map(std::path::PathBuf::from)
                    .unwrap_or(app.path().app_data_dir()?)
            } else {
                app.path().app_data_dir()?
            };
            std::fs::create_dir_all(&data_dir)?;
            let database_path = data_dir.join("calendar.db");
            let legacy_dir = if app.config().identifier.ends_with(".dev") {
                std::env::var_os("SHIXU_TAURI_TEST_LEGACY_DIR").map(std::path::PathBuf::from)
            } else {
                std::env::var_os("APPDATA")
                    .map(|path| std::path::PathBuf::from(path).join("时序日历"))
            };
            let imported = if let Some(legacy_dir) = &legacy_dir {
                let source = legacy_dir.join("calendar.db");
                if !database_path.exists() && source.is_file() && legacy_dir != &data_dir {
                    let staging = data_dir.join("calendar.importing.db");
                    if staging.exists() {
                        std::fs::remove_file(&staging)?;
                    }
                    if let Err(error) = storage::Store::copy_legacy(&source, &staging) {
                        let _ = std::fs::remove_file(&staging);
                        return Err(std::io::Error::other(format!(
                            "旧版日历数据无法安全复制：{error}"
                        ))
                        .into());
                    }
                    std::fs::rename(&staging, &database_path)?;
                    true
                } else {
                    false
                }
            } else {
                false
            };
            let mut store = storage::Store::open(&database_path)?;
            if imported {
                if let Some(legacy_dir) = &legacy_dir {
                    store
                        .rewrap_legacy_credentials(&legacy_dir.join("Local State"))
                        .map_err(std::io::Error::other)?;
                }
            }
            let silent_startup = store.silent_startup();
            app.manage(Mutex::new(store));
            app.manage(SyncTracker::default());
            app.manage(notifications::Notifications::default());
            app.manage(updates::Updates::new(
                app.package_info().version.to_string(),
                app.config().identifier.ends_with(".dev"),
            ));
            let notification_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(2)).await;
                    if !notification_app.state::<updates::Updates>().is_installing() {
                        notifications::maintain(&notification_app);
                    }
                }
            });
            let background_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                let mut last_auto: Option<std::time::Instant> = None;
                loop {
                    tokio::time::sleep(std::time::Duration::from_secs(30)).await;
                    if background_app.state::<updates::Updates>().is_installing() {
                        continue;
                    }
                    let _ = background_app.emit("shixu:reminder-tick", ());
                    let (minutes, ids) =
                        match background_app.state::<Mutex<storage::Store>>().lock() {
                            Ok(store) => match store.auto_sync_interval() {
                                Some(minutes) => (minutes, store.account_ids().unwrap_or_default()),
                                None => continue,
                            },
                            Err(_) => continue,
                        };
                    let now = std::time::Instant::now();
                    if last_auto.is_some_and(|last| {
                        now.duration_since(last) < std::time::Duration::from_secs(minutes * 60)
                    }) {
                        continue;
                    }
                    last_auto = Some(now);
                    for id in ids {
                        let _ = sync_one(&id, &background_app).await;
                    }
                }
            });
            let update_app = app.handle().clone();
            tauri::async_runtime::spawn(async move {
                tokio::time::sleep(std::time::Duration::from_secs(12)).await;
                loop {
                    let enabled = update_app
                        .state::<Mutex<storage::Store>>()
                        .lock()
                        .is_ok_and(|store| store.auto_update_check());
                    if enabled {
                        let _ = updates::check(&update_app).await;
                    }
                    tokio::time::sleep(std::time::Duration::from_secs(6 * 60 * 60)).await;
                }
            });
            app.handle().plugin(tauri_plugin_autostart::init(
                tauri_plugin_autostart::MacosLauncher::LaunchAgent,
                Some(vec!["--hidden"]),
            ))?;
            app.handle().plugin(tauri_plugin_dialog::init())?;
            app.handle().plugin(tauri_plugin_notification::init())?;
            let notification_app = app.handle().clone();
            app.notification().on_action(move |action| {
                if action.action_id() == "tap" {
                    let key = action
                        .notification()
                        .and_then(|notice| notice.extra().get("shixuReminderKey"))
                        .and_then(Value::as_str);
                    notifications::native_clicked(&notification_app, key);
                }
            })?;
            app.handle()
                .plugin(tauri_plugin_updater::Builder::new().build())?;
            app.handle().plugin(tauri_plugin_opener::init())?;
            let open =
                tauri::menu::MenuItem::with_id(app, "open", "打开时序日历", true, None::<&str>)?;
            let updates =
                tauri::menu::MenuItem::with_id(app, "updates", "检查更新", true, None::<&str>)?;
            let quit =
                tauri::menu::MenuItem::with_id(app, "quit", "退出时序日历", true, None::<&str>)?;
            let menu = tauri::menu::Menu::with_items(app, &[&open, &updates, &quit])?;
            tauri::tray::TrayIconBuilder::new()
                .icon(app.default_window_icon().ok_or("找不到应用图标")?.clone())
                .tooltip("时序日历")
                .menu(&menu)
                .show_menu_on_left_click(false)
                .on_menu_event(|app, event| match event.id.as_ref() {
                    "open" => show_main(app),
                    "updates" => {
                        show_main(app);
                        let _ = app.emit("shixu:open-settings", "updates");
                        let handle = app.clone();
                        tauri::async_runtime::spawn(async move {
                            let _ = updates::check(&handle).await;
                        });
                    }
                    "quit" => app.exit(0),
                    _ => {}
                })
                .on_tray_icon_event(|tray, event| {
                    if let tauri::tray::TrayIconEvent::Click {
                        button: tauri::tray::MouseButton::Left,
                        button_state: tauri::tray::MouseButtonState::Up,
                        ..
                    } = event
                    {
                        show_main(tray.app_handle());
                    }
                })
                .build(app)?;
            // Windows start hidden; reveal only after preferences and the tray are ready.
            // A missing tray is a setup error, so a silent launch cannot become unreachable.
            if !silent_startup && !std::env::args_os().any(|arg| arg == "--hidden") {
                show_main(app.handle());
            }
            if cfg!(debug_assertions) {
                app.handle().plugin(
                    tauri_plugin_log::Builder::default()
                        .level(log::LevelFilter::Info)
                        .build(),
                )?;
            }
            Ok(())
        })
        .on_window_event(|window, event| {
            if matches!(event, tauri::WindowEvent::Destroyed) {
                notifications::closed(window.app_handle(), window.label());
            }
            if window.label() != "main" {
                return;
            }
            if let tauri::WindowEvent::CloseRequested { api, .. } = event {
                let close_to_tray = window
                    .app_handle()
                    .state::<Mutex<storage::Store>>()
                    .lock()
                    .map(|store| store.close_to_tray())
                    .unwrap_or(true);
                api.prevent_close();
                if close_to_tray {
                    let _ = window.hide();
                } else {
                    window.app_handle().exit(0);
                }
            }
        })
        .invoke_handler(tauri::generate_handler![
            shixu_call,
            notifications::notification_call
        ])
        .run(tauri::generate_context!())
        .expect("error while building tauri application");
}
