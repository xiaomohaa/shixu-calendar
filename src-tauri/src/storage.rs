use rusqlite::{Connection, OpenFlags, OptionalExtension, backup::Backup};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::path::Path;

const SCHEMA_VERSION: i64 = 1;

pub struct Store {
    db: Connection,
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
        let accounts = self.db.prepare("SELECT id,name,url,username,allowHttp,paused,lastSync,error FROM accounts")?
            .query_map([], |row| Ok(json!({
                "id": row.get::<_, String>(0)?, "name": row.get::<_, String>(1)?,
                "url": row.get::<_, String>(2)?, "username": row.get::<_, String>(3)?,
                "allowHttp": row.get::<_, bool>(4)?, "paused": row.get::<_, bool>(5)?,
                "lastSync": row.get::<_, Option<String>>(6)?, "error": row.get::<_, Option<String>>(7)?
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

    pub fn event_resources(&self, defaults: Value) -> rusqlite::Result<Value> {
        let snapshot = self.snapshot(defaults)?;
        let resources = self
            .db
            .prepare(
                "SELECT r.id,r.calendarId,r.url,r.etag,r.ics,r.dirty,r.deleted
             FROM event_resources r JOIN calendars c ON c.id=r.calendarId WHERE c.visible=1",
            )?
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
            .filter(|c| c["visible"] == true)
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
}

#[cfg(test)]
mod tests {
    use super::*;

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
