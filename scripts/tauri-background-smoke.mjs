import { chromium } from 'playwright';
import { build } from 'esbuild';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const data = resolve('.smoke-data', `tauri-background-${Date.now()}`);
await mkdir(data, { recursive: true });
const fixturePath = resolve('.smoke-data/dav-fixture-tauri.cjs');
await build({ entryPoints: ['tests/dav-server.ts'], outfile: fixturePath, bundle: true, platform: 'node', format: 'cjs' });
const { davServer, fixtureIcs } = require(fixturePath);
const fixture = await davServer();
const stamp = date => date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
const start = new Date(Date.now() + 75000), end = new Date(start.getTime() + 3600000);
const reminderIcs = `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nBEGIN:VEVENT\r\nUID:background-reminder\r\nDTSTAMP:${stamp(new Date())}\r\nDTSTART:${stamp(start)}\r\nDTEND:${stamp(end)}\r\nSUMMARY:后台提醒测试\r\nBEGIN:VALARM\r\nACTION:DISPLAY\r\nDESCRIPTION:后台提醒测试\r\nTRIGGER:-PT1M\r\nEND:VALARM\r\nEND:VEVENT\r\nEND:VCALENDAR`;
fixture.put('/home/personal/reminder.ics', reminderIcs);
const port = 9227;
const app = spawn(resolve('src-tauri/target/release/shixu-calendar.exe'), [], {
  env: { ...process.env, SHIXU_TAURI_TEST_DATA_DIR: data, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` }, stdio: 'ignore',
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
  const id = await page.evaluate(account => window.shixu.saveAccount(account), fixture.account);
  await page.evaluate(id => window.shixu.sync(id), id);
  fixture.put('/home/personal/background.ics', fixtureIcs('后台同步测试'));
  const native = `[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);`;
  execFileSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -Namespace ShixuSmoke -Name Win -MemberDefinition '${native}'; $p = Get-Process -Id ${app.pid}; if ($p.MainWindowHandle -eq [System.IntPtr]::Zero) { throw 'No window' }; $null = [ShixuSmoke.Win]::PostMessage($p.MainWindowHandle,16,[System.IntPtr]::Zero,[System.IntPtr]::Zero)`]);
  await new Promise(resolve => setTimeout(resolve, 36000));
  if (app.exitCode !== null) throw new Error('Tauri exited while hidden in tray');
  const db = new DatabaseSync(join(data, 'calendar.db'));
  const counts = db.prepare('SELECT (SELECT COUNT(*) FROM event_resources) resources,(SELECT COUNT(*) FROM sync_state) tokens,(SELECT COUNT(*) FROM accounts WHERE lastSync IS NOT NULL) synced,(SELECT COUNT(*) FROM reminders) reminders').get();
  const pulled = db.prepare('SELECT ics FROM event_resources WHERE url LIKE ?').get('%/background.ics');
  db.close();
  if (counts.resources !== 2 || counts.tokens !== 1 || counts.synced !== 1 || !pulled?.ics.includes('后台同步测试') || counts.reminders !== 1) throw new Error(`Background sync/reminder failed: ${JSON.stringify(counts)}`);
  console.log('PASS: hidden Tauri window retained background CalDAV sync and scheduled reminder');
} finally {
  await browser?.close().catch(() => {});
  app.kill();
  await fixture.close();
}
