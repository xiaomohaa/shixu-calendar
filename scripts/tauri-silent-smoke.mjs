import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const data = resolve('.smoke-data', `tauri-silent-${Date.now()}`);
await mkdir(data, { recursive: true });
const exe = resolve('src-tauri/target/release/shixu-calendar.exe');
let app, browser, page;
const visible = () => page.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:window|is_visible', { label: 'main' }));
async function launch(args = []) {
  app = spawn(exe, args, { env: { ...process.env, SHIXU_TAURI_TEST_DATA_DIR: data, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9228' }, stdio: 'ignore' });
  for (let i = 0; i < 40; i++) {
    try { browser = await chromium.connectOverCDP('http://127.0.0.1:9228'); break; }
    catch { await new Promise(resolve => setTimeout(resolve, 250)); }
  }
  if (!browser) throw new Error('Silent launch did not start WebView2');
  page = undefined;
  for (let i = 0; i < 40; i++) {
    page = browser.contexts().flatMap(c => c.pages()).find(p => p.url().startsWith('http://tauri.localhost/'));
    if (page) break;
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  if (!page) throw new Error('Silent launch page missing');
  await page.waitForFunction(() => !!window.shixu);
  await page.evaluate(() => window.shixu.snapshot());
}
async function quit() {
  const exited = new Promise(resolve => app.once('exit', resolve));
  await page.evaluate(() => window.shixu.quitApp()).catch(() => {});
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('Silent test application did not exit')), 5000))]);
  await browser.close().catch(() => {}); browser = undefined;
}
try {
  await launch();
  if (!(await visible())) throw new Error('Default startup should show the window');
  await page.evaluate(async () => { const s = await window.shixu.snapshot(); await window.shixu.settings({ ...s.settings, silentStartup: true }); });
  await quit();
  await launch();
  if (await visible()) throw new Error('Persisted silent startup showed the window');
  await page.waitForTimeout(1200);
  if (await visible()) throw new Error('Silent window appeared after initialization');
  const second = spawn(exe, [], { env: { ...process.env, SHIXU_TAURI_TEST_DATA_DIR: data }, stdio: 'ignore' });
  await Promise.race([new Promise(resolve => second.once('exit', resolve)), new Promise((_, reject) => setTimeout(() => reject(new Error('Second instance remained running')), 5000))]);
  if (!(await visible())) throw new Error('Second launch did not reveal silent app');
  await page.evaluate(async () => { const s = await window.shixu.snapshot(); await window.shixu.settings({ ...s.settings, silentStartup: false }); });
  await quit();
  await launch(['--hidden']);
  if (await visible()) throw new Error('Login --hidden argument was ignored');
  await quit();
  await launch();
  if (!(await visible())) throw new Error('Disabling silent startup did not restore normal startup');
  await quit();
  console.log('PASS: silent startup persisted, remained hidden, second instance revealed it, --hidden login preserved, normal startup restored');
} finally {
  await browser?.close().catch(() => {});
  if (app?.exitCode === null) app.kill();
}
