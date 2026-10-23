import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, stat } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const installer = resolve('release-tauri/时序日历 2_2.0.0_x64-setup.exe');
const release = JSON.parse(await readFile('release-tauri/latest.json', 'utf8'));
const size = (await stat(installer)).size;
const firstChunk = (await readFile(installer)).subarray(0, 65536);
let artifactMode = 'slow';
const server = createServer((request, response) => {
  if (request.url === '/latest.json') {
    response.setHeader('Content-Type', 'application/json');
    response.end(JSON.stringify({ ...release, platforms: { 'windows-x86_64': {
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
const app = spawn(resolve('src-tauri/target/release/shixu-calendar.exe'), [], {
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
  await page.evaluate(() => window.shixu.checkForUpdates());
  const available = await page.evaluate(() => window.shixu.updateState());
  if (available.phase !== 'available' || available.release?.version !== '2.0.0') throw new Error(`Update check failed: ${JSON.stringify(available)}`);
  const download = page.evaluate(() => window.shixu.downloadUpdate());
  await page.waitForFunction(async () => (await window.shixu.updateState()).progress?.transferred > 0);
  await page.evaluate(() => window.shixu.cancelUpdateDownload());
  await download;
  const cancelled = await page.evaluate(() => window.shixu.updateState());
  if (cancelled.phase !== 'available') throw new Error(`Update cancellation failed: ${JSON.stringify(cancelled)}`);
  artifactMode = 'bad';
  await page.evaluate(() => window.shixu.checkForUpdates());
  const tamperedRejected = await page.evaluate(async () => {
    try { await window.shixu.downloadUpdate(); return false; }
    catch (error) { return String(error).includes('签名'); }
  });
  if (!tamperedRejected || (await page.evaluate(() => window.shixu.updateState())).phase !== 'error') {
    throw new Error('Tampered update was not rejected');
  }
  artifactMode = 'setup';
  await page.evaluate(() => window.shixu.checkForUpdates());
  await page.evaluate(() => window.shixu.downloadUpdate());
  const downloaded = await page.evaluate(() => window.shixu.updateState());
  if (downloaded.phase !== 'downloaded' || downloaded.release?.version !== '2.0.0') throw new Error(`Signed update download failed: ${JSON.stringify(downloaded)}`);
  console.log('PASS: Tauri updater check, progress, cancel, signature rejection, retry, signed download');
} finally {
  await browser?.close().catch(() => {});
  app.kill();
  await new Promise(resolve => server.close(resolve));
}
