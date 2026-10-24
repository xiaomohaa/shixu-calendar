import { chromium } from 'playwright';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const data = resolve('.smoke-data', `tauri-polish-${Date.now()}`);
await mkdir(data, { recursive: true });
const fixturePath = resolve('.smoke-data/polish-dav.cjs');
await build({ entryPoints: ['tests/dav-server.ts'], outfile: fixturePath, bundle: true, platform: 'node', format: 'cjs' });
const { davServer } = require(fixturePath), fixture = await davServer();
const app = spawn(resolve(process.env.SHIXU_TAURI_TEST_EXE || 'src-tauri/target/release/shixu-calendar.exe'), [], {
  env: { ...process.env, SHIXU_TAURI_TEST_DATA_DIR: data, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9231' }, stdio: 'ignore',
});
let browser;
try {
  for (let i = 0; i < 40; i++) {
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:9231'); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  if (!browser) throw new Error('Tauri polish window did not start');
  let page;
  for (let i = 0; i < 40; i++) {
    page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('http://tauri.localhost/'));
    if (page) break; await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!page) throw new Error('Tauri polish page missing');
  await page.locator('.month-grid').waitFor();
  await page.clock.setFixedTime(new Date('2026-10-24T03:35:00Z'));
  await page.evaluate(async account => {
    const id = await window.shixu.saveAccount({ ...account, name: '工作日历' });
    await window.shixu.sync(id);
    const state = await window.shixu.snapshot(), calendar = state.calendars.find(c => c.accountId === id);
    await window.shixu.settings({ ...state.settings, theme: 'light', boldText: false, autoSync: false });
    for (const [title, start, end, allDay] of [
      ['普通全天日程', '2026-10-13', '2026-10-14', true],
      ['过去的普通日程', '2026-10-14T10:00', '2026-10-14T11:00', false],
    ]) await window.shixu.saveEvent({ calendarId: calendar.id, title, start, end, allDay, timezone: 'Asia/Shanghai', location: '', description: '', rrule: '', reminder: -1, scope: 'series' });
  }, fixture.account);
  fixture.put('/subscription.ics', 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:holiday-icon\r\nDTSTAMP:20261001T000000Z\r\nDTSTART;VALUE=DATE:20261008\r\nDTEND;VALUE=DATE:20261009\r\nSUMMARY:节假日图标\r\nEND:VEVENT\r\nEND:VCALENDAR');
  await page.evaluate(url => window.shixu.importCalendarUrl({ name: '中国大陆节假日', url, allowHttp: true }), `${fixture.url}/subscription.ics`);
  await page.locator('.month-event').filter({ hasText: '节假日图标' }).waitFor();
  const regular = page.locator('.month-event').filter({ hasText: '普通全天日程' });
  const holiday = page.locator('.month-event').filter({ hasText: '节假日图标' });
  const past = page.locator('.month-event').filter({ hasText: '过去的普通日程' });
  if (await regular.locator('.calendar-marker').count() !== 1 || await holiday.locator('.holiday-marker').count() !== 1) throw new Error('All-day calendar/holiday icons are incorrect');
  if (await past.evaluate(el => getComputedStyle(el).opacity) !== '1') throw new Error('Past event still fades');
  const dates = await page.locator('.month-cell[data-date="2026-10-14"]').evaluate(el => ({
    solar: getComputedStyle(el.querySelector('.solar-date')).fontSize,
    lunar: getComputedStyle(el.querySelector('.lunar-date')).fontSize,
    lunarColor: getComputedStyle(el.querySelector('.lunar-date')).color,
    eventColor: getComputedStyle(el.querySelector('.month-event')).color,
  }));
  if (dates.solar !== '12px' || dates.lunar !== '10px' || dates.lunarColor !== dates.eventColor) throw new Error(`Lunar typography mismatch: ${JSON.stringify(dates)}`);
  if ((await page.locator('.calendar-heading').textContent()).includes('Asia/Shanghai')) throw new Error('Header timezone is still visible');
  await page.screenshot({ path: '.smoke-data/glass-month.png' });
  await page.getByRole('button', { name: '2026年10月13日', exact: true }).click();
  await page.getByRole('button', { name: '周', exact: true }).click();
  await page.locator('.fc .calendar-marker').waitFor();
  const weekPast = page.locator('.fc .event-timed').filter({ hasText: '过去的普通日程' });
  if (await weekPast.evaluate(el => getComputedStyle(el).opacity) !== '1') throw new Error('Week view still fades past events');
  await page.getByRole('button', { name: '上一周期', exact: true }).click();
  await page.locator('.fc .holiday-marker').waitFor();
  await page.getByRole('button', { name: '月', exact: true }).click();
  await page.locator('.month-grid').waitFor();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: '设置', exact: true });
  await sheet.waitFor();
  if (await page.locator('.settings-nav-group').count() !== 3) throw new Error('Settings groups missing');
  const navStyle = await page.getByRole('button', { name: '账户与同步', exact: true }).evaluate(el => ({ radius: getComputedStyle(el).borderRadius, shadow: getComputedStyle(el).boxShadow }));
  if (navStyle.radius !== '10px') throw new Error('Settings navigation retains oversized pills');
  if (await page.locator('.account-list .account-row').count() !== 2) throw new Error('Two account rows were not rendered');
  if (await sheet.evaluate(el => el.scrollWidth > el.clientWidth + 1)) throw new Error('Settings sheet overflows horizontally');
  await page.screenshot({ path: '.smoke-data/glass-settings.png' });
  for (const label of ['日历偏好','显示设置','外观','启动与后台','关于与更新','数据与隐私','同步冲突']) {
    await page.getByRole('button', { name: label, exact: true }).click();
    if (await page.locator('.settings-content').evaluate(el => el.scrollWidth > el.clientWidth + 1)) throw new Error(`Settings content overflows: ${label}`);
  }
  await page.getByRole('button', { name: '外观', exact: true }).click();
  await page.getByRole('button', { name: '深色', exact: true }).click();
  await page.getByRole('button', { name: '应用外观', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.screenshot({ path: '.smoke-data/glass-settings-dark.png' });
  await page.getByRole('button', { name: '浅色', exact: true }).click();
  await page.getByRole('button', { name: '应用外观', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'light');
  await page.setViewportSize({ width: 480, height: 360 });
  await page.getByRole('button', { name: '账户与同步', exact: true }).click();
  const bounds = await sheet.boundingBox();
  if (bounds.x < 0 || bounds.y < 0 || bounds.x + bounds.width > 480 || bounds.y + bounds.height > 360) throw new Error('Small settings sheet is off screen');
  if (await page.locator('.settings-content').evaluate(el => el.scrollWidth > el.clientWidth + 1)) throw new Error('Small account settings overflow');
  await page.screenshot({ path: '.smoke-data/glass-settings-small.png' });
  await page.getByRole('button', { name: '日历偏好', exact: true }).click();
  await page.getByRole('button', { name: '保存日历偏好', exact: true }).click();
  await page.getByRole('button', { name: '关闭面板', exact: true }).click();
  await page.locator('.month-grid').waitFor();
  const smallFont = await page.locator('.month-cell .lunar-date').first().evaluate(el => getComputedStyle(el).fontSize);
  if (smallFont !== '10px') throw new Error('Lunar font changes at minimum size');
  console.log('PASS: glass settings light/dark/minimum size, grouped navigation, two accounts, all-day icons, no event fading, lunar fonts and hidden header timezone');
} finally {
  await browser?.close().catch(() => {});
  if (app.exitCode === null) app.kill();
  await fixture.close();
}
