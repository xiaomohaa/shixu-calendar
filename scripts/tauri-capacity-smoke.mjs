import { chromium } from 'playwright';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url), data = resolve('.smoke-data', `tauri-capacity-${Date.now()}`);
await mkdir(data, { recursive: true });
const fixturePath = resolve('.smoke-data/capacity-dav.cjs');
await build({ entryPoints:['tests/dav-server.ts'], outfile:fixturePath, bundle:true, platform:'node', format:'cjs' });
const { davServer } = require(fixturePath), fixture = await davServer();
const app = spawn(resolve(process.env.SHIXU_TAURI_TEST_EXE || 'src-tauri/target/release/shixu-calendar.exe'), [], {
  env:{ ...process.env, SHIXU_TAURI_TEST_DATA_DIR:data, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9233' }, stdio:'ignore',
});
let browser;
try {
  for (let attempt = 0; attempt < 40; attempt++) {
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:9233'); break; }
    catch { await new Promise(resolve => setTimeout(resolve,250)); }
  }
  if (!browser) throw new Error('Capacity Tauri window missing');
  let page;
  for (let attempt = 0; attempt < 40; attempt++) {
    page = browser.contexts().flatMap(context => context.pages()).find(page => page.url().startsWith('http://tauri.localhost/'));
    if (page) break; await new Promise(resolve => setTimeout(resolve,250));
  }
  if (!page) throw new Error('Capacity page missing');
  await page.locator('.month-grid').waitFor();
  await page.evaluate(async account => {
    const id = await window.shixu.saveAccount(account); await window.shixu.sync(id);
    const state = await window.shixu.snapshot(), calendar = state.calendars.find(calendar => calendar.accountId === id);
    await window.shixu.settings({ ...state.settings, theme:'light', autoSync:false, autoUpdateCheck:false, timezone:'Asia/Shanghai' });
    for (const [day,count] of [[20,3],[21,4],[22,9],[24,2]]) {
      for (let index = 0; index < count; index++) {
        const date = `2026-10-${day}`;
        await window.shixu.saveEvent({ calendarId:calendar.id, title:`${day}日第${index + 1}项`, start:index === 0 ? date : `${date}T${String(index + 8).padStart(2,'0')}:00`, end:index === 0 ? `2026-10-${day + 1}` : `${date}T${String(index + 9).padStart(2,'0')}:00`, allDay:index === 0, timezone:'Asia/Shanghai', location:'', description:'', rrule:'', reminder:-1, scope:'series' });
      }
    }
  }, fixture.account);
  await page.locator('.month-cell[data-date="2026-10-20"] .month-event').first().waitFor();
  const samples = [];
  for (const height of [360,480,600,612,720,1200,1600,612,360]) {
    await page.setViewportSize({ width:1380,height });
    await page.waitForTimeout(120);
    const rendered = await page.evaluate(() => {
      const grid = document.querySelector('.month-grid'), capacity = Number(grid.dataset.eventCapacity);
      const cells = [20,21,22,24].map(day => {
        const cell = document.querySelector(`.month-cell[data-date="2026-10-${day}"]`), rect = cell.getBoundingClientRect();
        const events = [...cell.querySelectorAll('.month-event')], more = cell.querySelector('.month-more');
        const controls = [...events,...(more ? [more] : [])];
        return { day, row:rect.height, visible:events.length, more:more?.textContent ?? '', fit:controls.every(control => control.getBoundingClientRect().bottom <= rect.bottom - 1 + .05) };
      });
      return { height:innerHeight, capacity, cells, allDates:grid.querySelectorAll('.month-day-button').length, noScroll:grid.scrollHeight <= grid.clientHeight + 1 };
    });
    for (const cell of rendered.cells) {
      const count = ({ 20:3,21:4,22:9,24:2 })[cell.day];
      const expected = count <= rendered.capacity ? count : Math.max(0,rendered.capacity - 1);
      const hidden = count - expected;
      if (!cell.fit || cell.visible !== expected || cell.more !== (hidden ? `+${hidden}个` : '')) throw new Error(`Premature fold or clipping: ${JSON.stringify(rendered)}`);
    }
    if (rendered.allDates !== 42 || !rendered.noScroll) throw new Error('Capacity change lost dates or introduced scrolling');
    if (height === 600 || height === 612) {
      if (rendered.cells[0].visible !== 3 || rendered.cells[0].more) throw new Error(`20日 three rows still collapse: ${JSON.stringify(rendered)}`);
      await page.screenshot({ path:`.smoke-data/capacity-${height}.png` });
    }
    if (height === 1600 && (rendered.capacity <= 5 || rendered.cells[2].visible !== 9)) throw new Error('Tall calendar still caps event count at five');
    samples.push({ height,capacity:rendered.capacity,row:rendered.cells[0].row });
  }
  const twentyFourth = page.locator('.month-cell[data-date="2026-10-24"]');
  if (await twentyFourth.locator('.month-more').textContent() !== '+2个') throw new Error('One-line +2个 behavior changed');
  await twentyFourth.locator('.month-more').click();
  if (await page.locator('.day-agenda .agenda-event').count() !== 2) throw new Error('Folded events missing from agenda');
  console.log(`PASS: actual cell capacity, no premature fold/clipping, resize restoration, tall calendar and one-line overflow ${JSON.stringify(samples)}`);
} finally {
  await browser?.close().catch(() => {});
  if (app.exitCode === null) app.kill();
  await fixture.close();
}
