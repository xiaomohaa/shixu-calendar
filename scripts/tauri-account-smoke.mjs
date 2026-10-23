import { chromium } from 'playwright';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(import.meta.url);
const data = resolve('.smoke-data', `tauri-account-${Date.now()}`);
await mkdir(data, { recursive: true });
const fixturePath = resolve('.smoke-data/dav-fixture-tauri.cjs');
await build({ entryPoints: ['tests/dav-server.ts'], outfile: fixturePath, bundle: true, platform: 'node', format: 'cjs' });
const { davServer, fixtureIcs } = require(fixturePath);
const fixture = await davServer();
const resourcePath = '/home/personal/first.ics';
fixture.put(resourcePath, fixtureIcs('首次同步'));
const port = 9224;
const app = spawn(resolve('src-tauri/target/release/shixu_tauri_probe.exe'), [], {
  env: { ...process.env, SHIXU_TAURI_TEST_DATA_DIR: data, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
  stdio: 'ignore',
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
  const report = await page.evaluate(async account => {
    const calendars = await window.shixu.testAccount(account);
    const id = await window.shixu.saveAccount(account);
    let rejected401 = false;
    try { await window.shixu.testAccount({ ...account, password: 'wrong' }); }
    catch (error) { rejected401 = String(error).includes('401'); }
    await window.shixu.saveAccount({ ...account, id, name: '已重命名账户', password: '' });
    await window.shixu.sync(id);
    const firstEvents = await window.shixu.events('2026-10-22T00:00:00Z', '2026-10-25T00:00:00Z');
    const snapshot = await window.shixu.snapshot();
    return { discovered: calendars.length, id, accounts: snapshot.accounts.length, calendars: snapshot.calendars.length,
      leaked: JSON.stringify(snapshot).includes(account.password), calendarName: snapshot.calendars[0]?.name,
      renamed: snapshot.accounts[0]?.name === '已重命名账户', rejected401,
      firstTitle: firstEvents[0]?.title, firstCount: firstEvents.length };
  }, fixture.account);
  const db = new DatabaseSync(join(data, 'calendar.db'));
  const ciphertext = db.prepare('SELECT password FROM accounts WHERE id=?').get(report.id)?.password;
  const firstToken = db.prepare('SELECT token FROM sync_state').get()?.token;
  db.close();
  if (report.discovered !== 1 || report.accounts !== 1 || report.calendars !== 1 || report.calendarName !== '个人日历' || !report.renamed || !report.rejected401 || report.leaked || !ciphertext?.startsWith('dpapi:v1:') || report.firstTitle !== '首次同步' || report.firstCount !== 1 || firstToken !== 'token-1') {
    throw new Error(`Tauri account regression: ${JSON.stringify({ ...report, encrypted: !!ciphertext })}`);
  }
  fixture.put(resourcePath, fixtureIcs('增量更新'));
  await page.evaluate(id => window.shixu.sync(id), report.id);
  const updated = await page.evaluate(() => window.shixu.events('2026-10-22T00:00:00Z', '2026-10-25T00:00:00Z'));
  if (updated.length !== 1 || updated[0].title !== '增量更新') throw new Error('Tauri incremental pull failed');
  fixture.remove(resourcePath);
  await page.evaluate(id => window.shixu.sync(id), report.id);
  const removed = await page.evaluate(() => window.shixu.events('2026-10-22T00:00:00Z', '2026-10-25T00:00:00Z'));
  if (removed.length) throw new Error('Tauri remote deletion failed');
  const calendarId = new DatabaseSync(join(data, 'calendar.db'));
  const calendar = calendarId.prepare('SELECT id FROM calendars').get()?.id;
  calendarId.close();
  const localPath = '/home/personal/new-local.ics';
  const localIcs = fixtureIcs('本地新建', 'local-event');
  const localDb = new DatabaseSync(join(data, 'calendar.db'));
  const resourceId = randomUUID();
  localDb.prepare('INSERT INTO event_resources(id,calendarId,url,etag,ics,dirty,deleted) VALUES(?,?,?,?,?,1,0)').run(resourceId, calendar, `${fixture.url}${localPath}`, null, localIcs);
  localDb.prepare('INSERT INTO pending_operations(id,resourceId,kind,baseEtag) VALUES(?,?,?,NULL)').run(randomUUID(), resourceId, 'put');
  localDb.close();
  await page.evaluate(id => window.shixu.sync(id), report.id);
  if (fixture.resources.get(localPath)?.ics !== localIcs || !fixture.requests.some(r => r.method === 'PUT' && r.url === localPath && r.ifNoneMatch === '*')) throw new Error('Tauri conditional PUT failed');
  fixture.put(resourcePath, fixtureIcs('服务端基础'));
  await page.evaluate(id => window.shixu.sync(id), report.id);
  const conflictDb = new DatabaseSync(join(data, 'calendar.db'));
  const base = conflictDb.prepare('SELECT id,etag FROM event_resources WHERE url=?').get(`${fixture.url}${resourcePath}`);
  const edited = fixtureIcs('离线修改');
  conflictDb.prepare('UPDATE event_resources SET ics=?,dirty=1 WHERE id=?').run(edited, base.id);
  conflictDb.prepare('INSERT INTO pending_operations(id,resourceId,kind,baseEtag) VALUES(?,?,?,?)').run(randomUUID(), base.id, 'put', base.etag);
  conflictDb.close();
  fixture.put(resourcePath, fixtureIcs('服务端并发'));
  await page.evaluate(id => window.shixu.sync(id), report.id);
  const verifyDb = new DatabaseSync(join(data, 'calendar.db'));
  const preserved = verifyDb.prepare('SELECT ics,dirty FROM event_resources WHERE id=?').get(base.id);
  const conflict = verifyDb.prepare('SELECT id,remoteIcs FROM conflicts WHERE resourceId=?').get(base.id);
  const queued = verifyDb.prepare('SELECT COUNT(*) AS count FROM pending_operations WHERE resourceId=?').get(base.id)?.count;
  verifyDb.close();
  if (preserved?.ics !== edited || preserved?.dirty !== 1 || !conflict?.remoteIcs.includes('服务端并发') || queued !== 1) throw new Error('Tauri 412 conflict did not preserve offline edit');
  await page.evaluate(id => window.shixu.resolveConflict(id, 'both'), conflict.id);
  const resolvedDb = new DatabaseSync(join(data, 'calendar.db'));
  const resolved = resolvedDb.prepare('SELECT ics,dirty FROM event_resources WHERE id=?').get(base.id);
  const copy = resolvedDb.prepare('SELECT ics FROM event_resources WHERE calendarId=? AND id<>? AND dirty=1').get(calendar, base.id);
  const conflictCount = resolvedDb.prepare('SELECT COUNT(*) AS count FROM conflicts').get()?.count;
  resolvedDb.close();
  if (resolved?.dirty || !resolved?.ics.includes('服务端并发') || !copy?.ics.includes('离线修改') || conflictCount) throw new Error('Tauri keep-both conflict resolution failed');
  await page.evaluate(id => window.shixu.sync(id), report.id);
  const localEvent = await page.evaluate(async calendarId => {
    await window.shixu.saveEvent({ calendarId, title: '编辑器新建', start: '2026-10-23T12:00:00Z', end: '2026-10-23T13:00:00Z', allDay: false,
      timezone: 'UTC', location: '', description: '', rrule: '', reminder: -1, scope: 'series' });
    const events = await window.shixu.events('2026-10-22T00:00:00Z', '2026-10-25T00:00:00Z');
    return events.find(event => event.title === '编辑器新建');
  }, calendar);
  if (!localEvent?.pending) throw new Error('Tauri editor did not queue a local event');
  const detail = await page.evaluate(id => window.shixu.eventDetail(id, 'series'), localEvent.resourceId);
  if (detail.title !== '编辑器新建') throw new Error('Tauri event detail failed');
  await page.evaluate(async input => window.shixu.saveEvent({ ...input, title: '编辑器修改' }), detail);
  await page.evaluate(id => window.shixu.sync(id), report.id);
  const editedRow = new DatabaseSync(join(data, 'calendar.db'));
  const editedUrl = editedRow.prepare('SELECT url,dirty FROM event_resources WHERE id=?').get(localEvent.resourceId);
  editedRow.close();
  if (editedUrl?.dirty || !fixture.resources.get(new URL(editedUrl.url).pathname)?.ics.includes('编辑器修改')) throw new Error('Tauri editor update or sync failed');
  await page.evaluate(id => window.shixu.deleteEvent(id, 'series'), localEvent.resourceId);
  await page.evaluate(id => window.shixu.sync(id), report.id);
  if (fixture.resources.has(new URL(editedUrl.url).pathname)) throw new Error('Tauri editor delete failed');
  await page.evaluate(() => window.shixu.clearCache());
  const cacheDb = new DatabaseSync(join(data, 'calendar.db'));
  const cacheState = cacheDb.prepare('SELECT (SELECT COUNT(*) FROM event_resources) resources,(SELECT COUNT(*) FROM sync_state) tokens').get();
  cacheDb.close();
  if (cacheState.resources || cacheState.tokens) throw new Error('Tauri cache cleanup failed');
  await page.evaluate(id => window.shixu.deleteAccount(id), report.id);
  if ((await page.evaluate(() => window.shixu.snapshot())).accounts.length) throw new Error('Tauri account deletion failed');
  console.log('PASS: Tauri DAV, DPAPI, pull, conditional writes, conflict resolution, event CRUD, cache and account cleanup');
} finally {
  await browser?.close();
  app.kill();
  await fixture.close();
}
