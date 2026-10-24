use crate::{show_main, storage::Store};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashMap,
    sync::{
        Mutex,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};
use tauri::{
    AppHandle, Emitter, Manager, PhysicalPosition, PhysicalSize, WebviewUrl, WebviewWindowBuilder,
};
use tauri_plugin_notification::NotificationExt;
use uuid::Uuid;

pub const PREFIX: &str = "reminder-";
const LIFETIME: Duration = Duration::from_secs(10);

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventReference {
    pub resource_id: String,
    pub recurrence_id: Option<String>,
    pub start: String,
    pub all_day: bool,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Notice {
    pub key: String,
    pub title: String,
    pub body: String,
    pub event: Option<EventReference>,
    pub theme: String,
    pub test: bool,
    pub lifetime_ms: u64,
}
impl Notice {
    pub fn new(
        key: String,
        title: String,
        body: String,
        event: Option<EventReference>,
        test: bool,
    ) -> Result<Self, String> {
        if key.is_empty()
            || key.len() > 2000
            || title.trim().is_empty()
            || title.chars().count() > 500
            || body.chars().count() > 2000
        {
            return Err("提醒内容或标识无效".into());
        }
        if let Some(event) = &event {
            if event.resource_id.is_empty()
                || event.resource_id.len() > 200
                || event.start.len() > 100
                || event
                    .recurrence_id
                    .as_ref()
                    .is_some_and(|id| id.len() > 1000)
            {
                return Err("提醒日程标识无效".into());
            }
            if chrono::DateTime::parse_from_rfc3339(&event.start).is_err()
                && chrono::NaiveDate::parse_from_str(&event.start, "%Y-%m-%d").is_err()
            {
                return Err("提醒日程日期无效".into());
            }
        }
        Ok(Self {
            key,
            title,
            body,
            event,
            theme: "system".into(),
            test,
            lifetime_ms: 10000,
        })
    }
}

#[derive(Clone, Copy, Debug)]
pub struct WorkArea {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
    pub scale: f64,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Placement {
    pub x: i32,
    pub y: i32,
    pub width: u32,
    pub height: u32,
}

/// All output is physical pixels, including negative monitor origins. Only
/// dimensions/margins scale; a monitor's origin must never be divided by DPI.
pub fn stack_placements(area: WorkArea, logical_heights: &[u32]) -> Vec<Placement> {
    if area.width == 0 || area.height == 0 {
        return Vec::new();
    }
    let scale = if area.scale.is_finite() && area.scale > 0.0 {
        area.scale
    } else {
        1.0
    };
    let margin = (16.0 * scale).round() as u32;
    let mx = margin.min((area.width - 1) / 2);
    let my = margin.min((area.height - 1) / 2);
    let width = ((384.0 * scale).round() as u32)
        .min(area.width - mx * 2)
        .max(1);
    let available = area.height - 2 * my;
    let gap = (10.0 * scale).round() as u32;
    let mut offset = 0u64;
    let mut frames = Vec::new();
    for logical_height in logical_heights.iter().take(3) {
        let height = ((*logical_height as f64 * scale).round() as u32)
            .min(available)
            .max(1);
        if offset + height as u64 > available as u64 {
            break;
        }
        frames.push(Placement {
            x: (area.x as i64 + area.width as i64 - mx as i64 - width as i64) as i32,
            y: (area.y as i64 + my as i64 + offset as i64) as i32,
            width,
            height,
        });
        offset += height as u64 + gap as u64;
    }
    frames
}
#[cfg(test)]
pub fn placement(area: WorkArea, index: usize) -> Option<Placement> {
    stack_placements(area, &[166; 3]).get(index).copied()
}

#[derive(Clone)]
struct Active {
    label: String,
    notice: Notice,
    monitor: String,
    logical_height: u32,
    created: Instant,
    ready: bool,
    remaining: Duration,
    running: Option<Instant>,
    hover_beat: Instant,
    closing: Option<Instant>,
}
#[derive(Default)]
pub struct Notifications {
    active: Mutex<Vec<Active>>,
    pending_open: Mutex<Option<EventReference>>,
    pumping: AtomicBool,
}
struct PumpGuard<'a>(&'a AtomicBool);
impl Drop for PumpGuard<'_> {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release);
    }
}

fn area(monitor: &tauri::Monitor) -> WorkArea {
    let work = monitor.work_area();
    WorkArea {
        x: work.position.x,
        y: work.position.y,
        width: work.size.width,
        height: work.size.height,
        scale: monitor.scale_factor(),
    }
}
fn monitor_key(monitor: &tauri::Monitor) -> String {
    format!("{},{}", monitor.position().x, monitor.position().y)
}
fn target_monitor(app: &AppHandle) -> Result<tauri::Monitor, String> {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::{
            Foundation::RECT,
            UI::HiDpi::{DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2, SetThreadDpiAwarenessContext},
            UI::WindowsAndMessaging::{GetForegroundWindow, GetWindowRect},
        };
        let hwnd = GetForegroundWindow();
        let mut rect = RECT::default();
        let previous = SetThreadDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
        let physical_rect = GetWindowRect(hwnd, &mut rect);
        if !previous.0.is_null() {
            let _ = SetThreadDpiAwarenessContext(previous);
        }
        if physical_rect.is_ok() {
            let x = (rect.left as f64 + rect.right as f64) / 2.0;
            let y = (rect.top as f64 + rect.bottom as f64) / 2.0;
            if let Ok(Some(monitor)) = app.monitor_from_point(x, y) {
                return Ok(monitor);
            }
        }
    }
    if let Some(window) = app.get_webview_window("main") {
        if let Ok(Some(monitor)) = window.current_monitor() {
            return Ok(monitor);
        }
    }
    app.primary_monitor()
        .map_err(|_| "无法读取显示器")?
        .ok_or_else(|| "找不到可用显示器".into())
}
fn apply_placement(window: &tauri::WebviewWindow, frame: Placement) -> Result<(), String> {
    let position = PhysicalPosition::new(frame.x, frame.y);
    if window.outer_position().ok() != Some(position) {
        window.set_position(position).map_err(|_| "通知定位失败")?;
    }
    let size = PhysicalSize::new(frame.width, frame.height);
    if window.outer_size().ok() != Some(size) {
        window.set_size(size).map_err(|_| "通知尺寸设置失败")?;
    }
    Ok(())
}

fn show_without_activation(window: &tauri::WebviewWindow) -> Result<(), String> {
    #[cfg(windows)]
    unsafe {
        use windows::Win32::{
            Foundation::HWND,
            UI::WindowsAndMessaging::{SW_SHOWNOACTIVATE, ShowWindow},
        };
        let hwnd = HWND(window.hwnd().map_err(|_| "无法读取通知窗口")?.0);
        let _ = ShowWindow(hwnd, SW_SHOWNOACTIVATE);
        return Ok(());
    }
    #[cfg(not(windows))]
    window.show().map_err(|_| "无法显示提醒窗口".into())
}

pub fn enqueue(app: &AppHandle, notice: Notice) -> Result<bool, String> {
    let accepted = app
        .state::<Mutex<Store>>()
        .lock()
        .map_err(|_| "本地数据库暂时不可用")?
        .enqueue_reminder(&notice, chrono::Utc::now().timestamp_millis())?;
    if accepted {
        let _ = pump(app);
    }
    Ok(accepted)
}

pub fn pump(app: &AppHandle) -> Result<(), String> {
    let manager = app.state::<Notifications>();
    if manager
        .pumping
        .compare_exchange(false, true, Ordering::Acquire, Ordering::Relaxed)
        .is_err()
    {
        return Ok(());
    }
    let _guard = PumpGuard(&manager.pumping);
    let (pending, mode, theme) = {
        let store = app.state::<Mutex<Store>>();
        let store = store.lock().map_err(|_| "本地数据库暂时不可用")?;
        let (mode, theme) = store.reminder_preferences();
        (
            store.pending_reminders(chrono::Utc::now().timestamp_millis())?,
            mode,
            theme,
        )
    };
    for mut notice in pending {
        if manager
            .active
            .lock()
            .map_err(|_| "通知状态不可用")?
            .iter()
            .any(|active| active.notice.key == notice.key)
        {
            continue;
        }
        if !app
            .state::<Mutex<Store>>()
            .lock()
            .map_err(|_| "本地数据库暂时不可用")?
            .reminder_event_exists(&notice)
        {
            continue;
        }
        notice.theme = theme.clone();
        if mode == "system" {
            if app
                .notification()
                .builder()
                .title(&notice.title)
                .body(&notice.body)
                .extra("shixuReminderKey", &notice.key)
                .show()
                .is_ok()
            {
                app.state::<Mutex<Store>>()
                    .lock()
                    .map_err(|_| "本地数据库暂时不可用")?
                    .mark_reminder_delivered(&notice.key)?;
            }
            continue;
        }
        let monitor = target_monitor(app)?;
        let key = monitor_key(&monitor);
        let mut heights: Vec<u32> = manager
            .active
            .lock()
            .map_err(|_| "通知状态不可用")?
            .iter()
            .filter(|active| active.monitor == key)
            .map(|active| active.logical_height)
            .collect();
        let index = heights.len();
        heights.push(166);
        let Some(frame) = stack_placements(area(&monitor), &heights)
            .get(index)
            .copied()
        else {
            continue;
        };
        let label = format!("{PREFIX}{}", Uuid::new_v4());
        manager
            .active
            .lock()
            .map_err(|_| "通知状态不可用")?
            .push(Active {
                label: label.clone(),
                notice,
                monitor: key,
                logical_height: 166,
                created: Instant::now(),
                ready: false,
                remaining: LIFETIME,
                running: None,
                hover_beat: Instant::now(),
                closing: None,
            });
        let built = WebviewWindowBuilder::new(
            app,
            &label,
            WebviewUrl::App(format!("index.html?notification={label}").into()),
        )
        .title("时序日历 · 日程提醒")
        .decorations(false)
        .transparent(true)
        .shadow(false)
        .always_on_top(true)
        .skip_taskbar(true)
        .resizable(false)
        .focused(false)
        .focusable(false)
        .visible(false)
        .inner_size(384.0, 166.0)
        .build();
        match built {
            Ok(window) => {
                if apply_placement(&window, frame).is_err() {
                    let _ = window.destroy();
                    closed(app, &label);
                }
            }
            Err(_) => closed(app, &label),
        }
    }
    Ok(())
}

pub fn closed(app: &AppHandle, label: &str) {
    if !label.starts_with(PREFIX) {
        return;
    }
    if let Some(manager) = app.try_state::<Notifications>() {
        if let Ok(mut active) = manager.active.lock() {
            active.retain(|item| item.label != label);
        }
    }
}
fn destroy(app: &AppHandle, label: &str) {
    closed(app, label);
    if let Some(window) = app.get_webview_window(label) {
        let _ = window.destroy();
    }
}

pub fn maintain(app: &AppHandle) {
    let Some(manager) = app.try_state::<Notifications>() else {
        return;
    };
    let theme = app
        .state::<Mutex<Store>>()
        .lock()
        .map(|store| store.reminder_preferences().1)
        .unwrap_or_else(|_| "system".into());
    let snapshot = manager
        .active
        .lock()
        .map(|items| items.clone())
        .unwrap_or_default();
    let mut invalid = Vec::new();
    for item in &snapshot {
        let exists = app
            .state::<Mutex<Store>>()
            .lock()
            .map(|store| store.reminder_event_exists(&item.notice))
            .unwrap_or(true);
        if !exists || app.get_webview_window(&item.label).is_none() {
            invalid.push(item.label.clone());
        }
    }
    let mut destroy_labels = invalid;
    let mut exits = Vec::new();
    let mut themes = Vec::new();
    if let Ok(mut active) = manager.active.lock() {
        for item in active.iter_mut() {
            if !item.ready && item.created.elapsed() > Duration::from_secs(20) {
                destroy_labels.push(item.label.clone());
                continue;
            }
            if let Some(closing) = item.closing {
                if closing.elapsed() > Duration::from_secs(1) {
                    destroy_labels.push(item.label.clone());
                }
                continue;
            }
            if item.ready
                && item.running.is_none()
                && item.hover_beat.elapsed() > Duration::from_secs(15)
            {
                item.running = Some(Instant::now());
            }
            if item.ready
                && item
                    .running
                    .is_some_and(|start| start.elapsed() >= item.remaining)
            {
                item.closing = Some(Instant::now());
                exits.push(item.label.clone());
            }
            if item.notice.theme != theme {
                item.notice.theme = theme.clone();
                themes.push(item.label.clone());
            }
        }
    }
    // Never hold the state mutex across a native window call: Destroyed can
    // arrive on the UI thread while a worker waits for set_position/show.
    for label in exits {
        let _ = app.emit_to(&label, "shixu:notification-exit", ());
    }
    for label in themes {
        let _ = app.emit_to(&label, "shixu:notification-theme", &theme);
    }
    for label in destroy_labels {
        destroy(app, &label);
    }
    reflow(app);
    let _ = pump(app);
}

fn reflow(app: &AppHandle) {
    let manager = app.state::<Notifications>();
    if let (Ok(monitors), Ok(fallback)) = (app.available_monitors(), target_monitor(app)) {
        let mut groups = HashMap::<String, Vec<u32>>::new();
        let mut moves = Vec::new();
        let mut overflow = Vec::new();
        if let Ok(mut active) = manager.active.lock() {
            for item in active.iter_mut() {
                let monitor = monitors
                    .iter()
                    .find(|monitor| monitor_key(monitor) == item.monitor)
                    .unwrap_or(&fallback);
                item.monitor = monitor_key(monitor);
                let heights = groups.entry(item.monitor.clone()).or_default();
                heights.push(item.logical_height);
                if let Some(frame) = stack_placements(area(monitor), heights)
                    .get(heights.len() - 1)
                    .copied()
                {
                    moves.push((item.label.clone(), frame));
                } else {
                    overflow.push(item.label.clone());
                }
            }
        }
        for (label, frame) in moves {
            if let Some(window) = app.get_webview_window(&label) {
                let _ = apply_placement(&window, frame);
            }
        }
        for label in overflow {
            destroy(app, &label);
        }
    }
}

fn open_notice(app: &AppHandle, notice: &Notice) -> Result<(), String> {
    if !app
        .state::<Mutex<Store>>()
        .lock()
        .map_err(|_| "本地数据库暂时不可用")?
        .reminder_event_exists(notice)
    {
        return Err("对应日程已删除".into());
    }
    *app.state::<Notifications>()
        .pending_open
        .lock()
        .map_err(|_| "提醒操作不可用")? = notice.event.clone();
    show_main(app);
    let _ = app.emit_to("main", "shixu:open-reminder", ());
    Ok(())
}
pub fn native_clicked(app: &AppHandle, key: Option<&str>) {
    let notice = key.and_then(|key| {
        app.state::<Mutex<Store>>()
            .lock()
            .ok()?
            .delivered_reminder(key)
            .ok()
            .flatten()
    });
    if let Some(notice) = notice {
        if open_notice(app, &notice).is_err() {
            show_main(app);
        }
    } else {
        show_main(app);
    }
}
pub fn take_open(app: &AppHandle) -> Result<Option<EventReference>, String> {
    Ok(app
        .state::<Notifications>()
        .pending_open
        .lock()
        .map_err(|_| "提醒操作不可用")?
        .take())
}

#[tauri::command]
pub async fn notification_call(
    window: tauri::WebviewWindow,
    app: AppHandle,
    method: String,
    paused: Option<bool>,
    height: Option<u32>,
) -> Result<Value, String> {
    let label = window.label();
    if !label.starts_with(PREFIX) {
        return Err("通知窗口权限不足".into());
    }
    let notice = app
        .state::<Notifications>()
        .active
        .lock()
        .map_err(|_| "通知状态不可用")?
        .iter()
        .find(|active| active.label == label)
        .map(|active| active.notice.clone())
        .ok_or("通知已关闭")?;
    match method.as_str() {
        "ready" => Ok(serde_json::to_value(&notice).map_err(|_| "提醒内容无效")?),
        "resize" => {
            let height = height
                .filter(|height| (80..=260).contains(height))
                .ok_or("通知高度无效")?;
            {
                let manager = app.state::<Notifications>();
                let mut active = manager.active.lock().map_err(|_| "通知状态不可用")?;
                let item = active
                    .iter_mut()
                    .find(|item| item.label == label)
                    .ok_or("通知已关闭")?;
                item.logical_height = height;
            }
            reflow(&app);
            Ok(Value::Null)
        }
        "present" => {
            let manager = app.state::<Notifications>();
            let first = {
                let mut active = manager.active.lock().map_err(|_| "通知状态不可用")?;
                let item = active
                    .iter_mut()
                    .find(|item| item.label == label)
                    .ok_or("通知已关闭")?;
                let first = !item.ready;
                if first {
                    item.ready = true;
                    item.running = Some(Instant::now());
                }
                first
            };
            if first {
                let shown = show_without_activation(&window).and_then(|_| {
                    app.state::<Mutex<Store>>()
                        .lock()
                        .map_err(|_| "本地数据库暂时不可用".to_string())?
                        .mark_reminder_delivered(&notice.key)
                });
                if let Err(error) = shown {
                    let _ = window.hide();
                    if let Ok(mut active) = manager.active.lock() {
                        if let Some(item) = active.iter_mut().find(|item| item.label == label) {
                            item.ready = false;
                            item.running = None;
                        }
                    }
                    return Err(error);
                }
            }
            Ok(serde_json::to_value(&notice).map_err(|_| "提醒内容无效")?)
        }
        "hover" => {
            let manager = app.state::<Notifications>();
            let mut active = manager.active.lock().map_err(|_| "通知状态不可用")?;
            let item = active
                .iter_mut()
                .find(|item| item.label == label)
                .ok_or("通知已关闭")?;
            if paused.unwrap_or(false) {
                if let Some(start) = item.running.take() {
                    item.remaining = item.remaining.saturating_sub(start.elapsed());
                }
                item.hover_beat = Instant::now();
            } else if item.running.is_none() && item.closing.is_none() {
                item.running = Some(Instant::now());
            }
            Ok(Value::Null)
        }
        "dismiss" => {
            destroy(&app, label);
            Ok(Value::Null)
        }
        "open" => {
            open_notice(&app, &notice)?;
            destroy(&app, label);
            Ok(Value::Null)
        }
        "snooze" => {
            if app.state::<crate::updates::Updates>().is_installing() {
                return Err("更新正在安装，请稍后再试".into());
            }
            let mut next = notice.clone();
            next.key = format!("snooze:{}", Uuid::new_v4());
            app.state::<Mutex<Store>>()
                .lock()
                .map_err(|_| "本地数据库暂时不可用")?
                .enqueue_reminder(
                    &next,
                    chrono::Utc::now().timestamp_millis() + 10 * 60 * 1000,
                )?;
            destroy(&app, label);
            Ok(Value::Null)
        }
        _ => Err("未知通知操作".into()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn physical_work_areas_and_dpi_keep_stacks_within_bounds() {
        for scale in [1.0, 1.25, 1.5, 2.0] {
            for (x, y, width, height) in [
                (0, 40, 1920, 1000),
                (-1920, 0, 1920, 1040),
                (1920, -1080, 2560, 1400),
            ] {
                let area = WorkArea {
                    x,
                    y,
                    width,
                    height,
                    scale,
                };
                let mut bottom = y;
                for index in 0..3 {
                    if let Some(frame) = placement(area, index) {
                        assert!(frame.x >= x && frame.y >= bottom);
                        assert!(frame.x as i64 + frame.width as i64 <= x as i64 + width as i64);
                        assert!(frame.y as i64 + frame.height as i64 <= y as i64 + height as i64);
                        assert_eq!(frame.width, (384.0 * scale).round() as u32);
                        bottom = frame.y + frame.height as i32;
                    }
                }
                assert!(placement(area, 3).is_none());
            }
        }
    }
    #[test]
    fn measured_content_heights_reflow_without_fixed_blank_slots() {
        let frames = stack_placements(
            WorkArea {
                x: -1920,
                y: 40,
                width: 1920,
                height: 1032,
                scale: 2.0,
            },
            &[110, 150, 120],
        );
        assert_eq!(frames.len(), 3);
        assert_eq!(
            frames.iter().map(|frame| frame.y).collect::<Vec<_>>(),
            vec![72, 312, 632]
        );
        assert_eq!(
            frames.iter().map(|frame| frame.height).collect::<Vec<_>>(),
            vec![220, 300, 240]
        );
    }
    #[test]
    fn short_cards_can_use_space_that_tall_cards_cannot() {
        let area = WorkArea {
            x: 0,
            y: 0,
            width: 800,
            height: 500,
            scale: 1.0,
        };
        assert_eq!(stack_placements(area, &[110, 210, 110]).len(), 3);
        assert_eq!(stack_placements(area, &[200, 200, 200]).len(), 2);
    }
    #[test]
    fn high_dpi_does_not_scale_monitor_origin() {
        let frame = placement(
            WorkArea {
                x: -1920,
                y: 40,
                width: 1920,
                height: 1000,
                scale: 2.0,
            },
            0,
        )
        .unwrap();
        assert_eq!(frame.x, -800);
        assert_eq!(frame.y, 72);
        assert_eq!(frame.height, 332);
    }
    #[test]
    fn small_work_area_clamps_card_and_reduces_capacity() {
        let area = WorkArea {
            x: -500,
            y: -200,
            width: 200,
            height: 100,
            scale: 2.0,
        };
        let frame = placement(area, 0).unwrap();
        assert!(frame.width <= area.width && frame.height <= area.height);
        assert!(placement(area, 1).is_none());
        assert!(placement(WorkArea { width: 0, ..area }, 0).is_none());
        assert!(
            placement(
                WorkArea {
                    scale: f64::NAN,
                    ..area
                },
                0
            )
            .is_some()
        );
    }
    #[test]
    fn notification_payload_is_bounded_and_date_validated() {
        assert!(Notice::new("".into(), "test".into(), "".into(), None, false).is_err());
        assert!(Notice::new("a".into(), "中".repeat(500), "".into(), None, false).is_ok());
        assert!(Notice::new("a".into(), "中".repeat(501), "".into(), None, false).is_err());
        assert!(
            Notice::new(
                "a".into(),
                "test".into(),
                "".into(),
                Some(EventReference {
                    resource_id: "r".into(),
                    recurrence_id: None,
                    start: "invalid".into(),
                    all_day: false
                }),
                false
            )
            .is_err()
        );
    }
    #[test]
    fn native_plugin_click_retains_the_delivery_key() {
        let action: tauri_plugin_notification::ActionPerformed = serde_json::from_value(serde_json::json!({
            "actionId":"tap","inputValue":null,
            "notification":{"id":42,"title":"日程提醒","body":"10:00","extra":{"shixuReminderKey":"reminder:key"}}
        })).unwrap();
        assert_eq!(action.action_id(), "tap");
        assert_eq!(
            action.notification().unwrap().extra()["shixuReminderKey"],
            "reminder:key"
        );
    }
}
