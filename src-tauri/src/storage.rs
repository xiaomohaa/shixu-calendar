use rusqlite::{Connection, OpenFlags, backup::Backup};
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
    }
}
