import { contextBridge, ipcRenderer } from 'electron';
import type { Api, Result } from '../shared/contracts';
const call = async <T>(method: string, ...args: unknown[]): Promise<T> => { const result = await ipcRenderer.invoke('shixu:call', method, args) as Result<T>; if (!result.ok) throw new Error(result.error); return result.value; };
const api: Api = {
  updateState: () => call('updateState'), checkForUpdates: () => call('checkForUpdates'), downloadUpdate: () => call('downloadUpdate'), cancelUpdateDownload: () => call('cancelUpdateDownload'), installUpdate: () => call('installUpdate'), openReleasePage: () => call('openReleasePage'),
  desktopState: () => call('desktopState'), setAutoStart: enabled => call('setAutoStart', enabled), quitApp: () => call('quitApp'),
  onUpdateChange: callback => { const fn = (_event: Electron.IpcRendererEvent, state: Parameters<typeof callback>[0]) => callback(state); ipcRenderer.on('shixu:update', fn); return () => ipcRenderer.removeListener('shixu:update', fn); },
  snapshot: () => call('snapshot'), events: (start, end) => call('events', start, end), eventDetail: (id, scope, rid) => call('eventDetail', id, scope, rid),
  testAccount: input => call('testAccount', input), saveAccount: input => call('saveAccount', input), deleteAccount: id => call('deleteAccount', id),
  sync: id => call('sync', id), cancelSync: () => call('cancelSync'), saveEvent: input => call('saveEvent', input), deleteEvent: (id, scope, rid) => call('deleteEvent', id, scope, rid),
  setCalendar: (id, visible, color) => call('setCalendar', id, visible, color), settings: input => call('settings', input), resolveConflict: (id, choice) => call('resolveConflict', id, choice),
  clearCache: () => call('clearCache'), backup: () => call('backup'), restore: () => call('restore'),
  onChange: callback => { const fn = () => callback(); ipcRenderer.on('shixu:changed', fn); return () => ipcRenderer.removeListener('shixu:changed', fn); },
  onOpenSettings: callback => { const fn = (_event: Electron.IpcRendererEvent, tab: string) => callback(tab); ipcRenderer.on('shixu:open-settings', fn); return () => ipcRenderer.removeListener('shixu:open-settings', fn); },
};
contextBridge.exposeInMainWorld('shixu', Object.freeze(api));
