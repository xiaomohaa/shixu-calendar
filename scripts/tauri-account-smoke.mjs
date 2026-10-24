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
const app = spawn(resolve('src-tauri/target/release/shixu-calendar.exe'), [], {
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
  const desktop = await page.evaluate(() => window.shixu.desktopState());
  if (desktop.mode !== 'development' || desktop.canAutoStart || desktop.openAtLogin) throw new Error(`Tauri desktop state regression: ${JSON.stringify(desktop)}`);
  const updater = await page.evaluate(async () => {
    const before = await window.shixu.updateState();
    await window.shixu.checkForUpdates();
    return { before, after: await window.shixu.updateState() };
  });
  if (updater.before.mode !== 'development' || updater.before.currentVersion !== '2.0.0-alpha.1' || updater.after.phase !== 'idle') {
    throw new Error(`Tauri updater development mode regression: ${JSON.stringify(updater)}`);
  }
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
  await page.locator('.month-cell[data-date="2026-10-23"] .solar-date').click();
  await page.getByRole('button', { name: '新建日程', exact: true }).first().click();
  await page.getByRole('textbox', { name: '日程标题' }).fill('Tauri 界面新建');
  await page.getByLabel('开始时间').fill('2026-10-23T12:00');
  await page.getByLabel('结束时间', { exact: true }).fill('2026-10-23T13:00');
  await page.getByRole('button', { name: '保存日程', exact: true }).click();
  await page.waitForFunction(async () => (await window.shixu.events('2026-10-22T00:00:00Z', '2026-10-25T00:00:00Z')).some(event => event.title === 'Tauri 界面新建'));
  const createdButton = page.getByRole('button', { name: /Tauri 界面新建/ }).and(page.locator('.month-event:visible')).first();
  if (await createdButton.count()) await createdButton.click();
  else {
    await page.locator('.month-cell[data-date="2026-10-23"] .month-more').click();
    await page.locator('.day-agenda .agenda-event').filter({ hasText: 'Tauri 界面新建' }).click();
  }
  await page.getByRole('textbox', { name: '日程标题' }).fill('Tauri 界面修改');
  await page.getByRole('button', { name: '保存日程', exact: true }).click();
  await page.waitForFunction(async () => (await window.shixu.events('2026-10-22T00:00:00Z', '2026-10-25T00:00:00Z')).some(event => event.title === 'Tauri 界面修改'));
  const uiEvent = (await page.evaluate(() => window.shixu.events('2026-10-22T00:00:00Z', '2026-10-25T00:00:00Z'))).find(event => event.title === 'Tauri 界面修改');
  if (!uiEvent) throw new Error('Tauri UI did not persist the edited event');
  await page.evaluate(async calendarId => {
    for (const [title, start, end] of [
      ['连续跨天胶囊', '2026-10-26', '2026-10-29'],
      ['已结束跨天胶囊', '2026-10-19', '2026-10-22'],
      ['跨周续接胶囊', '2026-10-31', '2026-11-04'],
    ]) await window.shixu.saveEvent({ calendarId, title, start, end, allDay: true, timezone: 'Asia/Shanghai', location: '', description: '', rrule: '', reminder: -1, scope: 'series' });
  }, calendar);
  const span = page.locator('.month-span').filter({ has: page.getByRole('button', { name: /连续跨天胶囊/ }) });
  await span.waitFor();
  const box = await span.boundingBox();
  const firstDay = await page.locator('.month-cell[data-date="2026-10-26"]').boundingBox();
  const lastDay = await page.locator('.month-cell[data-date="2026-10-28"]').boundingBox();
  if (Math.abs(box.x - firstDay.x - 3) > 1 || Math.abs(box.x + box.width - lastDay.x - lastDay.width + 3) > 1) throw new Error('Multi-day capsule does not align with start and end grid lines');
  const capsuleStyle = await span.locator('button').evaluate(el => ({ height: el.getBoundingClientRect().height, font: getComputedStyle(el).fontSize }));
  if (capsuleStyle.height > 18 || capsuleStyle.font !== '11px') throw new Error('Capsule size regression');
  if (await page.locator('.month-span').filter({ has: page.getByRole('button', { name: /跨周续接胶囊/ }) }).count() !== 2) throw new Error('Cross-week capsule continuation failed');
  if (await page.locator('.month-cell .month-event').filter({ hasText: '连续跨天胶囊' }).count()) throw new Error('Multi-day capsule was duplicated in individual day cells');
  const past = page.locator('.month-span').filter({ has: page.getByRole('button', { name: /已结束跨天胶囊/ }) }).locator('button');
  if (await past.evaluate(el => Number(getComputedStyle(el).opacity)) >= .6) throw new Error('Ended event was not faded');
  await page.screenshot({ path: '.smoke-data/month-display.png' });
  const fixedFonts = await page.evaluate(() => ({
    solar: getComputedStyle(document.querySelector('.solar-date')).fontSize,
    lunar: getComputedStyle(document.querySelector('.lunar-date')).fontSize,
    event: getComputedStyle(document.querySelector('.month-event-title')).fontSize,
  }));
  await page.setViewportSize({ width: 480, height: 360 });
  await page.waitForFunction(() => document.querySelector('.month-grid').classList.contains('inline-overflow'));
  const smallLayout = await page.evaluate(() => {
    const grid = document.querySelector('.month-grid'), rect = grid.getBoundingClientRect();
    const day = document.querySelector('.month-cell[data-date="2026-10-23"]');
    const event = day.querySelector('.month-event'), header = day.querySelector('.solar-date'), lunar = day.querySelector('.lunar-date');
    const capsule = event.getBoundingClientRect(), cell = day.getBoundingClientRect();
    return {
      solar: getComputedStyle(header).fontSize, lunar: getComputedStyle(lunar).fontSize,
      event: getComputedStyle(event.querySelector('.month-event-title')).fontSize,
      capsuleVisible: capsule.top >= cell.top && capsule.bottom <= cell.bottom + 1 && capsule.height === 18,
      allDates: [...grid.querySelectorAll('.month-day-button')].every(el => { const r = el.getBoundingClientRect(); return r.top >= rect.top && r.bottom <= rect.bottom + 1; }),
      lunarLeft: lunar.getBoundingClientRect().left < header.getBoundingClientRect().left,
      solarRight: cell.right - header.getBoundingClientRect().right < 6,
      more: day.querySelector('.month-more')?.textContent,
      mode: grid.dataset.eventMode, dots: grid.querySelectorAll('.event-dot').length,
    };
  });
  if (smallLayout.solar !== fixedFonts.solar || smallLayout.lunar !== fixedFonts.lunar || smallLayout.event !== fixedFonts.event) throw new Error(`Fonts changed at minimum size: ${JSON.stringify(smallLayout)}`);
  if (!smallLayout.capsuleVisible || !smallLayout.allDates || !smallLayout.lunarLeft || !smallLayout.solarRight || !/^\+\d+个$/.test(smallLayout.more) || smallLayout.mode !== 'capsules' || smallLayout.dots) throw new Error(`Minimum-size event layout failed: ${JSON.stringify(smallLayout)}`);
  await page.locator('.month-cell[data-date="2026-10-23"] .month-more').click();
  if (await page.locator('.day-agenda .agenda-event').count() < 4) throw new Error('Folded events were lost from the agenda');
  await page.getByRole('button', { name: '关闭当天日程', exact: true }).click();
  await page.screenshot({ path: '.smoke-data/small-window-events.png' });
  await page.setViewportSize({ width: 1380, height: 900 });
  await page.waitForFunction(() => !document.querySelector('.month-grid').classList.contains('inline-overflow'));
  await page.evaluate(id => window.shixu.deleteAccount(id), report.id);
  if ((await page.evaluate(() => window.shixu.snapshot())).accounts.length) throw new Error('Tauri account deletion failed');
  fixture.put('/subscription.ics', fixtureIcs('ICS 链接导入'));
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.locator('.ics-import summary').click();
  await page.getByRole('textbox', { name: '订阅日历名称', exact: true }).fill('链接订阅测试');
  await page.getByRole('textbox', { name: 'ICS 链接', exact: true }).fill(`${fixture.url}/subscription.ics`);
  await page.getByRole('checkbox', { name: '允许 HTTP 链接', exact: true }).check();
  await page.getByRole('button', { name: '导入 ICS 日历', exact: true }).click();
  await page.getByText('日历已导入，可在侧栏查看或调整颜色。', { exact: true }).waitFor();
  const feedSnapshot = await page.evaluate(() => window.shixu.snapshot());
  const feed = feedSnapshot.accounts.find(a => a.subscription);
  if (!feed || !feedSnapshot.calendars[0]?.readOnly) throw new Error('ICS import did not create a read-only subscription');
  const feedEvents = await page.evaluate(() => window.shixu.events('2026-10-22', '2026-10-25'));
  if (!feedEvents.some(e => e.title === 'ICS 链接导入')) throw new Error('ICS imported event was not expanded');
  const writeRejected = await page.evaluate(async calendarId => {
    try { await window.shixu.saveEvent({ calendarId, title: '禁止写入', start: '2026-10-23', end: '2026-10-24', allDay: true, timezone: 'Asia/Shanghai', location: '', description: '', rrule: '', reminder: -1, scope: 'series' }); return false; }
    catch (error) { return String(error).includes('只读'); }
  }, feedSnapshot.calendars[0].id);
  if (!writeRejected) throw new Error('ICS subscription allowed editing');
  fixture.put('/subscription.ics', fixtureIcs('ICS 订阅刷新'));
  await page.evaluate(id => window.shixu.sync(id), feed.id);
  if (!(await page.evaluate(() => window.shixu.events('2026-10-22', '2026-10-25'))).some(e => e.title === 'ICS 订阅刷新')) throw new Error('ICS subscription sync failed');
  await page.reload();
  await page.locator('.month-grid').waitFor();
  if (!(await page.evaluate(() => window.shixu.snapshot())).accounts.some(a => a.subscription)) throw new Error('ICS subscription did not persist');
  await page.evaluate(id => window.shixu.deleteAccount(id), feed.id);
  if (process.env.SHIXU_TEST_ICLOUD === '1') {
    const liveFeed = await page.evaluate(() => window.shixu.importCalendarUrl({ name: '中国节假日', url: 'https://calendars.icloud.com/holidays/cn_zh.ics/', allowHttp: false }));
    const holidays = await page.evaluate(() => window.shixu.events('2026-01-01', '2027-01-01'));
    if (!holidays.length) throw new Error('Actual iCloud feed imported without visible holidays');
    await page.evaluate(id => window.shixu.deleteAccount(id), liveFeed);
    console.log(`PASS: actual iCloud ICS URL imported ${holidays.length} holiday instances in 2026`);
  }
  console.log('PASS: ICS URL import UI, read-only enforcement, refresh and persistent subscription');
  console.log('PASS: Tauri DAV, event CRUD, continuous cross-day/cross-week capsules, compact size, grid alignment and ended fading');
} finally {
  await browser?.close();
  app.kill();
  await fixture.close();
}
