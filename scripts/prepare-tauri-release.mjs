import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const config = JSON.parse(await readFile('src-tauri/tauri.release.conf.json', 'utf8'));
const version = config.version;
if (!/^\d+\.\d+\.\d+$/.test(version) || config.bundle?.createUpdaterArtifacts !== true) {
  throw new Error('Release config requires a stable version and updater artifacts');
}
const filename = `${config.productName}_${version}_x64-setup.exe`;
const source = resolve('src-tauri/target/release/bundle/nsis', filename);
const verification = spawnSync('cargo', ['test', '--test', 'update_artifact', '--quiet'], {
  cwd: resolve('src-tauri'),
  env: { ...process.env, SHIXU_UPDATE_ARTIFACT: source },
  stdio: 'inherit',
});
if (verification.status !== 0) throw new Error('Updater signature verification failed');
const signature = (await readFile(`${source}.sig`, 'utf8')).trim();
const signedText = Buffer.from(signature, 'base64').toString('utf8');
if (!signedText.includes(`version:${version}`) || !signedText.includes(`file:${filename}`)) {
  throw new Error('Updater signature metadata does not match the installer');
}
const installer = await readFile(source);
const digest = createHash('sha256').update(installer).digest('hex');
const out = resolve('release-tauri');
await mkdir(out, { recursive: true });
await copyFile(source, join(out, filename));
await writeFile(join(out, `${filename}.sig`), `${signature}\n`);
const notes = `时序日历 ${version}：Tauri 版 Windows 日历，保留 CalDAV 同步、离线日程、提醒与旧版数据迁移。`;
const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms: {
    'windows-x86_64': {
      signature,
      url: `https://github.com/xiaomohaa/shixu-calendar/releases/download/v${version}/${encodeURIComponent(filename)}`,
    },
  },
};
await writeFile(join(out, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
await writeFile(join(out, 'SHA256SUMS.txt'), `${digest}  ${basename(filename)}\n`);
console.log(`Prepared Tauri ${version}: ${filename} (${(await stat(source)).size} bytes), signature, latest.json, SHA256SUMS.txt`);
