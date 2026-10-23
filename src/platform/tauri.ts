import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Api, Result, Snapshot } from '../shared/contracts';
import { defaultSettings } from '../shared/contracts';
import type { DesktopState, UpdateState } from '../shared/updates';
import { expandInWorker } from './icsWorker';
import type { Resource } from '../database/store';

declare global { interface Window { __TAURI_INTERNALS__?: unknown } }

if (window.__TAURI_INTERNALS__) {
  let diagnostics: string[] = [];
  const call = async <T>(method: string, ...args: unknown[]): Promise<T> => {
    const result = await invoke<Result<T>>('shixu_call', { method, args });
    if (!result.ok) throw new Error(result.error);
    return result.value;
  };
  const subscribe = <T>(event: string, callback: (payload: T) => void): (() => void) => {
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void listen<T>(event, message => { if (!cancelled) callback(message.payload); }).then(stop => {
      if (cancelled) stop(); else unlisten = stop;
    });
    return () => { cancelled = true; unlisten?.(); };
  };
  const api: Api = {
    updateState: () => call<UpdateState>('updateState'),
    checkForUpdates: () => call('checkForUpdates'),
    downloadUpdate: () => call('downloadUpdate'),
    cancelUpdateDownload: () => call('cancelUpdateDownload'),
    installUpdate: () => call('installUpdate'),
    openReleasePage: () => call('openReleasePage'),
    onUpdateChange: callback => subscribe('shixu:update', callback),
    desktopState: () => call<DesktopState>('desktopState'),
    setAutoStart: enabled => call<DesktopState>('setAutoStart', enabled),
    quitApp: () => call('quitApp'),
    snapshot: async () => ({ ...(await call<Snapshot>('snapshot', defaultSettings)), diagnostics }),
    events: async (start, end) => {
      const input = await call<{ resources: Resource[]; visibleCalendars: string[]; conflictResources: string[]; timezone: string }>('eventResources', defaultSettings);
      const result = await expandInWorker({ ...input, start, end });
      diagnostics = result.diagnostics;
      return result.events;
    },
    eventDetail: (id, scope, rid) => call('eventDetail', id, scope, rid),
    testAccount: input => call('testAccount', input),
    saveAccount: input => call('saveAccount', input),
    deleteAccount: id => call('deleteAccount', id),
    sync: id => call('sync', id),
    cancelSync: () => call('cancelSync'),
    saveEvent: input => call('saveEvent', input),
    deleteEvent: (id, scope, rid) => call('deleteEvent', id, scope, rid),
    setCalendar: (id, visible, color) => call('setCalendar', id, visible, color),
    settings: input => call('settings', input),
    resolveConflict: (id, choice) => call('resolveConflict', id, choice),
    clearCache: () => call('clearCache'),
    backup: () => call('backup'),
    restore: () => call('restore'),
    onChange: callback => subscribe('shixu:changed', callback),
    onOpenSettings: callback => subscribe('shixu:open-settings', callback),
  };
  window.shixu = Object.freeze(api);
}
