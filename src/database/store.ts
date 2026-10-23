import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { defaultSettings, type Account, type Calendar, type Conflict, type Settings } from '../shared/contracts';

export interface AccountRow extends Account { password: string }
export interface Resource { id: string; calendarId: string; url: string; etag: string | null; ics: string; dirty: number; deleted: number }
export interface Operation { id: string; resourceId: string; kind: 'put' | 'delete'; baseEtag: string | null; version: number; attempts: number; error: string | null }
export class Store {
  readonly db: DatabaseSync;
  constructor(path: string) { this.db = new DatabaseSync(path); try { this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;'); this.migrate(); } catch (e) { this.db.close(); throw e; } }
  migrate() {
    const version = this.one<{ user_version: number }>('PRAGMA user_version')!.user_version;
    if (version > 1) throw new Error('数据库来自更新版本，请升级应用');
    if (version === 0) this.transaction(() => {
      this.db.exec(`
        CREATE TABLE accounts(id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, username TEXT NOT NULL, password TEXT NOT NULL, allowHttp INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0, lastSync TEXT, error TEXT);
        CREATE TABLE calendars(id TEXT PRIMARY KEY, accountId TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, url TEXT NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL, visible INTEGER NOT NULL DEFAULT 1, readOnly INTEGER NOT NULL DEFAULT 0, UNIQUE(accountId,url));
        CREATE TABLE event_resources(id TEXT PRIMARY KEY, calendarId TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE, url TEXT NOT NULL, etag TEXT, ics TEXT NOT NULL, dirty INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, UNIQUE(calendarId,url));
        CREATE TABLE pending_operations(id TEXT PRIMARY KEY, resourceId TEXT NOT NULL UNIQUE REFERENCES event_resources(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('put','delete')), baseEtag TEXT, version INTEGER NOT NULL DEFAULT 1, attempts INTEGER NOT NULL DEFAULT 0, error TEXT);
        CREATE TABLE sync_state(calendarId TEXT PRIMARY KEY REFERENCES calendars(id) ON DELETE CASCADE, token TEXT, lastSync TEXT);
        CREATE TABLE conflicts(id TEXT PRIMARY KEY, resourceId TEXT NOT NULL UNIQUE REFERENCES event_resources(id) ON DELETE CASCADE, localIcs TEXT NOT NULL, remoteIcs TEXT, remoteEtag TEXT, createdAt TEXT NOT NULL);
        CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE reminders(key TEXT PRIMARY KEY, shownAt TEXT NOT NULL);
        CREATE INDEX resources_calendar ON event_resources(calendarId);
        PRAGMA user_version=1;
      `);
    });
  }
  run(sql: string, ...args: SQLInputValue[]) { return this.db.prepare(sql).run(...args); }
  one<T>(sql: string, ...args: SQLInputValue[]): T | undefined { return this.db.prepare(sql).get(...args) as T | undefined; }
  all<T>(sql: string, ...args: SQLInputValue[]): T[] { return this.db.prepare(sql).all(...args) as T[]; }
  transaction<T>(fn: () => T): T { this.db.exec('BEGIN IMMEDIATE'); try { const value = fn(); this.db.exec('COMMIT'); return value; } catch (e) { this.db.exec('ROLLBACK'); throw e; } }
  accounts(): Account[] { return this.all<AccountRow>('SELECT * FROM accounts').map(({ password: _password, ...a }) => ({ ...a, allowHttp: !!a.allowHttp, paused: !!a.paused })); }
  account(id: string) { return this.one<AccountRow>('SELECT * FROM accounts WHERE id=?', id); }
  calendars(): Calendar[] { return this.all<Calendar>('SELECT * FROM calendars').map(c => ({ ...c, visible: !!c.visible, readOnly: !!c.readOnly })); }
  resource(id: string) { return this.one<Resource>('SELECT * FROM event_resources WHERE id=?', id); }
  resources(calendarId?: string): Resource[] { return calendarId ? this.all<Resource>('SELECT * FROM event_resources WHERE calendarId=?', calendarId) : this.all<Resource>('SELECT * FROM event_resources'); }
  operations(calendarId: string): Operation[] { return this.all<Operation>('SELECT p.* FROM pending_operations p JOIN event_resources r ON p.resourceId=r.id LEFT JOIN conflicts c ON c.resourceId=r.id WHERE r.calendarId=? AND c.id IS NULL', calendarId); }
  settings(): Settings { const data = this.one<{ value: string }>("SELECT value FROM settings WHERE key='preferences'"); return { ...defaultSettings, ...(data ? JSON.parse(data.value) : {}) }; }
  setSettings(settings: Settings) { this.run("INSERT INTO settings VALUES('preferences',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", JSON.stringify(settings)); }
  upsertCalendar(c: Calendar) { const prev = this.one<Calendar>('SELECT * FROM calendars WHERE accountId=? AND url=?', c.accountId, c.url); this.run('INSERT INTO calendars(id,accountId,url,name,color,readOnly) VALUES(?,?,?,?,?,?) ON CONFLICT(accountId,url) DO UPDATE SET name=excluded.name, readOnly=excluded.readOnly', prev?.id ?? c.id, c.accountId, c.url, c.name, c.color, +c.readOnly); return prev?.id ?? c.id; }
  queue(r: Resource, kind: 'put' | 'delete') {
    this.transaction(() => {
      this.run('INSERT INTO event_resources VALUES(?,?,?,?,?,1,?) ON CONFLICT(id) DO UPDATE SET ics=excluded.ics,dirty=1,deleted=excluded.deleted', r.id, r.calendarId, r.url, r.etag, r.ics, +(kind === 'delete'));
      this.run('INSERT INTO pending_operations(id,resourceId,kind,baseEtag) VALUES(?,?,?,?) ON CONFLICT(resourceId) DO UPDATE SET kind=excluded.kind,version=version+1,error=NULL', randomUUID(), r.id, kind, r.etag);
      // A conflict's local side always reflects the latest local edit.
      this.run('UPDATE conflicts SET localIcs=? WHERE resourceId=?', r.ics, r.id);
    });
  }
  conflict(r: Resource, remoteIcs: string | null, remoteEtag: string | null) { this.run('INSERT INTO conflicts VALUES(?,?,?,?,?,?) ON CONFLICT(resourceId) DO UPDATE SET localIcs=excluded.localIcs,remoteIcs=excluded.remoteIcs,remoteEtag=excluded.remoteEtag', randomUUID(), r.id, r.ics, remoteIcs, remoteEtag, new Date().toISOString()); }
  conflicts() { return this.all<Conflict>('SELECT * FROM conflicts ORDER BY createdAt'); }
  pending() { return this.one<{ count: number }>('SELECT COUNT(*) count FROM pending_operations')!.count; }
  clearCache() {
    this.transaction(() => { this.run('DELETE FROM event_resources WHERE dirty=0 AND id NOT IN (SELECT resourceId FROM conflicts)'); this.run('DELETE FROM sync_state'); this.run('DELETE FROM reminders'); });
  }
  close() { this.db.close(); }
}
