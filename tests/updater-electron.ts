// Isolated real electron-updater transport test. Fixture executables are never run.
import { app } from 'electron';
import { NsisUpdater, CancellationToken } from 'electron-updater';
import { ElectronHttpExecutor } from 'electron-updater/out/electronHttpExecutor';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
const config = JSON.parse(readFileSync(process.argv[2], 'utf8')) as { root: string; url: string; sha512: string };
app.setPath('userData', config.root);
const results: string[] = [];
const check = (value: unknown, name: string) => { if (!value) throw new Error(name); results.push(name); };
function updater(test: string) {
  const dir = join(config.root, test); mkdirSync(dir, { recursive: true });
  const configPath = join(dir, 'app-update.yml');
  writeFileSync(configPath, `provider: generic\nurl: ${config.url}/${test}/\nupdaterCacheDirName: fixture-cache\n`);
  const adapter = { version: '1.2.0', name: 'shixu-updater-test', isPackaged: true, appUpdateConfigPath: configPath, userDataPath: dir, baseCachePath: dir,
    whenReady: async () => {}, relaunch: () => { throw new Error('Test must not launch installers'); }, quit: () => { throw new Error('Test must not quit for install'); }, onQuit: () => {} };
  const u = new NsisUpdater(null, adapter); Object.assign(u, { httpExecutor: new ElectronHttpExecutor() }); u.logger = null;
  u.autoDownload = false; u.autoInstallOnAppQuit = false; u.disableDifferentialDownload = true; u.disableWebInstaller = true;
  u.on('error', () => {});
  return u;
}
async function run() {
await app.whenReady();
try {
  const valid = updater('valid');
  const found = await valid.checkForUpdates();
  check(found?.isUpdateAvailable && found.updateInfo.version === '1.2.1', '真实 HTTP 元数据发现更高版本');
  let downloaded = 0, progress = 0;
  valid.on('update-downloaded', () => downloaded++); valid.on('download-progress', () => progress++);
  const paths = await valid.downloadUpdate();
  check(downloaded === 1 && createHash('sha512').update(readFileSync(paths[0])).digest('base64') === config.sha512, '真实下载完成且 SHA512 正确，触发就绪事件');
  check(progress > 0, '真实网络下载触发进度事件');
  const broken = updater('broken'); await broken.checkForUpdates(); let failure = ''; let unsafe = false;
  broken.on('update-downloaded', () => { unsafe = true; });
  try { await broken.downloadUpdate(); } catch (e) { failure = (e as Error).message; }
  check(/sha512|checksum/i.test(failure) && !unsafe, '篡改下载文件被拒绝且不触发就绪事件');
  const cancelled = updater('cancel'); await cancelled.checkForUpdates(); const token = new CancellationToken(); let completed = false;
  cancelled.on('update-downloaded', () => { completed = true; });
  const timeout = setTimeout(() => token.cancel(), 250);
  let aborted = false; try { await cancelled.downloadUpdate(token); } catch { aborted = true; } finally { clearTimeout(timeout); token.dispose(); }
  check(aborted && !completed, '真实 HTTP 下载可取消，未标记为完成');
  await cancelled.downloadUpdate(); check(completed, '取消后可重新下载并校验成功');
  writeFileSync(join(config.root, 'result.json'), JSON.stringify({ results, errors: [] }, null, 2));
  app.exit(0);
} catch (error) { writeFileSync(join(config.root, 'result.json'), JSON.stringify({ results, errors: [(error as Error).stack] }, null, 2)); app.exit(1); }
}
void run();
