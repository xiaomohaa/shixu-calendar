use super::Store;
use crate::notifications::Notice;
use rusqlite::{OptionalExtension, params};
use serde_json::Value;

impl Store {
    pub fn init_reminder_deliveries(&self) -> rusqlite::Result<()> {
        self.db.execute_batch("CREATE TABLE IF NOT EXISTS reminder_deliveries(
            key TEXT PRIMARY KEY REFERENCES reminders(key) ON DELETE CASCADE,
            resourceId TEXT REFERENCES event_resources(id) ON DELETE CASCADE,
            payload TEXT NOT NULL,dueAt INTEGER NOT NULL,deliveredAt INTEGER);
            CREATE INDEX IF NOT EXISTS reminder_delivery_due ON reminder_deliveries(deliveredAt,dueAt);")
    }

    pub fn reminder_preferences(&self) -> (String, String) {
        let saved = self
            .db
            .query_row(
                "SELECT value FROM settings WHERE key='preferences'",
                [],
                |row| row.get::<_, String>(0),
            )
            .ok();
        let value = saved
            .and_then(|raw| serde_json::from_str::<Value>(&raw).ok())
            .unwrap_or_default();
        let mode = match value["notificationMode"].as_str() {
            Some("floating") => "floating",
            _ => "system",
        };
        let theme = match value["theme"].as_str() {
            Some("light") => "light",
            Some("dark") => "dark",
            _ => "system",
        };
        (mode.into(), theme.into())
    }

    pub fn reminder_event_exists(&self, notice: &Notice) -> bool {
        notice.event.as_ref().is_none_or(|event| {
            self.db
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM event_resources WHERE id=? AND deleted=0)",
                    [&event.resource_id],
                    |row| row.get::<_, bool>(0),
                )
                .unwrap_or(false)
        })
    }

    pub fn enqueue_reminder(&mut self, notice: &Notice, due: i64) -> Result<bool, String> {
        if !self.reminder_event_exists(notice) {
            return Err("对应日程已删除或不存在".into());
        }
        let payload = serde_json::to_string(notice).map_err(|_| "提醒内容无效")?;
        self.db
            .execute_batch("SAVEPOINT reminder_delivery")
            .map_err(|_| "无法开始提醒事务")?;
        let result = (|| {
            if !self.claim_reminder(&notice.key)? {
                return Ok(false);
            }
            self.db
                .execute(
                    "INSERT INTO reminder_deliveries(key,resourceId,payload,dueAt) VALUES(?,?,?,?)",
                    params![
                        notice.key,
                        notice.event.as_ref().map(|event| &event.resource_id),
                        payload,
                        due
                    ],
                )
                .map_err(|_| "保存提醒队列失败".to_string())?;
            Ok(true)
        })();
        if result.is_ok() && self.db.execute_batch("RELEASE reminder_delivery").is_ok() {
            return result;
        }
        let _ = self
            .db
            .execute_batch("ROLLBACK TO reminder_delivery; RELEASE reminder_delivery");
        result.and(Err("提交提醒事务失败".into()))
    }

    pub fn pending_reminders(&self, now: i64) -> Result<Vec<Notice>, String> {
        self.db.execute("DELETE FROM reminder_deliveries WHERE resourceId IS NOT NULL AND NOT EXISTS(SELECT 1 FROM event_resources WHERE event_resources.id=reminder_deliveries.resourceId AND deleted=0)",[]).map_err(|_| "清理失效提醒失败")?;
        let mut statement = self.db.prepare("SELECT payload FROM reminder_deliveries WHERE deliveredAt IS NULL AND dueAt<=? ORDER BY dueAt,rowid LIMIT 100").map_err(|_| "读取提醒队列失败")?;
        let rows = statement
            .query_map([now], |row| row.get::<_, String>(0))
            .map_err(|_| "读取提醒队列失败")?;
        rows.map(|raw| {
            raw.map_err(|_| "读取提醒队列失败".into())
                .and_then(|raw| serde_json::from_str(&raw).map_err(|_| "提醒队列内容无效".into()))
        })
        .collect()
    }

    pub fn delivered_reminder(&self, key: &str) -> Result<Option<Notice>, String> {
        self.db
            .query_row(
                "SELECT payload FROM reminder_deliveries WHERE key=?",
                [key],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|_| "读取提醒失败".to_string())?
            .map(|raw| serde_json::from_str(&raw).map_err(|_| "提醒内容无效".into()))
            .transpose()
    }

    pub fn mark_reminder_delivered(&self, key: &str) -> Result<(), String> {
        self.db
            .execute(
                "UPDATE reminder_deliveries SET deliveredAt=? WHERE key=?",
                params![chrono::Utc::now().timestamp_millis(), key],
            )
            .map(|_| ())
            .map_err(|_| "保存提醒送达状态失败".into())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::notifications::EventReference;
    fn notice(key: &str) -> Notice {
        Notice::new(key.into(), "测试".into(), "提醒".into(), None, true).unwrap()
    }
    #[test]
    fn queue_reuses_claim_and_survives_reopen_and_snooze_due_time() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("calendar.db");
        {
            let mut store = Store::open(&path).unwrap();
            assert!(store.enqueue_reminder(&notice("original"), 1000).unwrap());
            assert!(!store.enqueue_reminder(&notice("original"), 1000).unwrap());
            assert_eq!(store.pending_reminders(1000).unwrap().len(), 1);
            store.mark_reminder_delivered("original").unwrap();
            assert!(
                store
                    .enqueue_reminder(&notice("snooze:later"), 2000)
                    .unwrap()
            );
            assert!(store.pending_reminders(1999).unwrap().is_empty());
        }
        let store = Store::open(&path).unwrap();
        assert_eq!(
            store.pending_reminders(2000).unwrap()[0].key,
            "snooze:later"
        );
        assert!(store.delivered_reminder("original").unwrap().is_some());
        assert_eq!(store.reminder_preferences().0, "system");
    }
    #[test]
    fn failed_queue_insert_rolls_back_the_existing_claim_atomically() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = Store::open(&temp.path().join("db")).unwrap();
        store.db.execute_batch("CREATE TRIGGER reject_delivery BEFORE INSERT ON reminder_deliveries BEGIN SELECT RAISE(ABORT,'test'); END;").unwrap();
        assert!(store.enqueue_reminder(&notice("retry"), 0).is_err());
        assert_eq!(
            store
                .db
                .query_row("SELECT COUNT(*) FROM reminders", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            0
        );
        store
            .db
            .execute_batch("DROP TRIGGER reject_delivery")
            .unwrap();
        assert!(store.enqueue_reminder(&notice("retry"), 0).unwrap());
    }
    #[test]
    fn deleted_resources_do_not_leave_snoozes_or_block_later_notices() {
        let temp = tempfile::tempdir().unwrap();
        let mut store = Store::open(&temp.path().join("db")).unwrap();
        store.db.execute_batch("INSERT INTO accounts(id,name,url,username,password) VALUES('a','test','https://example.com','user','encrypted'); INSERT INTO calendars(id,accountId,url,name,color) VALUES('c','a','https://example.com/c','test','#123456'); INSERT INTO event_resources(id,calendarId,url,ics) VALUES('r','c','https://example.com/c/r.ics','ics');").unwrap();
        let mut event = notice("event");
        event.event = Some(EventReference {
            resource_id: "r".into(),
            recurrence_id: Some("2026-10-24T10:00:00".into()),
            start: "2026-10-24T02:00:00Z".into(),
            all_day: false,
        });
        assert!(store.enqueue_reminder(&event, 0).unwrap());
        store
            .db
            .execute("UPDATE event_resources SET deleted=1 WHERE id='r'", [])
            .unwrap();
        assert!(store.pending_reminders(1000).unwrap().is_empty());
        assert!(!store.reminder_event_exists(&event));
        event.key = "another".into();
        assert!(store.enqueue_reminder(&event, 0).is_err());
        assert!(store.enqueue_reminder(&notice("next"), 0).unwrap());
        assert_eq!(store.pending_reminders(1000).unwrap()[0].key, "next");
    }
}
