import { chromium } from 'playwright';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';

const data = resolve('.smoke-data', `tauri-desktop-${Date.now()}`);
await mkdir(data, { recursive: true });
const port = 9225;
const app = spawn(resolve('src-tauri/target/release/shixu-calendar.exe'), [], {
  env: { ...process.env, SHIXU_TAURI_TEST_DATA_DIR: data, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
  stdio: 'ignore',
});
const winApi = `[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool PostMessage(System.IntPtr h, uint m, System.IntPtr w, System.IntPtr l);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsWindowVisible(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int n);`;
const native = command => execFileSync('powershell.exe', ['-NoProfile', '-Command', `Add-Type -Namespace ShixuSmoke -Name Win -MemberDefinition '${winApi}'; ${command}`], { encoding: 'utf8' }).trim();
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
  const initialWeight = await page.locator('.month-weekdays span').first().evaluate(el => Number(getComputedStyle(el).fontWeight));
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '显示设置', exact: true }).click();
  await page.getByRole('checkbox', { name: '启用粗体显示' }).check();
  await page.waitForFunction(() => document.documentElement.dataset.boldText === 'true');
  if (!(await page.evaluate(() => window.shixu.snapshot())).settings.boldText) throw new Error('Bold preference was not saved');
  const boldWeight = await page.locator('.month-weekdays span').first().evaluate(el => Number(getComputedStyle(el).fontWeight));
  if (boldWeight < 650 || boldWeight <= initialWeight) throw new Error('Bold preference did not increase the rendered font weight');
  await page.reload();
  await page.locator('.month-grid').waitFor();
  await page.waitForFunction(() => document.documentElement.dataset.boldText === 'true');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '显示设置', exact: true }).click();
  if (!(await page.getByRole('checkbox', { name: '启用粗体显示' }).isChecked())) throw new Error('Saved bold preference was lost after reload');
  await page.getByRole('checkbox', { name: '启用粗体显示' }).uncheck();
  await page.waitForFunction(() => document.documentElement.dataset.boldText === 'false');
  const restoredWeight = await page.locator('.month-weekdays span').first().evaluate(el => Number(getComputedStyle(el).fontWeight));
  if (restoredWeight !== initialWeight) throw new Error('Disabling bold did not restore the original font weight');
  await page.getByRole('button', { name: '关闭面板', exact: true }).click();
  const inlineScriptRan = await page.evaluate(() => {
    const script = document.createElement('script');
    script.textContent = 'window.__shixuCspProbe = true';
    document.body.append(script);
    return window.__shixuCspProbe === true;
  });
  if (inlineScriptRan) throw new Error('Tauri CSP allowed an unexpected inline script');
  const first = native(`$p = Get-Process -Id ${app.pid}; $h = $p.MainWindowHandle; if ($h -eq [System.IntPtr]::Zero) { throw 'No main window' }; $null = [ShixuSmoke.Win]::PostMessage($h,16,[System.IntPtr]::Zero,[System.IntPtr]::Zero); Start-Sleep -Milliseconds 700; Write-Output ($h.ToInt64().ToString() + ',' + [ShixuSmoke.Win]::IsWindowVisible($h).ToString())`);
  const [handle, visible] = first.split(',');
  if (visible !== 'False' || app.exitCode !== null) throw new Error(`Close-to-tray failed: ${first}`);
  const second = spawn(resolve('src-tauri/target/release/shixu-calendar.exe'), [], {
    env: { ...process.env, SHIXU_TAURI_TEST_DATA_DIR: data }, stdio: 'ignore',
  });
  await Promise.race([
    new Promise(resolve => second.once('exit', resolve)),
    new Promise((_, reject) => setTimeout(() => reject(new Error('Second instance did not exit')), 5000)),
  ]);
  const singleInstanceVisible = native(`$h = [System.IntPtr]::new(${handle}); [ShixuSmoke.Win]::IsWindowVisible($h)`);
  if (singleInstanceVisible !== 'True') throw new Error('Second launch did not focus the existing window');
  const snapshot = await page.evaluate(() => window.shixu.snapshot());
  if (!snapshot.settings.closeToTray) throw new Error('Close-to-tray default changed');
  const reopened = native(`$h = [System.IntPtr]::new(${handle}); $null = [ShixuSmoke.Win]::ShowWindow($h,5); Start-Sleep -Milliseconds 400; [ShixuSmoke.Win]::IsWindowVisible($h)`);
  if (reopened !== 'True') throw new Error('Native window did not reopen');
  await page.evaluate(async () => { const state = await window.shixu.snapshot(); await window.shixu.settings({ ...state.settings, closeToTray: false }); });
  const exited = new Promise(resolve => app.once('exit', resolve));
  native(`$h = [System.IntPtr]::new(${handle}); $null = [ShixuSmoke.Win]::PostMessage($h,16,[System.IntPtr]::Zero,[System.IntPtr]::Zero)`);
  await Promise.race([exited, new Promise((_, reject) => setTimeout(() => reject(new Error('Window close did not quit app')), 5000))]);
  console.log('PASS: bold display UI, persistence, restoration, CSP, single instance and tray lifecycle');
} finally {
  await browser?.close().catch(() => {});
  if (app.exitCode === null) app.kill();
}
