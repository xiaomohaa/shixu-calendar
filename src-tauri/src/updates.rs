use serde::Serialize;
use serde_json::Value;
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::time::{Duration, Instant};
use tauri::{Emitter, Manager};
use tauri_plugin_updater::{Update, UpdaterExt};
use tokio::sync::Notify;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Release {
    version: String,
    notes: String,
    date: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Progress {
    percent: f64,
    transferred: u64,
    total: u64,
    bytes_per_second: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateState {
    current_version: String,
    mode: String,
    phase: String,
    release: Option<Release>,
    progress: Option<Progress>,
    last_checked: Option<String>,
    error: Option<String>,
}

pub struct Updates {
    state: Mutex<UpdateState>,
    pending: Mutex<Option<Update>>,
    downloaded: Mutex<Option<Vec<u8>>>,
    busy: AtomicBool,
    cancellation: Mutex<Option<Arc<Notify>>>,
}

struct Operation<'a>(&'a Updates);
impl Drop for Operation<'_> {
    fn drop(&mut self) {
        self.0.busy.store(false, Ordering::SeqCst);
    }
}

impl Updates {
    pub fn new(version: String, development: bool) -> Self {
        Self {
            state: Mutex::new(UpdateState {
                current_version: version,
                mode: if development {
                    "development"
                } else {
                    "installer"
                }
                .into(),
                phase: "idle".into(),
                release: None,
                progress: None,
                last_checked: None,
                error: None,
            }),
            pending: Mutex::new(None),
            downloaded: Mutex::new(None),
            busy: AtomicBool::new(false),
            cancellation: Mutex::new(None),
        }
    }
    fn enter(&self) -> Result<Operation<'_>, String> {
        if self.busy.swap(true, Ordering::SeqCst) {
            Err("更新操作正在进行".into())
        } else {
            Ok(Operation(self))
        }
    }
    pub fn state(&self) -> Result<Value, String> {
        serde_json::to_value(self.state.lock().map_err(|_| "更新状态暂时不可用")?.clone())
            .map_err(|_| "更新状态暂时不可用".into())
    }
    fn change(
        &self,
        app: &tauri::AppHandle,
        update: impl FnOnce(&mut UpdateState),
    ) -> Result<(), String> {
        let state = {
            let mut state = self.state.lock().map_err(|_| "更新状态暂时不可用")?;
            update(&mut state);
            state.clone()
        };
        let _ = app.emit("shixu:update", state);
        Ok(())
    }
    pub fn is_installing(&self) -> bool {
        self.state
            .lock()
            .is_ok_and(|state| state.phase == "installing")
    }
}

fn error_message(error: &str) -> String {
    let lower = error.to_ascii_lowercase();
    if lower.contains("signature") || lower.contains("digest") || lower.contains("checksum") {
        "更新文件签名校验失败，未安装。请重新下载或从发布页面获取安装包。".into()
    } else if lower.contains("404") || lower.contains("release not found") {
        "发布页面暂未提供 Tauri 更新清单，请稍后重试或查看发布页面。".into()
    } else if lower.contains("certificate") || lower.contains("tls") {
        "更新连接的证书验证失败，请检查系统时间与网络。".into()
    } else {
        "更新操作失败，请检查网络后重试，也可从发布页面手动下载。".into()
    }
}

pub async fn check(app: &tauri::AppHandle) -> Result<(), String> {
    let runtime = app.state::<Updates>();
    let development = runtime.state.lock().map_err(|_| "更新状态暂时不可用")?.mode == "development";
    let test_endpoint = if development {
        std::env::var("SHIXU_TAURI_TEST_UPDATE_URL")
            .ok()
            .and_then(|value| reqwest::Url::parse(&value).ok())
            .filter(|url| url.host_str() == Some("127.0.0.1"))
    } else {
        None
    };
    if development && test_endpoint.is_none() {
        return Ok(());
    }
    let _operation = runtime.enter()?;
    if runtime
        .state
        .lock()
        .map_err(|_| "更新状态暂时不可用")?
        .phase
        == "downloaded"
    {
        return Ok(());
    }
    runtime.change(app, |state| {
        state.phase = "checking".into();
        state.error = None;
        state.progress = None;
    })?;
    let result = async {
        let mut builder = app.updater_builder().timeout(Duration::from_secs(30));
        if let Some(endpoint) = test_endpoint {
            builder = builder
                .endpoints(vec![endpoint])
                .map_err(|e| e.to_string())?
                .no_proxy();
        }
        let updater = builder.build().map_err(|e| e.to_string())?;
        updater.check().await.map_err(|e| e.to_string())
    }
    .await;
    match result {
        Ok(update) => {
            let release = update.as_ref().map(|update| Release {
                version: update.version.clone(),
                notes: update
                    .body
                    .as_deref()
                    .unwrap_or("")
                    .chars()
                    .take(20000)
                    .collect(),
                date: update.date.map(|date| date.to_string()),
            });
            *runtime.pending.lock().map_err(|_| "更新状态暂时不可用")? = update;
            *runtime
                .downloaded
                .lock()
                .map_err(|_| "更新状态暂时不可用")? = None;
            runtime.change(app, |state| {
                state.phase = if release.is_some() {
                    "available"
                } else {
                    "current"
                }
                .into();
                state.release = release;
                state.last_checked = Some(chrono::Utc::now().to_rfc3339());
                state.error = None;
            })?;
            Ok(())
        }
        Err(error) => {
            *runtime.pending.lock().map_err(|_| "更新状态暂时不可用")? = None;
            *runtime
                .downloaded
                .lock()
                .map_err(|_| "更新状态暂时不可用")? = None;
            runtime.change(app, |state| {
                state.phase = "error".into();
                state.release = None;
                state.progress = None;
                state.error = Some(error_message(&error));
            })?;
            Err(error_message(&error))
        }
    }
}

pub async fn download(app: &tauri::AppHandle) -> Result<(), String> {
    let runtime = app.state::<Updates>();
    let _operation = runtime.enter()?;
    let phase = runtime
        .state
        .lock()
        .map_err(|_| "更新状态暂时不可用")?
        .phase
        .clone();
    if !matches!(phase.as_str(), "available" | "error") {
        return Err("当前没有可下载的更新".into());
    }
    let update = runtime
        .pending
        .lock()
        .map_err(|_| "更新状态暂时不可用")?
        .take()
        .ok_or("没有待下载的更新")?;
    let cancel = Arc::new(Notify::new());
    *runtime
        .cancellation
        .lock()
        .map_err(|_| "更新状态暂时不可用")? = Some(cancel.clone());
    runtime.change(app, |state| {
        state.phase = "downloading".into();
        state.progress = None;
        state.error = None;
    })?;
    let mut transferred = 0u64;
    let started = Instant::now();
    let result = tokio::select! {
        result = update.download(|chunk,total| {
            transferred = transferred.saturating_add(chunk as u64);
            let total = total.unwrap_or(0);
            let elapsed = started.elapsed().as_secs_f64().max(0.001);
            let progress = Progress { percent: if total > 0 { (transferred as f64 / total as f64 * 100.0).min(100.0) } else { 0.0 },
                transferred, total, bytes_per_second: transferred as f64 / elapsed };
            let _ = runtime.change(app, |state| state.progress = Some(progress));
        }, || {}) => Some(result),
        _ = cancel.notified() => None,
    };
    *runtime
        .cancellation
        .lock()
        .map_err(|_| "更新状态暂时不可用")? = None;
    *runtime.pending.lock().map_err(|_| "更新状态暂时不可用")? = Some(update);
    match result {
        Some(Ok(bytes)) => {
            *runtime
                .downloaded
                .lock()
                .map_err(|_| "更新状态暂时不可用")? = Some(bytes);
            runtime.change(app, |state| {
                state.phase = "downloaded".into();
                state.progress = None;
            })?;
            Ok(())
        }
        Some(Err(error)) => {
            let message = error_message(&error.to_string());
            runtime.change(app, |state| {
                state.phase = "error".into();
                state.progress = None;
                state.error = Some(message.clone());
            })?;
            Err(message)
        }
        None => {
            runtime.change(app, |state| {
                state.phase = "available".into();
                state.progress = None;
                state.error = None;
            })?;
            Ok(())
        }
    }
}

pub fn cancel(app: &tauri::AppHandle) -> Result<(), String> {
    let runtime = app.state::<Updates>();
    if let Some(cancel) = runtime
        .cancellation
        .lock()
        .map_err(|_| "更新状态暂时不可用")?
        .as_ref()
    {
        cancel.notify_one();
    }
    Ok(())
}

pub async fn install(app: &tauri::AppHandle, syncing: &crate::SyncTracker) -> Result<(), String> {
    let runtime = app.state::<Updates>();
    let _operation = runtime.enter()?;
    if runtime
        .state
        .lock()
        .map_err(|_| "更新状态暂时不可用")?
        .phase
        != "downloaded"
    {
        return Err("更新尚未下载完成".into());
    }
    runtime.change(app, |state| {
        state.phase = "installing".into();
        state.error = None;
    })?;
    if let Err(error) = syncing.stop_for_update().await {
        runtime.change(app, |state| {
            state.phase = "downloaded".into();
            state.error = Some(error.clone());
        })?;
        return Err(error);
    }
    let result = (|| {
        let update = runtime.pending.lock().map_err(|_| "更新状态暂时不可用")?;
        let bytes = runtime
            .downloaded
            .lock()
            .map_err(|_| "更新状态暂时不可用")?;
        let update = update.as_ref().ok_or("更新信息已失效")?;
        let bytes = bytes.as_ref().ok_or("更新文件已失效")?;
        update
            .install(bytes)
            .map_err(|e| error_message(&e.to_string()))
    })();
    if let Err(error) = result {
        runtime.change(app, |state| {
            state.phase = "downloaded".into();
            state.error = Some(error.clone());
        })?;
        return Err(error);
    }
    Ok(())
}
