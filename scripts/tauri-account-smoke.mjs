import { chromium } from 'playwright';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const data = resolve('.smoke-data', `tauri-account-${Date.now()}`);
await mkdir(data, { recursive: true });
const fixturePath = resolve('.smoke-data/dav-fixture-tauri.cjs');
await build({ entryPoints: ['tests/dav-server.ts'], outfile: fixturePath, bundle: true, platform: 'node', format: 'cjs' });
const { davServer } = require(fixturePath);
const fixture = await davServer();
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
    const snapshot = await window.shixu.snapshot();
    return { discovered: calendars.length, id, accounts: snapshot.accounts.length, calendars: snapshot.calendars.length,
      leaked: JSON.stringify(snapshot).includes(account.password), calendarName: snapshot.calendars[0]?.name,
      renamed: snapshot.accounts[0]?.name === '已重命名账户', rejected401 };
  }, fixture.account);
  const db = new DatabaseSync(join(data, 'calendar.db'));
  const ciphertext = db.prepare('SELECT password FROM accounts WHERE id=?').get(report.id)?.password;
  db.close();
  if (report.discovered !== 1 || report.accounts !== 1 || report.calendars !== 1 || report.calendarName !== '个人日历' || !report.renamed || !report.rejected401 || report.leaked || !ciphertext?.startsWith('dpapi:v1:')) {
    throw new Error(`Tauri account regression: ${JSON.stringify({ ...report, encrypted: !!ciphertext })}`);
  }
  console.log('PASS: Tauri DAV discovery, account transaction, DPAPI ciphertext, password-free IPC');
} finally {
  await browser?.close();
  app.kill();
  await fixture.close();
}
