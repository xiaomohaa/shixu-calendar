import { chromium } from 'playwright';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

// Captures the real UI with disposable local data. A development identifier is
// required so documentation captures cannot read or overwrite installed data.
const executable = process.env.SHIXU_TAURI_TEST_EXE;
if (!executable) throw new Error('Set SHIXU_TAURI_TEST_EXE to an isolated Tauri UI preview executable first');
const require = createRequire(import.meta.url), output = resolve('docs/screenshots');
const data = resolve('.smoke-data', `readme-${Date.now()}`), fixturePath = resolve('.smoke-data/readme-dav.cjs');
await mkdir(data, { recursive:true }); await mkdir(output, { recursive:true });
await build({ entryPoints:['tests/dav-server.ts'], outfile:fixturePath, bundle:true, platform:'node', format:'cjs' });
const { davServer } = require(fixturePath), fixture = await davServer();
const app = spawn(resolve(executable),[],{ env:{ ...process.env,SHIXU_TAURI_TEST_DATA_DIR:data,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9234' },stdio:'ignore' });
let browser;
try {
  for (let i = 0; i < 40; i++) {
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:9234'); break; }
    catch { await new Promise(resolve => setTimeout(resolve,250)); }
  }
  if (!browser) throw new Error('Documentation preview did not start');
  let page;
  for (let i = 0; i < 40; i++) {
    page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('http://tauri.localhost/'));
    if (page) break; await new Promise(resolve => setTimeout(resolve,250));
  }
  if (!page) throw new Error('Preview page missing');
  await page.locator('.month-grid').waitFor();
  const desktop = await page.evaluate(() => window.shixu.desktopState());
  if (desktop.mode !== 'development') throw new Error('README capture requires a development preview, not the installed app');
  await page.setViewportSize({ width:1280,height:800 });
  await page.clock.setFixedTime(new Date('2026-10-24T02:00:00Z'));
  page.on('dialog', dialog => void dialog.accept());
  const capture = async filename => {
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(200);
    await page.screenshot({ path:resolve(output,filename) });
  };
  const ids = await page.evaluate(async account => {
    const id = await window.shixu.saveAccount({ ...account,name:'演示账户' }); await window.shixu.sync(id);
    const state = await window.shixu.snapshot(), calendar = state.calendars.find(c => c.accountId === id);
    await window.shixu.settings({ ...state.settings,theme:'light',boldText:false,timezone:'Asia/Shanghai',autoSync:false,autoUpdateCheck:false,showAlmanac:false,showSidebarEvents:true });
    await window.shixu.setCalendar(calendar.id,true,'#9254de');
    for (const [title,start,end,allDay,rrule = ''] of [
      ['每周例会','2026-10-05T10:00','2026-10-05T11:00',false,'FREQ=WEEKLY;COUNT=4'],
      ['项目评审','2026-10-19T14:00','2026-10-19T15:30',false],
      ['设计讨论','2026-10-20T14:00','2026-10-20T15:00',false],
      ['整理项目资料','2026-10-20','2026-10-21',true],
      ['客户沟通','2026-10-21T09:00','2026-10-21T10:30',false],
      ['阅读与整理','2026-10-23T19:00','2026-10-23T20:00',false],
      ['团队分享','2026-10-24T10:00','2026-10-24T11:30',false],
      ['记录本周收获','2026-10-24T15:00','2026-10-24T16:00',false],
      ['季度规划','2026-10-26','2026-10-29',true],
      ['交付准备','2026-10-30','2026-10-31',true],
    ]) await window.shixu.saveEvent({ calendarId:calendar.id,title,start,end,allDay,timezone:'Asia/Shanghai',location:'',description:'README 演示数据',rrule,reminder:-1,scope:'series' });
    await window.shixu.sync(id);
    return { account:id,calendar:calendar.id };
  },fixture.account);
  fixture.put('/subscription.ics','BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:readme-holiday\r\nDTSTAMP:20261001T000000Z\r\nDTSTART;VALUE=DATE:20261001\r\nDTEND;VALUE=DATE:20261002\r\nSUMMARY:公共假日（示例）\r\nEND:VEVENT\r\nBEGIN:VEVENT\r\nUID:readme-feed\r\nDTSTAMP:20261001T000000Z\r\nDTSTART;VALUE=DATE:20261023\r\nDTEND;VALUE=DATE:20261024\r\nSUMMARY:订阅日程（示例）\r\nEND:VEVENT\r\nEND:VCALENDAR');
  await page.evaluate(url => window.shixu.importCalendarUrl({ name:'节假日（演示）',url,allowHttp:true }),`${fixture.url}/subscription.ics`);
  await page.evaluate(async accountId => {
    const state = await window.shixu.snapshot(), feed = state.calendars.find(c => c.accountId !== accountId);
    await window.shixu.setCalendar(feed.id,true,'#d273b7');
  },ids.account);
  await page.locator('.month-event').filter({ hasText:'季度规划' }).waitFor();
  await page.waitForFunction(async () => (await window.shixu.snapshot()).pending === 0);
  await page.getByRole('button',{ name:'2026年10月24日',exact:true }).click();
  await capture('month-2.1.png');
  await page.getByRole('button',{ name:'年',exact:true }).click();
  await page.locator('.year-grid').waitFor(); await capture('year-2.1.png');
  await page.getByRole('button',{ name:'2026年10月19日',exact:true }).click();
  await page.getByRole('button',{ name:'周',exact:true }).click();
  await page.locator('.fc-timegrid-event').filter({ hasText:'项目评审' }).waitFor(); await capture('week-2.1.png');
  await page.getByRole('button',{ name:'月',exact:true }).click(); await page.locator('.month-grid').waitFor();
  await page.locator('.month-cell[data-date="2026-10-29"] .month-day-button').dblclick();
  await page.getByRole('textbox',{ name:'日程标题',exact:true }).fill('项目方案讨论与下一阶段安排');
  await page.getByRole('combobox',{ name:'行程时间',exact:true }).selectOption('15');
  await page.getByRole('button',{ name:'开始日期',exact:true }).click();
  await page.locator('.event-date-picker').waitFor(); await capture('editor-2.1.png');
  await page.keyboard.press('Escape'); await page.getByRole('button',{ name:'取消',exact:true }).click();
  await page.getByRole('button',{ name:'设置',exact:true }).click();
  await page.getByRole('button',{ name:'显示设置',exact:true }).click(); await capture('settings-2.1.png');
  await page.getByRole('button',{ name:'关闭面板',exact:true }).click();
  await page.setViewportSize({ width:480,height:360 }); await capture('compact-2.1.png');
  console.log('Captured six current README screenshots using isolated demo data');
} finally {
  await browser?.close().catch(() => {}); if (app.exitCode === null) app.kill(); await fixture.close();
}
