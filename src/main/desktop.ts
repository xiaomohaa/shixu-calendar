import { app } from 'electron';
import { dirname, join } from 'node:path';
import { existsSync } from 'node:fs';
import type { AppMode, DesktopState } from '../shared/updates';
import { AppError } from '../shared/errors';

export function appMode(): AppMode {
  if (!app.isPackaged) return 'development';
  if (process.env.PORTABLE_EXECUTABLE_FILE || process.env.PORTABLE_EXECUTABLE_DIR) return 'portable';
  return existsSync(join(dirname(app.getPath('exe')), 'Uninstall 时序日历.exe')) ? 'installer' : 'unpacked';
}
const loginOptions = () => ({ path: app.getPath('exe'), args: ['--hidden'], name: '时序日历' });
export function desktopState(): DesktopState {
  const mode = appMode(), canAutoStart = process.platform === 'win32' && mode === 'installer';
  const login = canAutoStart ? app.getLoginItemSettings(loginOptions()) : null;
  // Electron 45 can report openAtLogin=false for a valid Run entry containing
  // arguments (launchItems.args is empty). Match our own entry and its OS flag.
  const item = login?.launchItems.find(item => item.name === '时序日历' && item.scope === 'user' && item.path.toLowerCase() === app.getPath('exe').toLowerCase());
  return { mode, canAutoStart, openAtLogin: !!item, startupEnabled: !!item?.enabled };
}
export function setAutoStart(enabled: boolean): DesktopState {
  if (!desktopState().canAutoStart) throw new AppError('请安装正式安装版后设置开机自启');
  app.setLoginItemSettings({ ...loginOptions(), openAtLogin: enabled, enabled });
  const state = desktopState();
  if (state.openAtLogin !== enabled) throw new AppError('无法保存开机自启设置，请检查系统权限');
  return state;
}
