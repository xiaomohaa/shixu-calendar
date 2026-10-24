import { setEditorDateTime, editorDateTime } from './editor-controls.mjs';
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
      ['第二项全天日程', '2026-10-13', '2026-10-14', true],
      ['过去的普通日程', '2026-10-14T10:00', '2026-10-14T11:00', false],
    ]) await window.shixu.saveEvent({ calendarId: calendar.id, title, start, end, allDay, timezone: 'Asia/Shanghai', location: '', description: '', rrule: '', reminder: -1, scope: 'series' });
    await window.shixu.saveEvent({ calendarId: calendar.id, title: 'UTC来源日程', start: '2026-10-15T02:00:00Z', end: '2026-10-15T03:00:00Z', allDay: false, timezone: 'UTC', location: '', description: '', rrule: '', reminder: -1, scope: 'series' });
  }, fixture.account);
  fixture.put('/subscription.ics', 'BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:holiday-icon\r\nDTSTAMP:20261001T000000Z\r\nDTSTART;VALUE=DATE:20261008\r\nDTEND;VALUE=DATE:20261009\r\nSUMMARY:节假日图标\r\nEND:VEVENT\r\nEND:VCALENDAR');
  await page.evaluate(url => window.shixu.importCalendarUrl({ name: '中国大陆节假日', url, allowHttp: true }), `${fixture.url}/subscription.ics`);
  await page.locator('.month-event').filter({ hasText: '节假日图标' }).waitFor();
  if ((await page.evaluate(() => window.shixu.snapshot())).settings.timezone !== 'Asia/Shanghai') throw new Error('Default timezone is not UTC+8');
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
  const headerHeight = await page.locator('.month-weekdays').evaluate(el => el.getBoundingClientRect().bottom);
  if (headerHeight > 145) throw new Error(`Header retains too much blank space: ${headerHeight}`);
  const navSize = await page.getByRole('button', { name: '上一周期', exact: true }).evaluate(el => ({ width: el.getBoundingClientRect().width, height: el.getBoundingClientRect().height }));
  if (navSize.width > 22 || navSize.height > 22) throw new Error('Period navigation buttons are still too large');
  const searchTrigger = page.getByRole('button', { name: '搜索日程', exact: true });
  const listBefore = await page.getByRole('button', { name: '日程列表', exact: true }).boundingBox();
  await searchTrigger.click();
  const searchInput = page.getByRole('textbox', { name: '搜索标题、地点和备注', exact: true });
  await searchInput.waitFor(); await page.waitForTimeout(300);
  const searchBox = await searchInput.boundingBox(), toolbarBox = await page.locator('.toolbar').boundingBox();
  const listAfter = await page.getByRole('button', { name: '日程列表', exact: true }).boundingBox();
  if (await page.locator('.search-bar').count() || searchBox.y < toolbarBox.y || searchBox.y + searchBox.height > toolbarBox.y + toolbarBox.height || listAfter.x >= listBefore.x - 80) throw new Error('Search did not expand left in the toolbar with its neighboring icon');
  if (await page.locator('.month-weekdays').evaluate(el => el.getBoundingClientRect().bottom) !== headerHeight) throw new Error('Opening search moved the calendar vertically');
  await searchInput.fill('普通全天');
  await page.waitForFunction(() => [...document.querySelectorAll('.month-event')].every(el => el.textContent.includes('普通全天')) && document.querySelectorAll('.month-event').length === 1);
  await page.screenshot({ path: '.smoke-data/inline-search.png' });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => !document.querySelector('.inline-search.is-open'));
  await page.keyboard.press('Control+f'); await searchInput.waitFor();
  if (!(await searchInput.evaluate(el => el === document.activeElement))) throw new Error('Ctrl+F did not focus inline search');
  await page.getByRole('button', { name: '关闭搜索', exact: true }).click();
  await page.locator('.month-event').filter({ hasText: '节假日图标' }).waitFor();
  await page.getByRole('button', { name: '2026年10月13日', exact: true }).click();
  await page.getByRole('button', { name: '周', exact: true }).click();
  await page.locator('.fc .calendar-marker').first().waitFor();
  const weekPast = page.locator('.fc .event-timed').filter({ hasText: '过去的普通日程' });
  if (await weekPast.evaluate(el => getComputedStyle(el).opacity) !== '1') throw new Error('Week view still fades past events');
  const weekFill = await weekPast.evaluate(el => ({ color: getComputedStyle(el).backgroundColor, stripe: getComputedStyle(el,'::before').width, height: el.getBoundingClientRect().height, slotHeight: document.querySelector('.fc-timegrid-slot').getBoundingClientRect().height, harness: el.parentElement.getBoundingClientRect().height }));
  if (weekFill.color === 'rgba(0, 0, 0, 0)' || weekFill.stripe !== '3px') throw new Error('Week timed event is missing color fill or left stripe');
  if (weekFill.height < weekFill.harness - 3 || weekFill.height < weekFill.slotHeight * 2 - 3) throw new Error(`One-hour block does not fill its time range: ${JSON.stringify(weekFill)}`);
  await page.screenshot({ path: '.smoke-data/filled-week.png' });
  await weekPast.click();
  await page.locator('.fc-timegrid-event.event-selected').waitFor();
  if ((await page.locator('.editor-panel').textContent()).includes('时区')) throw new Error('Week event editor still shows timezone');
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '2026年10月14日', exact: true }).click();
  await page.getByRole('button', { name: '日', exact: true }).click();
  const dayBlock = page.locator('.fc-timegrid-event.event-timed').filter({ hasText: '过去的普通日程' });
  await dayBlock.waitFor();
  if (await dayBlock.evaluate(el => getComputedStyle(el).backgroundColor) === 'rgba(0, 0, 0, 0)') throw new Error('Day timed event has no fill');
  await dayBlock.click();
  await page.locator('.fc-timegrid-event.event-selected').waitFor();
  await page.screenshot({ path: '.smoke-data/filled-day-selected.png' });
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '周', exact: true }).click();
  await page.locator('.fc-timegrid').waitFor();
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
  await page.getByRole('button', { name: '日历偏好', exact: true }).click();
  const unified = page.getByRole('combobox', { name: '统一时区', exact: true });
  if (await page.getByLabel('日程时区', { exact: true }).count() || await unified.inputValue() !== 'Asia/Shanghai') throw new Error('Unified timezone settings mismatch');
  await unified.selectOption('UTC');
  await page.getByRole('button', { name: '保存日历偏好', exact: true }).click();
  await page.waitForFunction(async () => (await window.shixu.snapshot()).settings.timezone === 'UTC');
  await page.getByRole('button', { name: '关闭面板', exact: true }).click();
  await page.locator('.month-event').filter({ hasText: 'UTC来源日程' }).click();
  if (await editorDateTime(page, '开始') !== '2026-10-15T02:00') throw new Error('Editor does not use unified UTC preference');
  if ((await page.locator('.editor-panel').textContent()).includes('时区') || await page.locator('#timezones').count()) throw new Error('Event editor still exposes timezone controls or text');
  if (await page.locator('.editor-panel .panel-header').count() || await page.locator('.editor-panel input[type="datetime-local"]').count()) throw new Error('Old editor header or combined date-time field remains');
  const editStyle = await page.locator('.reference-event-editor').evaluate(el => ({
    title: getComputedStyle(el.querySelector('.event-title-input')).fontSize,
    body: getComputedStyle(el.querySelector('.event-option-row>span')).fontSize,
    rows: [...el.querySelectorAll('.event-option-row select,.event-option-row input')].map(node => getComputedStyle(node).fontSize),
    separators: [...el.querySelectorAll('.event-options,.event-primary,.event-location-box,.event-calendar-box,.event-notes-box,.panel-footer')].some(node => parseFloat(getComputedStyle(node).borderTopWidth) > 0 || parseFloat(getComputedStyle(node).borderBottomWidth) > 0),
  }));
  if (editStyle.title !== '14px' || editStyle.body !== '12px' || editStyle.rows.some(size => size !== '12px') || editStyle.separators) throw new Error(`Reference editor type/grouping mismatch: ${JSON.stringify(editStyle)}`);
  const eventTitleInput = page.getByRole('textbox', { name: '日程标题', exact: true });
  await eventTitleInput.fill('上午将《西藏全域通信能力建设规划提纲》完善，并与相关单位共同确认下一阶段的详细安排');
  if (await eventTitleInput.evaluate(el => el.scrollWidth > el.clientWidth + 1 || el.getBoundingClientRect().height <= 48)) throw new Error('Long event title does not wrap into multiple lines');
  await page.getByRole('textbox', { name: '日程标题', exact: true }).fill('上午将《西藏全域通信能力建设规划提纲》完善');
  await page.getByRole('combobox', { name: '行程时间', exact: true }).selectOption('30');
  await page.getByRole('button', { name: '开始日期', exact: true }).click();
  const datePicker = page.getByRole('dialog', { name: '选择开始日期', exact: true });
  await datePicker.waitFor();
  if (await datePicker.locator('.event-picker-day').count() !== 42) throw new Error('Date picker does not contain six complete weeks');
  const selectedDate = datePicker.locator('.event-picker-day[aria-pressed="true"]');
  await selectedDate.focus(); await page.keyboard.press('ArrowRight');
  if (await page.evaluate(() => document.activeElement?.getAttribute('data-date')) !== '2026-10-16') throw new Error('Date picker arrow navigation failed');
  await page.keyboard.press('ArrowLeft');
  await page.screenshot({ path: '.smoke-data/reference-editor-datepicker.png' });
  await datePicker.getByRole('button', { name: '日期选择下个月', exact: true }).click();
  if (await page.evaluate(() => document.activeElement?.getAttribute('data-date')) !== '2026-11-01') throw new Error('Month navigation did not retain keyboard access to the date grid');
  await datePicker.getByRole('button', { name: '日期选择上个月', exact: true }).click();

  await page.keyboard.press('Escape');
  await datePicker.waitFor({ state: 'detached' });
  if (!(await page.locator('.editor-panel').isVisible())) throw new Error('Escape from date picker closed the entire editor');
  await page.screenshot({ path: '.smoke-data/reference-editor.png' });
  await setEditorDateTime(page, '开始', '2026-10-15T03:00');
  await setEditorDateTime(page, '结束', '2026-10-15T04:00');
  await page.getByRole('button', { name: '保存日程', exact: true }).click();
  await page.locator('.editor-panel').waitFor({ state: 'detached' });
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '日历偏好', exact: true }).click();
  await unified.selectOption('Asia/Shanghai');
  await page.getByRole('button', { name: '保存日历偏好', exact: true }).click();
  await page.waitForFunction(async () => (await window.shixu.snapshot()).settings.timezone === 'Asia/Shanghai');
  await page.getByRole('button', { name: '关闭面板', exact: true }).click();
  await page.locator('.month-event').filter({ hasText: '上午将《西藏全域通信能力建设规划提纲》完善' }).click();
  if (await editorDateTime(page, '开始') !== '2026-10-15T11:00') throw new Error('UTC event is not displayed in unified UTC+8');
  if (await page.getByRole('combobox', { name: '行程时间', exact: true }).inputValue() !== '30') throw new Error('Travel time did not persist');
  await page.getByRole('textbox', { name: '日程标题', exact: true }).fill('统一时区保留实际时间');
  await page.getByRole('button', { name: '保存日程', exact: true }).click();
  await page.locator('.editor-panel').waitFor({ state: 'detached' });
  const retained = (await page.evaluate(() => window.shixu.events('2026-10-01', '2026-11-01'))).find(event => event.title === '统一时区保留实际时间');
  if (retained?.start !== '2026-10-15T03:00:00.000Z' || retained?.timezone !== 'UTC') throw new Error('Unified display changed source event instant or TZID');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '外观', exact: true }).click();
  await page.getByRole('button', { name: '深色', exact: true }).click();
  await page.getByRole('button', { name: '应用外观', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.theme === 'dark');
  await page.screenshot({ path: '.smoke-data/glass-settings-dark.png' });
  await page.getByRole('button', { name: '关闭面板', exact: true }).click();
  await page.getByRole('button', { name: '2026年10月14日', exact: true }).click();
  await page.getByRole('button', { name: '日', exact: true }).click();
  const darkBlock = page.locator('.fc-timegrid-event.event-timed').filter({ hasText: '过去的普通日程' });
  await darkBlock.waitFor();
  if (await darkBlock.evaluate(el => getComputedStyle(el).backgroundColor) === 'rgba(0, 0, 0, 0)') throw new Error('Dark time block has no color fill');
  await darkBlock.click();
  await page.locator('.fc-timegrid-event.event-selected').waitFor();
  await page.screenshot({ path: '.smoke-data/reference-editor-dark.png' });
  await page.screenshot({ path: '.smoke-data/filled-day-dark.png' });
  await page.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '月', exact: true }).click();
  await page.locator('.month-grid').waitFor();
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '外观', exact: true }).click();
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
  const fold = page.locator('.month-cell[data-date="2026-10-13"]');
  if (await fold.locator('.month-event').count() || (await fold.locator('.month-more').textContent()).trim() !== '+2个') throw new Error('Two events at minimum size must collapse into +2个 alone');
  await fold.locator('.month-more').click();
  if (await page.locator('.day-agenda .agenda-event').count() !== 2) throw new Error('Folded events were not both available');
  await page.getByRole('button', { name: '关闭当天日程', exact: true }).click();
  await page.getByRole('button', { name: '搜索日程', exact: true }).click();
  await searchInput.waitFor(); await page.waitForTimeout(300);
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Inline search overflows minimum window');
  const smallToolbar = await page.locator('.toolbar').boundingBox(), smallSearch = await searchInput.boundingBox();
  if (smallSearch.y + smallSearch.height > smallToolbar.y + smallToolbar.height) throw new Error('Minimum-size search opens below toolbar');
  await page.screenshot({ path: '.smoke-data/inline-search-small.png' });
  await page.getByRole('button', { name: '关闭搜索', exact: true }).click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: '.smoke-data/folded-two-events.png' });
  console.log('PASS: glass settings light/dark/minimum size, grouped navigation, two accounts, all-day icons, no event fading, lunar fonts and hidden header timezone');
} finally {
  await browser?.close().catch(() => {});
  if (app.exitCode === null) app.kill();
  await fixture.close();
}
