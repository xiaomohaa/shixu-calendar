mod dav;
mod storage;
#[cfg(windows)]
mod vault;
use serde_json::{Value, json};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

#[tauri::command]
async fn shixu_call(
    method: String,
    args: Vec<Value>,
    store: tauri::State<'_, Mutex<storage::Store>>,
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
            let password = input
                .password
                .take()
                .filter(|value| !value.is_empty())
                .ok_or("请输入密码或应用专用密码")?;
            let client = dav::DavClient::new(&input, zeroize::Zeroizing::new(password))?;
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
    let store = store
        .lock()
        .map_err(|_| "本地数据库暂时不可用".to_string())?;
    let mut changed = false;
    let result: Result<Value, String> = match method.as_str() {
        "snapshot" if args.len() == 1 && args[0].is_object() => store
            .snapshot(args[0].clone())
            .map_err(|_| "读取本地数据库失败".into()),
        "eventResources" if args.len() == 1 && args[0].is_object() => store
            .event_resources(args[0].clone())
            .map_err(|_| "读取本地日程失败".into()),
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
