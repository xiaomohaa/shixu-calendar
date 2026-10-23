mod storage;
#[cfg(windows)]
mod vault;
use serde_json::{Value, json};
use std::sync::Mutex;
use tauri::{Emitter, Manager};

#[tauri::command]
fn shixu_call(
    method: String,
    args: Vec<Value>,
    store: tauri::State<'_, Mutex<storage::Store>>,
    app: tauri::AppHandle,
) -> Result<Value, String> {
    let store = store
        .lock()
        .map_err(|_| "本地数据库暂时不可用".to_string())?;
    let mut changed = false;
    let result: Result<Value, String> = match method.as_str() {
        "snapshot" if args.len() == 1 && args[0].is_object() => store
            .snapshot(args[0].clone())
            .map_err(|_| "读取本地数据库失败".into()),
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
            let data_dir = app.path().app_data_dir()?;
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
