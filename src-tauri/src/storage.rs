use crate::dav::{AccountInput, Calendar, Pull};
use rusqlite::{Connection, OpenFlags, OptionalExtension, backup::Backup};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{collections::HashSet, path::Path};
use uuid::Uuid;

const SCHEMA_VERSION: i64 = 1;

pub struct Store {
    db: Connection,
}

pub struct StoredAccount {
    pub id: String,
    pub url: String,
    pub username: String,
    pub password: String,
    pub allow_http: bool,
    pub paused: bool,
}

struct LocalResource {
    id: String,
    ics: String,
    etag: Option<String>,
    dirty: bool,
}

pub struct PendingOperation {
    pub id: String,
    pub resource_id: String,
    pub url: String,
    pub ics: String,
    pub kind: String,
    pub base_etag: Option<String>,
    pub version: i64,
}

#[derive(Debug, PartialEq, Eq)]
pub struct Inventory {
    pub accounts: i64,
    pub calendars: i64,
    pub resources: i64,
    pub pending: i64,
    pub conflicts: i64,
    pub ics_bytes: i64,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Settings {
    theme: String,
    view: String,
    first_day: i64,
    duration: i64,
    reminder: i64,
    timezone: String,
    auto_sync: bool,
    interval: i64,
    default_calendar: String,
    time_format: String,
    date_format: String,
    auto_update_check: bool,
    close_to_tray: bool,
    #[serde(default)]
    bold_text: bool,
}

impl Settings {
    fn validate(&self) -> Result<(), String> {
        if !matches!(self.theme.as_str(), "system" | "light" | "dark")
            || !matches!(
                self.view.as_str(),
                "dayGridMonth" | "timeGridWeek" | "timeGridDay" | "listMonth"
            )
            || !(0..=6).contains(&self.first_day)
            || !(5..=1440).contains(&self.duration)
            || !(-1..=10080).contains(&self.reminder)
            || self.timezone.len() > 100
            || self.timezone.parse::<chrono_tz::Tz>().is_err()
            || !(1..=1440).contains(&self.interval)
            || self.default_calendar.len() > 200
            || !matches!(self.time_format.as_str(), "24" | "12")
            || !matches!(self.date_format.as_str(), "numeric" | "chinese")
        {
            return Err("日历设置无效".into());
        }
        Ok(())
    }
}

impl Store {
    pub fn open(path: &Path) -> rusqlite::Result<Self> {
        let db = Connection::open(path)?;
        db.execute_batch(
            "PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;",
        )?;
        let mut store = Self { db };
        store.migrate()?;
        store.db.execute_batch("CREATE TABLE IF NOT EXISTS ics_subscriptions(accountId TEXT PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE)")?;
        Ok(store)
    }

    fn migrate(&mut self) -> rusqlite::Result<()> {
        let version: i64 = self
            .db
            .query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version > SCHEMA_VERSION {
            return Err(rusqlite::Error::InvalidQuery);
        }
        if version == 0 {
            let tx = self.db.transaction()?;
            tx.execute_batch(
                "CREATE TABLE accounts(id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, username TEXT NOT NULL, password TEXT NOT NULL, allowHttp INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0, lastSync TEXT, error TEXT);
                 CREATE TABLE calendars(id TEXT PRIMARY KEY, accountId TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, url TEXT NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL, visible INTEGER NOT NULL DEFAULT 1, readOnly INTEGER NOT NULL DEFAULT 0, UNIQUE(accountId,url));
                 CREATE TABLE event_resources(id TEXT PRIMARY KEY, calendarId TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE, url TEXT NOT NULL, etag TEXT, ics TEXT NOT NULL, dirty INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, UNIQUE(calendarId,url));
                 CREATE TABLE pending_operations(id TEXT PRIMARY KEY, resourceId TEXT NOT NULL UNIQUE REFERENCES event_resources(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('put','delete')), baseEtag TEXT, version INTEGER NOT NULL DEFAULT 1, attempts INTEGER NOT NULL DEFAULT 0, error TEXT);
                 CREATE TABLE sync_state(calendarId TEXT PRIMARY KEY REFERENCES calendars(id) ON DELETE CASCADE, token TEXT, lastSync TEXT);
                 CREATE TABLE conflicts(id TEXT PRIMARY KEY, resourceId TEXT NOT NULL UNIQUE REFERENCES event_resources(id) ON DELETE CASCADE, localIcs TEXT NOT NULL, remoteIcs TEXT, remoteEtag TEXT, createdAt TEXT NOT NULL);
                 CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
                 CREATE TABLE reminders(key TEXT PRIMARY KEY, shownAt TEXT NOT NULL);
                 CREATE INDEX resources_calendar ON event_resources(calendarId);
                 PRAGMA user_version=1;",
            )?;
            tx.commit()?;
        }
        Ok(())
    }

    pub fn inventory(&self) -> rusqlite::Result<Inventory> {
        self.db.query_row(
            "SELECT (SELECT COUNT(*) FROM accounts),
                    (SELECT COUNT(*) FROM calendars),
                    (SELECT COUNT(*) FROM event_resources),
                    (SELECT COUNT(*) FROM pending_operations),
                    (SELECT COUNT(*) FROM conflicts),
                    (SELECT COALESCE(SUM(length(ics)), 0) FROM event_resources)",
            [],
            |row| {
                Ok(Inventory {
                    accounts: row.get(0)?,
                    calendars: row.get(1)?,
                    resources: row.get(2)?,
                    pending: row.get(3)?,
                    conflicts: row.get(4)?,
                    ics_bytes: row.get(5)?,
                })
            },
        )
    }

    pub fn snapshot(&self, defaults: Value) -> rusqlite::Result<Value> {
        let accounts = self.db.prepare("SELECT id,name,url,username,allowHttp,paused,lastSync,error,EXISTS(SELECT 1 FROM ics_subscriptions s WHERE s.accountId=accounts.id) FROM accounts")?
            .query_map([], |row| Ok(json!({
                "id": row.get::<_, String>(0)?, "name": row.get::<_, String>(1)?,
                "url": row.get::<_, String>(2)?, "username": row.get::<_, String>(3)?,
                "allowHttp": row.get::<_, bool>(4)?, "paused": row.get::<_, bool>(5)?,
                "lastSync": row.get::<_, Option<String>>(6)?, "error": row.get::<_, Option<String>>(7)?, "subscription": row.get::<_, bool>(8)?
            })))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let calendars = self
            .db
            .prepare("SELECT id,accountId,url,name,color,visible,readOnly FROM calendars")?
            .query_map([], |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?, "accountId": row.get::<_, String>(1)?,
                    "url": row.get::<_, String>(2)?, "name": row.get::<_, String>(3)?,
                    "color": row.get::<_, String>(4)?, "visible": row.get::<_, bool>(5)?,
                    "readOnly": row.get::<_, bool>(6)?
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let conflicts = self.db.prepare("SELECT id,resourceId,localIcs,remoteIcs,remoteEtag,createdAt FROM conflicts ORDER BY createdAt")?
            .query_map([], |row| Ok(json!({
                "id": row.get::<_, String>(0)?, "resourceId": row.get::<_, String>(1)?,
                "localIcs": row.get::<_, String>(2)?, "remoteIcs": row.get::<_, Option<String>>(3)?,
                "remoteEtag": row.get::<_, Option<String>>(4)?, "createdAt": row.get::<_, String>(5)?
            })))?.collect::<rusqlite::Result<Vec<_>>>()?;
        let saved: Option<String> = self
            .db
            .query_row(
                "SELECT value FROM settings WHERE key='preferences'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        let mut settings = defaults;
        if let (Some(target), Some(raw)) = (settings.as_object_mut(), saved) {
            let parsed: Value =
                serde_json::from_str(&raw).map_err(|_| rusqlite::Error::InvalidQuery)?;
            let saved = parsed.as_object().ok_or(rusqlite::Error::InvalidQuery)?;
            target.extend(saved.clone());
        }
        let count = self.inventory()?;
        Ok(json!({
            "accounts": accounts, "calendars": calendars, "settings": settings,
            "pending": count.pending, "conflicts": conflicts, "syncing": [],
            "bytes": count.ics_bytes, "resources": count.resources, "diagnostics": []
        }))
    }

    pub fn set_settings(&self, raw: Value) -> Result<(), String> {
        let settings: Settings = serde_json::from_value(raw).map_err(|_| "日历设置无效")?;
        settings.validate()?;
        if !settings.default_calendar.is_empty() {
            let writable: Option<i64> = self
                .db
                .query_row(
                    "SELECT 1 FROM calendars WHERE id=? AND readOnly=0",
                    [&settings.default_calendar],
                    |row| row.get(0),
                )
                .optional()
                .map_err(|_| "读取默认日历失败")?;
            if writable.is_none() {
                return Err("默认日历不存在或为只读".into());
            }
        }
        let value = serde_json::to_string(&settings).map_err(|_| "日历设置无效")?;
        self.db.execute(
            "INSERT INTO settings(key,value) VALUES('preferences',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [&value],
        ).map_err(|_| "保存日历设置失败")?;
        Ok(())
    }

    pub fn is_subscription(&self, id: &str) -> Result<bool, String> {
        self.db
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM ics_subscriptions WHERE accountId=?)",
                [id],
                |row| row.get(0),
            )
            .map_err(|_| "读取订阅日历失败".into())
    }

    pub fn import_feed(
        &mut self,
        input: &crate::feeds::FeedInput,
        ics: &str,
    ) -> Result<String, String> {
        let existing: Option<String> = self.db.query_row("SELECT a.id FROM accounts a JOIN ics_subscriptions s ON s.accountId=a.id WHERE a.url=?", [&input.url], |r| r.get(0)).optional().map_err(|_| "读取订阅日历失败")?;
        if existing.is_some() {
            return Err("这个 ICS 日历已经导入，可点击同步刷新".into());
        }
        let id = Uuid::new_v4().to_string();
        let calendar = Uuid::new_v4().to_string();
        let tx = self.db.transaction().map_err(|_| "无法开始导入日历")?;
        tx.execute("INSERT INTO accounts(id,name,url,username,password,allowHttp,lastSync) VALUES(?,?,?,'ICS 订阅','',?,?)", rusqlite::params![id,input.name,input.url,input.allow_http,chrono::Utc::now().to_rfc3339()]).map_err(|_| "保存订阅失败")?;
        tx.execute("INSERT INTO ics_subscriptions(accountId) VALUES(?)", [&id])
            .map_err(|_| "保存订阅类型失败")?;
        tx.execute("INSERT INTO calendars(id,accountId,url,name,color,readOnly) VALUES(?,?,?,?,'#497bba',1)",rusqlite::params![calendar,id,input.url,input.name]).map_err(|_| "保存订阅日历失败")?;
        tx.execute(
            "INSERT INTO event_resources(id,calendarId,url,ics) VALUES(?,?,?,?)",
            rusqlite::params![Uuid::new_v4().to_string(), calendar, input.url, ics],
        )
        .map_err(|_| "保存订阅日程失败")?;
        tx.commit().map_err(|_| "提交日历导入失败")?;
        Ok(id)
    }

    pub fn refresh_feed(&mut self, id: &str, url: &str, ics: &str) -> Result<(), String> {
        let tx = self.db.transaction().map_err(|_| "无法开始订阅同步")?;
        let calendar: String = tx.query_row("SELECT c.id FROM calendars c JOIN ics_subscriptions s ON s.accountId=c.accountId WHERE s.accountId=?", [id], |r| r.get(0)).map_err(|_| "订阅日历已被移除")?;
        tx.execute("INSERT INTO event_resources(id,calendarId,url,ics) VALUES(?,?,?,?) ON CONFLICT(calendarId,url) DO UPDATE SET ics=excluded.ics",rusqlite::params![Uuid::new_v4().to_string(),calendar,url,ics]).map_err(|_| "更新订阅日程失败")?;
        tx.execute(
            "UPDATE accounts SET lastSync=?,error=NULL WHERE id=?",
            rusqlite::params![chrono::Utc::now().to_rfc3339(), id],
        )
        .map_err(|_| "更新订阅状态失败")?;
        tx.commit().map_err(|_| "提交订阅同步失败".into())
    }

    pub fn close_to_tray(&self) -> bool {
        let saved: rusqlite::Result<Option<String>> = self
            .db
            .query_row(
                "SELECT value FROM settings WHERE key='preferences'",
                [],
                |row| row.get(0),
            )
            .optional();
        saved
            .ok()
            .flatten()
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|value| value.get("closeToTray").and_then(Value::as_bool))
            .unwrap_or(true)
    }

    pub fn auto_sync_interval(&self) -> Option<u64> {
        let saved: Option<String> = self
            .db
            .query_row(
                "SELECT value FROM settings WHERE key='preferences'",
                [],
                |row| row.get(0),
            )
            .optional()
            .ok()
            .flatten();
        let settings = saved.and_then(|raw| serde_json::from_str::<Value>(&raw).ok());
        if settings
            .as_ref()
            .and_then(|value| value.get("autoSync").and_then(Value::as_bool))
            == Some(false)
        {
            return None;
        }
        Some(
            settings
                .as_ref()
                .and_then(|value| value.get("interval").and_then(Value::as_u64))
                .filter(|minutes| (1..=1440).contains(minutes))
                .unwrap_or(10),
        )
    }

    pub fn auto_update_check(&self) -> bool {
        let saved: Option<String> = self
            .db
            .query_row(
                "SELECT value FROM settings WHERE key='preferences'",
                [],
                |row| row.get(0),
            )
            .optional()
            .ok()
            .flatten();
        saved
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .and_then(|value| value.get("autoUpdateCheck").and_then(Value::as_bool))
            .unwrap_or(true)
    }

    pub fn restore_settings(&self, mut raw: Value) -> Result<(), String> {
        let default = raw
            .get("defaultCalendar")
            .and_then(Value::as_str)
            .ok_or("备份偏好无效")?;
        if !default.is_empty() {
            let found: Option<i64> = self
                .db
                .query_row("SELECT 1 FROM calendars WHERE id=?", [default], |row| {
                    row.get(0)
                })
                .optional()
                .map_err(|_| "读取默认日历失败")?;
            if found.is_none() {
                raw["defaultCalendar"] = json!("");
            }
        }
        self.set_settings(raw)
    }

    pub fn event_resources(&self, defaults: Value) -> rusqlite::Result<Value> {
        self.resources_for_worker(defaults, false)
    }

    pub fn reminder_resources(&self, defaults: Value) -> rusqlite::Result<Value> {
        self.resources_for_worker(defaults, true)
    }

    fn resources_for_worker(
        &self,
        defaults: Value,
        include_hidden: bool,
    ) -> rusqlite::Result<Value> {
        let snapshot = self.snapshot(defaults)?;
        let sql = if include_hidden {
            "SELECT id,calendarId,url,etag,ics,dirty,deleted FROM event_resources"
        } else {
            "SELECT r.id,r.calendarId,r.url,r.etag,r.ics,r.dirty,r.deleted
             FROM event_resources r JOIN calendars c ON c.id=r.calendarId WHERE c.visible=1"
        };
        let resources = self
            .db
            .prepare(sql)?
            .query_map([], |row| {
                Ok(json!({
                    "id": row.get::<_, String>(0)?, "calendarId": row.get::<_, String>(1)?,
                    "url": row.get::<_, String>(2)?, "etag": row.get::<_, Option<String>>(3)?,
                    "ics": row.get::<_, String>(4)?, "dirty": row.get::<_, i64>(5)?,
                    "deleted": row.get::<_, i64>(6)?
                }))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        let visible: Vec<Value> = snapshot["calendars"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|c| include_hidden || c["visible"] == true)
            .map(|c| c["id"].clone())
            .collect();
        let conflicts: Vec<Value> = snapshot["conflicts"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| c["resourceId"].clone())
            .collect();
        Ok(json!({
            "resources": resources, "visibleCalendars": visible,
            "conflictResources": conflicts, "timezone": snapshot["settings"]["timezone"]
        }))
    }

    pub fn claim_reminder(&self, key: &str) -> Result<bool, String> {
        if key.is_empty() || key.len() > 2000 {
            return Err("提醒标识无效".into());
        }
        self.db
            .execute(
                "DELETE FROM reminders WHERE datetime(shownAt) < datetime('now','-30 days')",
                [],
            )
            .map_err(|_| "清理提醒记录失败")?;
        let changed = self
            .db
            .execute(
                "INSERT OR IGNORE INTO reminders(key,shownAt) VALUES(?,?)",
                rusqlite::params![key, chrono::Utc::now().to_rfc3339()],
            )
            .map_err(|_| "保存提醒记录失败")?;
        Ok(changed == 1)
    }

    pub fn release_reminder(&self, key: &str) {
        let _ = self.db.execute("DELETE FROM reminders WHERE key=?", [key]);
    }

    pub fn event_resource(&self, id: &str) -> Result<Value, String> {
        self.db.query_row("SELECT id,calendarId,url,etag,ics,dirty,deleted FROM event_resources WHERE id=?", [id], |row| Ok(json!({
            "id": row.get::<_, String>(0)?, "calendarId": row.get::<_, String>(1)?,
            "url": row.get::<_, String>(2)?, "etag": row.get::<_, Option<String>>(3)?,
            "ics": row.get::<_, String>(4)?, "dirty": row.get::<_, i64>(5)?, "deleted": row.get::<_, i64>(6)?
        }))).optional().map_err(|_| "读取日程失败".to_owned())?.ok_or("日程已移除，请刷新".into())
    }

    pub fn queue_event(
        &mut self,
        calendar_id: &str,
        resource_id: Option<&str>,
        expected_ics: Option<&str>,
        ics: &str,
        delete: bool,
    ) -> Result<(), String> {
        if calendar_id.is_empty()
            || calendar_id.len() > 200
            || ics.len() > 32 * 1024 * 1024
            || !ics.starts_with("BEGIN:VCALENDAR")
        {
            return Err("日程参数无效".into());
        }
        let tx = self.db.transaction().map_err(|_| "无法开始日程保存事务")?;
        let calendar: Option<(String, bool)> = tx
            .query_row(
                "SELECT url,readOnly FROM calendars WHERE id=?",
                [calendar_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()
            .map_err(|_| "读取日历失败")?;
        let (calendar_url, read_only) = calendar.ok_or("请选择有效日历")?;
        if read_only {
            return Err("此日历为只读，无法修改".into());
        }
        let (id, url, etag, old_ics) = if let Some(id) = resource_id {
            let existing: Option<(String, String, Option<String>, String, bool)> = tx
                .query_row(
                    "SELECT calendarId,url,etag,ics,deleted FROM event_resources WHERE id=?",
                    [id],
                    |row| {
                        Ok((
                            row.get(0)?,
                            row.get(1)?,
                            row.get(2)?,
                            row.get(3)?,
                            row.get(4)?,
                        ))
                    },
                )
                .optional()
                .map_err(|_| "读取原日程失败")?;
            let (existing_calendar, url, etag, old, deleted) =
                existing.ok_or("日程已移除，请刷新")?;
            if existing_calendar != calendar_id {
                return Err("现有日程暂不支持跨日历移动，请新建副本".into());
            }
            if deleted {
                return Err("此日程已标记删除，请先同步或处理冲突".into());
            }
            if expected_ics != Some(old.as_str()) {
                return Err("日程已在后台更新，请刷新后重试".into());
            }
            (id.to_owned(), url, etag, old)
        } else {
            if delete {
                return Err("找不到此日程".into());
            }
            let id = Uuid::new_v4().to_string();
            let url = format!("{}/{}.ics", calendar_url.trim_end_matches('/'), id);
            (id, url, None, String::new())
        };
        tx.execute("INSERT INTO event_resources(id,calendarId,url,etag,ics,dirty,deleted) VALUES(?,?,?,?,?,1,?)
            ON CONFLICT(id) DO UPDATE SET ics=excluded.ics,dirty=1,deleted=excluded.deleted",
            rusqlite::params![id, calendar_id, url, etag, if delete { old_ics.as_str() } else { ics }, delete])
            .map_err(|_| "保存本地日程失败")?;
        tx.execute(
            "INSERT INTO pending_operations(id,resourceId,kind,baseEtag) VALUES(?,?,?,?)
            ON CONFLICT(resourceId) DO UPDATE SET kind=excluded.kind,version=version+1,error=NULL",
            rusqlite::params![
                Uuid::new_v4().to_string(),
                id,
                if delete { "delete" } else { "put" },
                etag
            ],
        )
        .map_err(|_| "加入离线同步队列失败")?;
        tx.execute(
            "UPDATE conflicts SET localIcs=? WHERE resourceId=?",
            rusqlite::params![if delete { old_ics.as_str() } else { ics }, id],
        )
        .map_err(|_| "更新冲突本地版本失败")?;
        tx.commit().map_err(|_| "提交日程保存事务失败".into())
    }

    pub fn delete_account(&mut self, id: &str) -> Result<(), String> {
        let tx = self.db.transaction().map_err(|_| "无法开始账户删除事务")?;
        let changed = tx
            .execute("DELETE FROM accounts WHERE id=?", [id])
            .map_err(|_| "删除账户失败")?;
        if changed == 0 {
            return Err("账户不存在".into());
        }
        let saved: Option<String> = tx
            .query_row(
                "SELECT value FROM settings WHERE key='preferences'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "读取偏好失败")?;
        if let Some(saved) = saved {
            let mut settings: Value = serde_json::from_str(&saved).map_err(|_| "已保存偏好无效")?;
            if let Some(default_id) = settings
                .get("defaultCalendar")
                .and_then(Value::as_str)
                .map(str::to_owned)
            {
                if !default_id.is_empty() {
                    let exists: Option<i64> = tx
                        .query_row("SELECT 1 FROM calendars WHERE id=?", [&default_id], |row| {
                            row.get(0)
                        })
                        .optional()
                        .map_err(|_| "读取默认日历失败")?;
                    if exists.is_none() {
                        settings["defaultCalendar"] = json!("");
                        tx.execute(
                            "UPDATE settings SET value=? WHERE key='preferences'",
                            [settings.to_string()],
                        )
                        .map_err(|_| "更新默认日历失败")?;
                    }
                }
            }
        }
        tx.commit().map_err(|_| "提交账户删除事务失败".into())
    }

    pub fn clear_cache(&mut self) -> Result<(), String> {
        let tx = self.db.transaction().map_err(|_| "无法开始缓存清理事务")?;
        tx.execute_batch("DELETE FROM event_resources WHERE dirty=0 AND id NOT IN (SELECT resourceId FROM conflicts);
            DELETE FROM sync_state; DELETE FROM reminders;")
            .map_err(|_| "清除缓存失败")?;
        tx.commit().map_err(|_| "提交缓存清理事务失败".into())
    }

    pub fn resolve_conflict(
        &mut self,
        id: &str,
        choice: &str,
        copy_ics: Option<&str>,
    ) -> Result<(), String> {
        if !matches!(choice, "local" | "remote" | "both") {
            return Err("冲突处理选项无效".into());
        }
        let tx = self.db.transaction().map_err(|_| "无法开始冲突处理事务")?;
        let conflict: Option<(String, String, Option<String>, Option<String>)> = tx
            .query_row(
                "SELECT resourceId,localIcs,remoteIcs,remoteEtag FROM conflicts WHERE id=?",
                [id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()
            .map_err(|_| "读取冲突失败")?;
        let (resource_id, local_ics, remote_ics, remote_etag) = conflict.ok_or("冲突已处理")?;
        let resource: (String, String) = tx
            .query_row(
                "SELECT calendarId,url FROM event_resources WHERE id=?",
                [&resource_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .map_err(|_| "冲突资源不存在")?;
        let kind: Option<String> = tx
            .query_row(
                "SELECT kind FROM pending_operations WHERE resourceId=?",
                [&resource_id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "读取待提交操作失败")?;
        if choice == "both" {
            let ics = copy_ics.ok_or("缺少本地副本")?;
            if ics.len() > 32 * 1024 * 1024
                || !ics.starts_with("BEGIN:VCALENDAR")
                || ics == local_ics
            {
                return Err("本地副本无效".into());
            }
            let calendar: (String, bool) = tx
                .query_row(
                    "SELECT url,readOnly FROM calendars WHERE id=?",
                    [&resource.0],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .map_err(|_| "日历不存在")?;
            if calendar.1 {
                return Err("日历当前为只读，无法保留本地副本".into());
            }
            let new_id = Uuid::new_v4().to_string();
            let url = format!("{}/{}.ics", calendar.0.trim_end_matches('/'), new_id);
            tx.execute("INSERT INTO event_resources(id,calendarId,url,etag,ics,dirty,deleted) VALUES(?,?,?,NULL,?,1,0)",
                rusqlite::params![new_id,resource.0,url,ics]).map_err(|_| "保存本地副本失败")?;
            tx.execute("INSERT INTO pending_operations(id,resourceId,kind,baseEtag) VALUES(?,?,'put',NULL)",
                rusqlite::params![Uuid::new_v4().to_string(),new_id]).map_err(|_| "加入副本同步队列失败")?;
        }
        if choice == "local" && remote_ics.is_some() && remote_etag.is_none() {
            return Err("服务器未提供 ETag，无法安全覆盖；请选择保留双方或使用服务器版本".into());
        }
        tx.execute("DELETE FROM conflicts WHERE id=?", [id])
            .map_err(|_| "移除冲突失败")?;
        tx.execute(
            "DELETE FROM pending_operations WHERE resourceId=?",
            [&resource_id],
        )
        .map_err(|_| "清除旧待提交操作失败")?;
        if choice == "local" {
            if kind.as_deref() == Some("delete") && remote_ics.is_none() {
                tx.execute("DELETE FROM event_resources WHERE id=?", [&resource_id])
                    .map_err(|_| "清除已删除日程失败")?;
            } else {
                tx.execute(
                    "UPDATE event_resources SET etag=?,ics=?,dirty=1,deleted=? WHERE id=?",
                    rusqlite::params![
                        remote_etag,
                        local_ics,
                        kind.as_deref() == Some("delete"),
                        resource_id
                    ],
                )
                .map_err(|_| "保留本地日程失败")?;
                tx.execute(
                    "INSERT INTO pending_operations(id,resourceId,kind,baseEtag) VALUES(?,?,?,?)",
                    rusqlite::params![
                        Uuid::new_v4().to_string(),
                        resource_id,
                        kind.as_deref().unwrap_or("put"),
                        remote_etag
                    ],
                )
                .map_err(|_| "重新加入同步队列失败")?;
            }
        } else if let Some(ics) = remote_ics {
            tx.execute(
                "UPDATE event_resources SET ics=?,etag=?,dirty=0,deleted=0 WHERE id=?",
                rusqlite::params![ics, remote_etag, resource_id],
            )
            .map_err(|_| "采用服务器版本失败")?;
        } else {
            tx.execute("DELETE FROM event_resources WHERE id=?", [&resource_id])
                .map_err(|_| "清除远端已删日程失败")?;
        }
        tx.commit().map_err(|_| "提交冲突处理事务失败".into())
    }

    pub fn set_calendar(&self, id: &str, visible: bool, color: &str) -> Result<(), String> {
        if id.is_empty()
            || id.len() > 200
            || color.len() != 7
            || !color.starts_with('#')
            || !color[1..].bytes().all(|c| c.is_ascii_hexdigit())
        {
            return Err("日历参数无效".into());
        }
        let changed = self
            .db
            .execute(
                "UPDATE calendars SET visible=?,color=? WHERE id=?",
                rusqlite::params![visible, color, id],
            )
            .map_err(|_| "保存日历显示设置失败")?;
        if changed != 1 {
            return Err("日历不存在".into());
        }
        Ok(())
    }

    pub fn account(&self, id: &str) -> Result<Option<StoredAccount>, String> {
        self.db
            .query_row(
                "SELECT id,url,username,password,allowHttp,paused FROM accounts WHERE id=?",
                [id],
                |row| {
                    Ok(StoredAccount {
                        id: row.get(0)?,
                        url: row.get(1)?,
                        username: row.get(2)?,
                        password: row.get(3)?,
                        allow_http: row.get(4)?,
                        paused: row.get(5)?,
                    })
                },
            )
            .optional()
            .map_err(|_| "读取账户失败".into())
    }

    pub fn account_ids(&self) -> Result<Vec<String>, String> {
        self.db
            .prepare("SELECT id FROM accounts WHERE paused=0")
            .and_then(|mut statement| statement.query_map([], |row| row.get(0))?.collect())
            .map_err(|_| "读取账户列表失败".into())
    }

    pub fn sync_calendars(
        &mut self,
        account_id: &str,
        discovered: &[Calendar],
    ) -> Result<Vec<Calendar>, String> {
        let tx = self.db.transaction().map_err(|_| "无法开始日历列表事务")?;
        let mut output = Vec::new();
        for calendar in discovered {
            tx.execute("INSERT INTO calendars(id,accountId,url,name,color,readOnly) VALUES(?,?,?,?,?,?)
                ON CONFLICT(accountId,url) DO UPDATE SET name=excluded.name,readOnly=excluded.readOnly",
                rusqlite::params![calendar.id, account_id, calendar.url, calendar.name, calendar.color, calendar.read_only])
                .map_err(|_| "保存日历列表失败")?;
            let (id, color, visible): (String, String, bool) = tx
                .query_row(
                    "SELECT id,color,visible FROM calendars WHERE accountId=? AND url=?",
                    rusqlite::params![account_id, calendar.url],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .map_err(|_| "读取日历列表失败")?;
            let mut current = calendar.clone();
            current.id = id;
            current.color = color;
            current.visible = visible;
            output.push(current);
        }
        tx.commit().map_err(|_| "提交日历列表事务失败")?;
        Ok(output)
    }

    pub fn sync_token(&self, calendar_id: &str) -> Result<Option<String>, String> {
        self.db
            .query_row(
                "SELECT token FROM sync_state WHERE calendarId=?",
                [calendar_id],
                |row| row.get(0),
            )
            .optional()
            .map(|token| token.flatten())
            .map_err(|_| "读取同步令牌失败".into())
    }

    pub fn pending_operations(&self, calendar_id: &str) -> Result<Vec<PendingOperation>, String> {
        self.db
            .prepare(
                "SELECT p.id,p.resourceId,r.url,r.ics,p.kind,p.baseEtag,p.version
            FROM pending_operations p JOIN event_resources r ON r.id=p.resourceId
            LEFT JOIN conflicts c ON c.resourceId=r.id WHERE r.calendarId=? AND c.id IS NULL",
            )
            .and_then(|mut statement| {
                statement
                    .query_map([calendar_id], |row| {
                        Ok(PendingOperation {
                            id: row.get(0)?,
                            resource_id: row.get(1)?,
                            url: row.get(2)?,
                            ics: row.get(3)?,
                            kind: row.get(4)?,
                            base_etag: row.get(5)?,
                            version: row.get(6)?,
                        })
                    })?
                    .collect()
            })
            .map_err(|_| "读取待提交操作失败".into())
    }

    pub fn complete_operation(
        &mut self,
        op: &PendingOperation,
        next_etag: Option<&str>,
    ) -> Result<(), String> {
        let tx = self.db.transaction().map_err(|_| "无法开始操作提交事务")?;
        let version: Option<i64> = tx
            .query_row(
                "SELECT version FROM pending_operations WHERE id=?",
                [&op.id],
                |row| row.get(0),
            )
            .optional()
            .map_err(|_| "读取操作版本失败")?;
        match version {
            Some(version) if version == op.version => {
                tx.execute("DELETE FROM pending_operations WHERE id=?", [&op.id])
                    .map_err(|_| "移除已提交操作失败")?;
                if op.kind == "delete" {
                    tx.execute("DELETE FROM event_resources WHERE id=?", [&op.resource_id])
                        .map_err(|_| "移除已删除日程失败")?;
                } else {
                    tx.execute(
                        "UPDATE event_resources SET etag=?,dirty=0 WHERE id=?",
                        rusqlite::params![next_etag, op.resource_id],
                    )
                    .map_err(|_| "保存远端版本失败")?;
                }
            }
            Some(_) => {
                tx.execute(
                    "UPDATE pending_operations SET baseEtag=? WHERE id=?",
                    rusqlite::params![next_etag, op.id],
                )
                .map_err(|_| "更新待提交版本失败")?;
                tx.execute(
                    "UPDATE event_resources SET etag=? WHERE id=?",
                    rusqlite::params![next_etag, op.resource_id],
                )
                .map_err(|_| "更新日程版本失败")?;
            }
            None => {}
        }
        tx.commit().map_err(|_| "提交操作事务失败".into())
    }

    pub fn fail_operation(&self, id: &str, error: &str) -> Result<(), String> {
        self.db
            .execute(
                "UPDATE pending_operations SET attempts=attempts+1,error=? WHERE id=?",
                rusqlite::params![error, id],
            )
            .map_err(|_| "记录提交错误失败")?;
        Ok(())
    }

    pub fn conflict_operation(
        &self,
        op: &PendingOperation,
        remote_ics: Option<&str>,
        remote_etag: Option<&str>,
    ) -> Result<(), String> {
        self.db.execute("INSERT INTO conflicts(id,resourceId,localIcs,remoteIcs,remoteEtag,createdAt) VALUES(?,?,?,?,?,?)
            ON CONFLICT(resourceId) DO UPDATE SET localIcs=excluded.localIcs,remoteIcs=excluded.remoteIcs,remoteEtag=excluded.remoteEtag",
            rusqlite::params![Uuid::new_v4().to_string(), op.resource_id, op.ics, remote_ics, remote_etag, chrono::Utc::now().to_rfc3339()])
            .map_err(|_| "保存冲突失败")?;
        Ok(())
    }

    pub fn set_account_error(&self, id: &str, error: Option<&str>) -> Result<(), String> {
        self.db
            .execute(
                "UPDATE accounts SET error=? WHERE id=?",
                rusqlite::params![error, id],
            )
            .map_err(|_| "保存账户状态失败")?;
        Ok(())
    }

    pub fn finish_account_sync(&self, id: &str) -> Result<(), String> {
        self.db
            .execute(
                "UPDATE accounts SET lastSync=?,error=NULL WHERE id=?",
                rusqlite::params![chrono::Utc::now().to_rfc3339(), id],
            )
            .map_err(|_| "保存同步时间失败")?;
        Ok(())
    }

    pub fn apply_pull(&mut self, calendar_id: &str, pull: Pull) -> Result<(), String> {
        let tx = self.db.transaction().map_err(|_| "无法开始日程缓存事务")?;
        let seen: HashSet<&str> = pull
            .objects
            .iter()
            .filter(|r| !r.deleted)
            .map(|r| r.url.as_str())
            .collect();
        for remote in &pull.objects {
            let local: Option<LocalResource> = tx
                .query_row(
                    "SELECT id,ics,etag,dirty FROM event_resources WHERE calendarId=? AND url=?",
                    rusqlite::params![calendar_id, remote.url],
                    |row| {
                        Ok(LocalResource {
                            id: row.get(0)?,
                            ics: row.get(1)?,
                            etag: row.get(2)?,
                            dirty: row.get(3)?,
                        })
                    },
                )
                .optional()
                .map_err(|_| "读取本地日程失败")?;
            if let Some(local) = &local {
                if local.dirty {
                    if local.etag != remote.etag {
                        tx.execute("INSERT INTO conflicts(id,resourceId,localIcs,remoteIcs,remoteEtag,createdAt) VALUES(?,?,?,?,?,?)
                            ON CONFLICT(resourceId) DO UPDATE SET localIcs=excluded.localIcs,remoteIcs=excluded.remoteIcs,remoteEtag=excluded.remoteEtag",
                            rusqlite::params![Uuid::new_v4().to_string(), local.id, local.ics, remote.ics, remote.etag, chrono::Utc::now().to_rfc3339()])
                            .map_err(|_| "保存冲突失败")?;
                    }
                    continue;
                }
            }
            if remote.deleted {
                if let Some(local) = &local {
                    tx.execute("DELETE FROM event_resources WHERE id=?", [&local.id])
                        .map_err(|_| "删除过期缓存失败")?;
                }
                continue;
            }
            let ics = remote
                .ics
                .as_deref()
                .ok_or("远程日程数据为空，已取消缓存事务")?;
            tx.execute("INSERT INTO event_resources(id,calendarId,url,etag,ics,dirty,deleted) VALUES(?,?,?,?,?,0,0)
                ON CONFLICT(calendarId,url) DO UPDATE SET etag=excluded.etag,ics=excluded.ics,dirty=0,deleted=0",
                rusqlite::params![local.map(|r| r.id).unwrap_or_else(|| Uuid::new_v4().to_string()), calendar_id, remote.url, remote.etag, ics])
                .map_err(|_| "保存远端日程失败")?;
        }
        if pull.full {
            let locals: Vec<(String, String, String, Option<String>, bool)> = tx
                .prepare("SELECT id,url,ics,etag,dirty FROM event_resources WHERE calendarId=?")
                .and_then(|mut statement| {
                    statement
                        .query_map([calendar_id], |row| {
                            Ok((
                                row.get(0)?,
                                row.get(1)?,
                                row.get(2)?,
                                row.get(3)?,
                                row.get(4)?,
                            ))
                        })?
                        .collect()
                })
                .map_err(|_| "读取本地日程失败")?;
            for (id, url, ics, etag, dirty) in locals {
                if seen.contains(url.as_str()) {
                    continue;
                }
                if !dirty {
                    tx.execute("DELETE FROM event_resources WHERE id=?", [&id])
                        .map_err(|_| "清理过期缓存失败")?;
                } else if etag.is_some() {
                    tx.execute("INSERT INTO conflicts(id,resourceId,localIcs,remoteIcs,remoteEtag,createdAt) VALUES(?,?,?,NULL,NULL,?)
                        ON CONFLICT(resourceId) DO UPDATE SET localIcs=excluded.localIcs,remoteIcs=NULL,remoteEtag=NULL",
                        rusqlite::params![Uuid::new_v4().to_string(), id, ics, chrono::Utc::now().to_rfc3339()])
                        .map_err(|_| "保存远端删除冲突失败")?;
                }
            }
        }
        tx.execute(
            "INSERT INTO sync_state(calendarId,token,lastSync) VALUES(?,?,?)
            ON CONFLICT(calendarId) DO UPDATE SET token=excluded.token,lastSync=excluded.lastSync",
            rusqlite::params![calendar_id, pull.token, chrono::Utc::now().to_rfc3339()],
        )
        .map_err(|_| "保存同步令牌失败")?;
        tx.commit().map_err(|_| "提交日程缓存事务失败".into())
    }

    pub fn save_account(
        &mut self,
        id: &str,
        input: &AccountInput,
        ciphertext: &str,
        calendars: &[Calendar],
    ) -> Result<(), String> {
        let tx = self.db.transaction().map_err(|_| "无法开始账户保存事务")?;
        tx.execute("INSERT INTO accounts(id,name,url,username,password,allowHttp,paused) VALUES(?,?,?,?,?,?,?)
            ON CONFLICT(id) DO UPDATE SET name=excluded.name,password=excluded.password,allowHttp=excluded.allowHttp,paused=excluded.paused,error=NULL",
            rusqlite::params![id, input.name, input.url, input.username, ciphertext, input.allow_http, input.paused])
            .map_err(|_| "保存账户失败")?;
        for calendar in calendars {
            tx.execute("INSERT INTO calendars(id,accountId,url,name,color,readOnly) VALUES(?,?,?,?,?,?)
                ON CONFLICT(accountId,url) DO UPDATE SET name=excluded.name,readOnly=excluded.readOnly",
                rusqlite::params![calendar.id, id, calendar.url, calendar.name, calendar.color, calendar.read_only])
                .map_err(|_| "保存日历列表失败")?;
        }
        tx.commit().map_err(|_| "提交账户保存事务失败")?;
        Ok(())
    }

    /// Copy through SQLite's backup API so WAL content is included. The source is never written.
    pub fn copy_legacy(source: &Path, destination: &Path) -> rusqlite::Result<Inventory> {
        let source_db = Connection::open_with_flags(source, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
        let version: i64 = source_db.query_row("PRAGMA user_version", [], |row| row.get(0))?;
        if version != SCHEMA_VERSION || destination.exists() {
            return Err(rusqlite::Error::InvalidQuery);
        }
        let mut destination_db = Connection::open(destination)?;
        let backup = Backup::new(&source_db, &mut destination_db)?;
        backup.run_to_completion(100, std::time::Duration::from_millis(10), None)?;
        drop(backup);
        drop(destination_db);
        Self::open(destination)?.inventory()
    }

    #[cfg(windows)]
    pub fn rewrap_legacy_credentials(&mut self, local_state: &Path) -> Result<(), String> {
        let accounts: Vec<(String, String)> = self
            .db
            .prepare("SELECT id,password FROM accounts WHERE NOT EXISTS(SELECT 1 FROM ics_subscriptions s WHERE s.accountId=accounts.id)")
            .and_then(|mut statement| {
                statement
                    .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
                    .collect()
            })
            .map_err(|_| "读取旧版凭据失败")?;
        let tx = self.db.transaction().map_err(|_| "无法开始凭据转换事务")?;
        for (id, ciphertext) in accounts {
            if ciphertext.starts_with("dpapi:v1:") {
                continue;
            }
            match crate::vault::open_electron(local_state, &ciphertext)
                .and_then(|plaintext| crate::vault::seal(&plaintext))
            {
                Ok(rewrapped) => {
                    tx.execute(
                        "UPDATE accounts SET password=?,error=NULL WHERE id=?",
                        rusqlite::params![rewrapped, id],
                    )
                    .map_err(|_| "保存转换后的凭据失败")?;
                }
                Err(_) => {
                    tx.execute("UPDATE accounts SET error=? WHERE id=?", rusqlite::params![
                        "旧版密码无法在当前 Windows 用户下解密。请编辑账户，重新输入密码或应用专用密码后再同步。",id])
                        .map_err(|_| "记录重新授权状态失败")?;
                }
            }
        }
        tx.commit().map_err(|_| "提交凭据转换事务失败".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn clearing_cache_keeps_offline_edits_and_conflicts() {
        let dir = tempfile::tempdir().unwrap();
        let mut store = Store::open(&dir.path().join("calendar.db")).unwrap();
        store.db.execute_batch(
            "INSERT INTO accounts(id,name,url,username,password) VALUES('a','A','https://example.test','u','cipher');
             INSERT INTO calendars(id,accountId,url,name,color) VALUES('c','a','https://example.test/cal/','C','#123456');
             INSERT INTO event_resources(id,calendarId,url,ics) VALUES('clean','c','https://example.test/cal/clean.ics','clean');
             INSERT INTO event_resources(id,calendarId,url,ics,dirty) VALUES('dirty','c','https://example.test/cal/dirty.ics','offline',1);
             INSERT INTO event_resources(id,calendarId,url,ics) VALUES('conflict','c','https://example.test/cal/conflict.ics','both');
             INSERT INTO pending_operations(id,resourceId,kind) VALUES('p','dirty','put');
             INSERT INTO conflicts(id,resourceId,localIcs,createdAt) VALUES('f','conflict','both','2026-10-23');
             INSERT INTO sync_state(calendarId,token) VALUES('c','token-1');"
        ).unwrap();
        store.clear_cache().unwrap();
        let ids: Vec<String> = store
            .db
            .prepare("SELECT id FROM event_resources ORDER BY id")
            .unwrap()
            .query_map([], |row| row.get(0))
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap();
        assert_eq!(ids, ["conflict", "dirty"]);
        assert_eq!(store.inventory().unwrap().pending, 1);
        assert_eq!(store.inventory().unwrap().conflicts, 1);
        assert_eq!(
            store
                .db
                .query_row("SELECT COUNT(*) FROM sync_state", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
    }

    #[test]
    fn copy_preserves_pending_conflicts_and_raw_ics() {
        let dir = tempfile::tempdir().unwrap();
        let source = dir.path().join("electron.db");
        let destination = dir.path().join("tauri.db");
        let store = Store::open(&source).unwrap();
        store.db.execute_batch(
            "INSERT INTO accounts(id,name,url,username,password) VALUES('a','A','https://example.test','u','encrypted');
             INSERT INTO calendars(id,accountId,url,name,color) VALUES('c','a','https://example.test/cal','C','#123456');
             INSERT INTO event_resources(id,calendarId,url,etag,ics,dirty) VALUES('r','c','https://example.test/cal/r.ics','\"v1\"','BEGIN:VCALENDAR\nX-KEEP:yes\nEND:VCALENDAR',1);
             INSERT INTO pending_operations(id,resourceId,kind,baseEtag) VALUES('p','r','put','\"v1\"');
             INSERT INTO conflicts(id,resourceId,localIcs,remoteIcs,remoteEtag,createdAt) VALUES('f','r','local','remote','\"v2\"','2026-10-23');
             INSERT INTO sync_state(calendarId,token,lastSync) VALUES('c','token-1','2026-10-23');"
        ).unwrap();
        let before = store.inventory().unwrap();
        let after = Store::copy_legacy(&source, &destination).unwrap();
        assert_eq!(before, after);
        let copied = Store::open(&destination).unwrap();
        let ics: String = copied
            .db
            .query_row("SELECT ics FROM event_resources WHERE id='r'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(ics.contains("X-KEEP:yes"));
        let copied_password: String = copied
            .db
            .query_row("SELECT password FROM accounts WHERE id='a'", [], |row| {
                row.get(0)
            })
            .unwrap();
        let copied_etag: String = copied
            .db
            .query_row("SELECT etag FROM event_resources WHERE id='r'", [], |row| {
                row.get(0)
            })
            .unwrap();
        let copied_token: String = copied
            .db
            .query_row(
                "SELECT token FROM sync_state WHERE calendarId='c'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(copied_password, "encrypted");
        assert_eq!(copied_etag, "\"v1\"");
        assert_eq!(copied_token, "token-1");
        assert!(Store::copy_legacy(&source, &destination).is_err());
        let snapshot = copied
            .snapshot(json!({"theme":"system", "timezone":"Asia/Shanghai"}))
            .unwrap();
        assert_eq!(snapshot["pending"], 1);
        assert_eq!(snapshot["conflicts"][0]["id"], "f");
        assert_eq!(snapshot["accounts"][0]["allowHttp"], false);
        assert!(snapshot.to_string().find("encrypted").is_none());
        let mut settings = json!({
            "theme":"dark", "view":"dayGridMonth", "firstDay":1,
            "duration":60, "reminder":15, "timezone":"Asia/Shanghai",
            "autoSync":true, "interval":10, "defaultCalendar":"c",
            "timeFormat":"24", "dateFormat":"chinese",
            "autoUpdateCheck":true, "closeToTray":true
        });
        copied.set_settings(settings.clone()).unwrap();
        settings["timezone"] = json!("No/Such_Zone");
        assert!(copied.set_settings(settings).is_err());
        assert!(copied.set_calendar("c", false, "red").is_err());
        copied.set_calendar("c", false, "#abcdef").unwrap();
        let current = copied.snapshot(json!({})).unwrap();
        assert_eq!(current["settings"]["timezone"], "Asia/Shanghai");
        assert_eq!(current["calendars"][0]["visible"], false);
        let hidden = copied
            .event_resources(json!({"timezone":"Asia/Shanghai"}))
            .unwrap();
        assert_eq!(hidden["resources"].as_array().unwrap().len(), 0);
        copied.set_calendar("c", true, "#abcdef").unwrap();
        let visible = copied
            .event_resources(json!({"timezone":"Asia/Shanghai"}))
            .unwrap();
        assert_eq!(visible["resources"][0]["id"], "r");
        assert_eq!(visible["conflictResources"][0], "r");
        assert!(!visible.to_string().contains("encrypted"));
    }
}
