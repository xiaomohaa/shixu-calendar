import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const root = resolve('.smoke-data', `tauri-migration-${Date.now()}`);
const legacy = join(root, 'electron'), data = join(root, 'tauri');
await mkdir(legacy, { recursive: true });
await mkdir(data, { recursive: true });
const legacyPath = join(legacy, 'calendar.db');
const source = new DatabaseSync(legacyPath);
source.exec(`PRAGMA foreign_keys=ON;
CREATE TABLE accounts(id TEXT PRIMARY KEY, name TEXT NOT NULL, url TEXT NOT NULL, username TEXT NOT NULL, password TEXT NOT NULL, allowHttp INTEGER NOT NULL DEFAULT 0, paused INTEGER NOT NULL DEFAULT 0, lastSync TEXT, error TEXT);
CREATE TABLE calendars(id TEXT PRIMARY KEY, accountId TEXT NOT NULL REFERENCES accounts(id) ON DELETE CASCADE, url TEXT NOT NULL, name TEXT NOT NULL, color TEXT NOT NULL, visible INTEGER NOT NULL DEFAULT 1, readOnly INTEGER NOT NULL DEFAULT 0, UNIQUE(accountId,url));
CREATE TABLE event_resources(id TEXT PRIMARY KEY, calendarId TEXT NOT NULL REFERENCES calendars(id) ON DELETE CASCADE, url TEXT NOT NULL, etag TEXT, ics TEXT NOT NULL, dirty INTEGER NOT NULL DEFAULT 0, deleted INTEGER NOT NULL DEFAULT 0, UNIQUE(calendarId,url));
CREATE TABLE pending_operations(id TEXT PRIMARY KEY, resourceId TEXT NOT NULL UNIQUE REFERENCES event_resources(id) ON DELETE CASCADE, kind TEXT NOT NULL CHECK(kind IN ('put','delete')), baseEtag TEXT, version INTEGER NOT NULL DEFAULT 1, attempts INTEGER NOT NULL DEFAULT 0, error TEXT);
CREATE TABLE sync_state(calendarId TEXT PRIMARY KEY REFERENCES calendars(id) ON DELETE CASCADE, token TEXT, lastSync TEXT);
CREATE TABLE conflicts(id TEXT PRIMARY KEY, resourceId TEXT NOT NULL UNIQUE REFERENCES event_resources(id) ON DELETE CASCADE, localIcs TEXT NOT NULL, remoteIcs TEXT, remoteEtag TEXT, createdAt TEXT NOT NULL);
CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE reminders(key TEXT PRIMARY KEY, shownAt TEXT NOT NULL);
CREATE INDEX resources_calendar ON event_resources(calendarId);
PRAGMA user_version=1;`);
const ics = 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:legacy-test\r\nDTSTAMP:20261001T000000Z\r\nDTSTART:20261023T020000Z\r\nDTEND:20261023T030000Z\r\nSUMMARY:迁移离线修改\r\nX-PRESERVE:original-data\r\nEND:VEVENT\r\nEND:VCALENDAR';
source.prepare('INSERT INTO accounts(id,name,url,username,password) VALUES(?,?,?,?,?)').run('a','旧版账户','https://example.test/dav/','alice','old-encrypted-blob');
source.prepare('INSERT INTO calendars(id,accountId,url,name,color) VALUES(?,?,?,?,?)').run('c','a','https://example.test/cal/','旧版日历','#497bba');
source.prepare('INSERT INTO event_resources(id,calendarId,url,etag,ics,dirty) VALUES(?,?,?,?,?,1)').run('r','c','https://example.test/cal/r.ics','"v1"',ics);
source.prepare('INSERT INTO pending_operations(id,resourceId,kind,baseEtag) VALUES(?,?,?,?)').run('p','r','put','"v1"');
source.prepare('INSERT INTO conflicts(id,resourceId,localIcs,remoteIcs,remoteEtag,createdAt) VALUES(?,?,?,?,?,?)').run('f','r',ics,'remote','"v2"','2026-10-23');
source.prepare('INSERT INTO sync_state(calendarId,token) VALUES(?,?)').run('c','token-1');
source.close();
const hash = async path => createHash('sha256').update(await readFile(path)).digest('hex');
const originalHash = await hash(legacyPath);
const port = 9226;
const app = spawn(resolve('src-tauri/target/release/shixu-calendar.exe'), [], {
  env: { ...process.env, SHIXU_TAURI_TEST_DATA_DIR: data, SHIXU_TAURI_TEST_LEGACY_DIR: legacy,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, stdio: 'ignore',
});
let browser;
try {
  for (let attempt = 0; attempt < 30; attempt++) {
    try { browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 500)); }
  }
  if (!browser) throw new Error('Tauri WebView2 did not start');
  const page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith('http://tauri.localhost/'));
  if (!page) throw new Error('Tauri page not found');
  await page.locator('.month-grid').waitFor({ timeout: 20000 });
  const result = await page.evaluate(async () => {
    const snapshot = await window.shixu.snapshot();
    const events = await window.shixu.events('2026-10-22T00:00:00Z', '2026-10-25T00:00:00Z');
    return { snapshot, events };
  });
  if (result.snapshot.accounts.length !== 1 || result.snapshot.calendars.length !== 1 || result.snapshot.pending !== 1 ||
      result.snapshot.conflicts.length !== 1 || result.events[0]?.title !== '迁移离线修改' ||
      !result.snapshot.accounts[0].error?.includes('重新输入') || JSON.stringify(result).includes('old-encrypted-blob')) {
    throw new Error('Legacy migration lost offline data or leaked credentials');
  }
  const copied = new DatabaseSync(join(data, 'calendar.db'));
  const row = copied.prepare('SELECT password FROM accounts WHERE id=?').get('a');
  const token = copied.prepare('SELECT token FROM sync_state WHERE calendarId=?').get('c')?.token;
  copied.close();
  if (row?.password !== 'old-encrypted-blob' || token !== 'token-1' || await hash(legacyPath) !== originalHash) throw new Error('Legacy source changed or copied data diverged');
  await page.evaluate(() => window.shixu.saveAccount({ id:'a', name:'旧版账户', url:'https://example.test/dav/', username:'alice', password:'new-secret', allowHttp:false, paused:false }));
  const updated = new DatabaseSync(join(data, 'calendar.db'));
  const newCipher = updated.prepare('SELECT password FROM accounts WHERE id=?').get('a')?.password;
  updated.close();
  if (!newCipher?.startsWith('dpapi:v1:') || await hash(legacyPath) !== originalHash) throw new Error('Reauthorization changed source or failed to encrypt');
  console.log('PASS: source-preserving legacy copy, offline queue/conflict/token, reauthorization');
} finally {
  await browser?.close();
  app.kill();
}
