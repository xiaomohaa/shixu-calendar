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
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool ShowWindow(System.IntPtr h, int n);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool IsIconic(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("user32.dll")] public static extern bool SetWindowPos(System.IntPtr h, System.IntPtr a, int x, int y, int w, int hgt, uint flags);`;
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
  await page.getByRole('checkbox', { name: '显示黄历', exact: true }).uncheck();
  await page.waitForFunction(() => !document.querySelector('.almanac'));
  if ((await page.evaluate(() => window.shixu.snapshot())).settings.showAlmanac !== false) throw new Error('Almanac preference was not persisted');
  if (!(await page.evaluate(() => window.shixu.snapshot())).settings.boldText) throw new Error('Bold preference was not saved');
  const boldWeight = await page.locator('.month-weekdays span').first().evaluate(el => Number(getComputedStyle(el).fontWeight));
  if (boldWeight < 650 || boldWeight <= initialWeight) throw new Error('Bold preference did not increase the rendered font weight');
  await page.reload();
  await page.locator('.month-grid').waitFor();
  await page.waitForFunction(() => document.documentElement.dataset.boldText === 'true');
  await page.getByRole('button', { name: '设置', exact: true }).click();
  await page.getByRole('button', { name: '显示设置', exact: true }).click();
  if (!(await page.getByRole('checkbox', { name: '启用粗体显示' }).isChecked())) throw new Error('Saved bold preference was lost after reload');
  if (await page.getByRole('checkbox', { name: '显示黄历', exact: true }).isChecked()) throw new Error('Almanac preference was lost after reload');
  await page.getByRole('checkbox', { name: '显示黄历', exact: true }).check();
  await page.locator('.almanac').waitFor({ state: 'attached' });
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
  const chromeStyle = await page.evaluate(() => ({
    top: getComputedStyle(document.querySelector('.window-chrome')).backgroundColor,
    toolbar: getComputedStyle(document.querySelector('.toolbar')).backgroundColor,
    heading: getComputedStyle(document.querySelector('.calendar-heading')).backgroundColor,
    radius: getComputedStyle(document.querySelector('.desktop-window')).borderTopLeftRadius,
  }));
  if (chromeStyle.top !== chromeStyle.toolbar || chromeStyle.top !== chromeStyle.heading || chromeStyle.radius !== '24px') throw new Error('Window surface color or corner radius mismatch');
  if (await page.getByRole('button', { name: /展开侧边栏|收起侧边栏|打开设置/ }).count()) throw new Error('Removed toolbar controls are still present');
  const normalFonts = await page.locator('.month-cell .solar-date').first().evaluate(el => getComputedStyle(el).fontSize);
  await page.getByRole('button', { name: '最大化窗口', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.maximized === 'true');
  await page.getByRole('button', { name: '还原窗口', exact: true }).click();
  await page.waitForFunction(() => document.documentElement.dataset.maximized === 'false');
  const activeHandle = native(`(Get-Process -Id ${app.pid}).MainWindowHandle.ToInt64()`);
  await page.getByRole('button', { name: '最小化窗口', exact: true }).click();
  const minimized = native(`$h = [System.IntPtr]::new(${activeHandle}); [ShixuSmoke.Win]::IsIconic($h)`);
  if (minimized !== 'True') throw new Error('Custom minimize button did not minimize the native window');
  native(`$h = [System.IntPtr]::new(${activeHandle}); $null = [ShixuSmoke.Win]::ShowWindow($h,9)`);
  native(`$h = (Get-Process -Id ${app.pid}).MainWindowHandle; $null = [ShixuSmoke.Win]::SetWindowPos($h,[System.IntPtr]::Zero,0,0,480,360,6)`);
  await page.waitForFunction(() => innerWidth < 700 && innerHeight < 500);
  if (await page.locator('.month-cell').count() !== 42) throw new Error('Small window lost month dates');
  const calendarFits = await page.locator('.month-grid').evaluate(el => {
    const area = el.getBoundingClientRect();
    return [...el.querySelectorAll('.month-day-button')].every(cell => { const r = cell.getBoundingClientRect(); return r.top >= area.top - 1 && r.bottom <= area.bottom + 1; }) && el.scrollHeight <= el.clientHeight + 1;
  });
  if (!calendarFits) throw new Error('Small window requires scrolling to see all dates');
  if (await page.locator('.month-cell .solar-date').first().evaluate(el => getComputedStyle(el).fontSize) !== normalFonts) throw new Error('Calendar font size changed after resizing');
  if (await page.locator('.month-holiday, .day-status').count()) throw new Error('Built-in holiday or adjustment badges are still present');
  if (await page.locator('.month-cell .lunar-date').count() !== 42) throw new Error('Lunar dates are missing');
  await page.locator('.sidebar-reveal-edge').hover();
  await page.waitForFunction(() => document.querySelector('.app-shell').classList.contains('sidebar-overlay'));
  if (!(await page.getByRole('button', { name: '设置', exact: true }).isVisible())) throw new Error('Settings inaccessible in automatic narrow sidebar');
  await page.mouse.move(460, 150);
  await page.waitForFunction(() => document.querySelector('.app-shell').classList.contains('sidebar-collapsed'));
  const search = page.getByRole('button', { name: '搜索日程', exact: true });
  const searchShape = await search.evaluate(el => ({ width: el.clientWidth, height: el.clientHeight }));
  if (Math.abs(searchShape.width - searchShape.height) > 1) throw new Error('Search button is not circular');
  await search.click();
  await page.getByRole('textbox', { name: '搜索标题、地点和备注', exact: true }).waitFor();
  await page.getByRole('button', { name: '关闭搜索', exact: true }).click();
  if (await page.evaluate(() => document.documentElement.scrollWidth > innerWidth)) throw new Error('Small window has horizontal page overflow');
  await page.screenshot({ path: '.smoke-data/small-window.png' });
  native(`$h = (Get-Process -Id ${app.pid}).MainWindowHandle; $null = [ShixuSmoke.Win]::SetWindowPos($h,[System.IntPtr]::Zero,0,0,1380,900,6)`);
  await page.waitForFunction(() => innerWidth > 1000);
  const nativeHandle = native(`(Get-Process -Id ${app.pid}).MainWindowHandle.ToInt64()`);
  await page.getByRole('button', { name: '关闭窗口', exact: true }).click();
  await page.waitForTimeout(500);
  const first = `${nativeHandle},${native(`$h = [System.IntPtr]::new(${nativeHandle}); [ShixuSmoke.Win]::IsWindowVisible($h)`)}`;
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
  console.log('PASS: almanac preference, fixed fonts, all dates visible, automatic sidebar, unified rounded window, native window controls, CSP and tray lifecycle');
} finally {
  await browser?.close().catch(() => {});
  if (app.exitCode === null) app.kill();
}
