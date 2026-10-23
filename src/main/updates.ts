import { autoUpdater, CancellationToken, type UpdateInfo } from 'electron-updater';
import { UpdateController, type UpdateDriver } from './update-controller';
import type { AppMode, UpdateRelease, UpdateState } from '../shared/updates';

function release(info: UpdateInfo): UpdateRelease {
  const notes = Array.isArray(info.releaseNotes) ? info.releaseNotes.map(n => `${n.version}\n${n.note || ''}`).join('\n\n') : info.releaseNotes || '';
  // Render as plain text, never evaluate release HTML in the renderer.
  return { version: info.version, date: info.releaseDate || null, notes: notes.replace(/<[^>]*>/g, '').slice(0, 20000) };
}
export function createUpdates(version: string, mode: AppMode, changed: (state: UpdateState) => void, prepare: () => Promise<void>) {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.autoRunAppAfterInstall = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.disableWebInstaller = true;
  autoUpdater.logger = null;
  let token: CancellationToken | null = null;
  const driver: UpdateDriver = {
    async check() { const result = await autoUpdater.checkForUpdates(); if (!result) throw new Error('Update unavailable'); return result.isUpdateAvailable ? release(result.updateInfo) : null; },
    async download(progress) {
      const currentToken = new CancellationToken(); token = currentToken;
      autoUpdater.on('download-progress', progress);
      try { await autoUpdater.downloadUpdate(currentToken); }
      finally { autoUpdater.removeListener('download-progress', progress); currentToken.dispose(); token = null; }
    },
    cancel() { token?.cancel(); },
    install() { autoUpdater.quitAndInstall(true, true); },
  };
  const controller = new UpdateController(version, mode, driver, changed, prepare);
  // electron-updater also emits errors; prevent an unhandled EventEmitter error.
  autoUpdater.on('error', error => controller.failInstall(error));
  return controller;
}
