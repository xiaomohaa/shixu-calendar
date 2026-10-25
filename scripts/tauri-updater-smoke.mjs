import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const release = JSON.parse(await readFile('release-tauri/latest.json', 'utf8'));
const installer = resolve('release-tauri', `Shixu-Setup-${release.version}-x64.exe`);
const size = (await stat(installer)).size;
const firstChunk = (await readFile(installer)).subarray(0, 65536);
let artifactMode = 'slow';
let releaseVersion = release.version;
const server = createServer((request, response) => {
  if (request.url === '/latest.json') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ...release, version:releaseVersion, platforms: { 'windows-x86_64': {
      ...release.platforms['windows-x86_64'], url: `http://127.0.0.1:${server.address().port}/${artifactMode}.exe`,
    } } }));
  } else if (request.url === '/slow.exe') {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size });
    response.write(firstChunk);
  } else if (request.url === '/setup.exe') {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream', 'Content-Length': size });
    createReadStream(installer).pipe(response);
  } else if (request.url === '/bad.exe') {
    response.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    response.end('tampered installer');
  } else {
    response.writeHead(404).end();
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const data = resolve('.smoke-data', `tauri-updater-${Date.now()}`);
await mkdir(data, { recursive: true });
const port = 9228;
const app = spawn(resolve(process.env.SHIXU_TAURI_TEST_EXE || 'src-tauri/target/release/shixu-calendar.exe'), [], {
  env: { ...process.env, SHIXU_TAURI_TEST_DATA_DIR: data,
    SHIXU_TAURI_TEST_UPDATE_URL: `http://127.0.0.1:${server.address().port}/latest.json`,
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${port}` },
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
  if ((await page.evaluate(() => window.shixu.updateState())).mode !== 'development') {
    throw new Error('Updater smoke requires the isolated development EXE; run npm run tauri:ui-preview first');
  }
  const dot=page.locator('.settings-button .settings-update-dot');
  if(await dot.count())throw new Error('Update dot appeared before a new release was found');
  await page.evaluate(() => window.shixu.checkForUpdates());
  const available = await page.evaluate(() => window.shixu.updateState());
  if (available.phase !== 'available' || available.release?.version !== release.version) throw new Error(`Update check failed: ${JSON.stringify(available)}`);
  await dot.waitFor();
  await page.getByRole('button',{name:'稍后处理更新',exact:true}).click();
  if(!await dot.isVisible())throw new Error('Dismissing the update banner cleared the settings dot');
  await page.locator('.brand').screenshot({path:'.smoke-data/settings-update-dot.png'});
  await page.getByRole('button',{name:'设置',exact:true}).click();
  const updateItem=page.getByRole('button',{name:'关于与更新',exact:true});
  if(!await updateItem.locator('.nav-update-dot').isVisible())throw new Error('Update settings entry is missing its dot');
  await page.getByRole('button',{name:'通知设置',exact:true}).click();
  await page.getByRole('heading',{name:'通知设置',exact:true}).waitFor();
  await page.getByRole('radio',{name:'系统通知',exact:true}).waitFor();
  await page.getByRole('radio',{name:'macOS 风格悬浮通知',exact:true}).waitFor();
  await page.getByRole('button',{name:'测试通知',exact:true}).waitFor();
  await page.screenshot({path:'.smoke-data/notification-settings-page.png'});
  await page.getByRole('button',{name:'启动与后台',exact:true}).click();
  if(await page.getByRole('radio',{name:'系统通知',exact:true}).count()||await page.getByRole('button',{name:'测试通知',exact:true}).count())throw new Error('Notification controls were duplicated in startup settings');
  await page.getByRole('button',{name:'关闭面板',exact:true}).click();
  if(!await dot.isVisible())throw new Error('Opening settings cleared the update dot');
  releaseVersion=available.currentVersion;
  await page.evaluate(()=>window.shixu.checkForUpdates());
  await dot.waitFor({state:'detached'});
  if((await page.evaluate(()=>window.shixu.updateState())).phase!=='current')throw new Error('Current release did not clear update indicator');
  releaseVersion=release.version;await page.evaluate(()=>window.shixu.checkForUpdates());await dot.waitFor();
  const download = page.evaluate(() => window.shixu.downloadUpdate());
  await page.waitForFunction(async () => (await window.shixu.updateState()).progress?.transferred > 0);
  if(!await dot.isVisible())throw new Error('Update dot vanished while downloading');
  await page.evaluate(() => window.shixu.cancelUpdateDownload());
  await download;
  const cancelled = await page.evaluate(() => window.shixu.updateState());
  if (cancelled.phase !== 'available') throw new Error(`Update cancellation failed: ${JSON.stringify(cancelled)}`);
  if(!await dot.isVisible())throw new Error('Cancelling the download cleared update indicator');
  artifactMode = 'bad';
  await page.evaluate(() => window.shixu.checkForUpdates());
  const tamperedRejected = await page.evaluate(async () => {
    try { await window.shixu.downloadUpdate(); return false; }
    catch (error) { return String(error).includes('签名'); }
  });
  if (!tamperedRejected || (await page.evaluate(() => window.shixu.updateState())).phase !== 'error') {
    throw new Error('Tampered update was not rejected');
  }
  if(!await dot.isVisible())throw new Error('Failed download hid a known update');
  artifactMode = 'setup';
  await page.evaluate(() => window.shixu.checkForUpdates());
  await page.evaluate(() => window.shixu.downloadUpdate());
  const downloaded = await page.evaluate(() => window.shixu.updateState());
  if (downloaded.phase !== 'downloaded' || downloaded.release?.version !== release.version) throw new Error(`Signed update download failed: ${JSON.stringify(downloaded)}`);
  if(!await dot.isVisible())throw new Error('Ready-to-install update lost its indicator');
  console.log('PASS: real updater-driven settings dots, independent notification settings, up-to-date reset, banner dismissal, progress, cancel, signature rejection, retry, signed download');
} finally {
  await browser?.close().catch(() => {});
  app.kill();
  await new Promise(resolve => server.close(resolve));
}
