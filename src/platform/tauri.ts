import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import type { Api, CalendarEvent, EventInput, Result, Snapshot } from '../shared/contracts';
import { defaultSettings, eventInput } from '../shared/contracts';
import type { DesktopState, UpdateState } from '../shared/updates';
import { expandInWorker } from './icsWorker';
import { editInWorker } from './editWorker';
import type { Resource } from '../database/store';
import { DateTime } from 'luxon';

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
    eventDetail: async (id, scope, rid) => {
      const [resource, snapshot] = await Promise.all([call<Resource>('eventResource', id), call<Snapshot>('snapshot', defaultSettings)]);
      return editInWorker<EventInput>({ kind: 'detail', resource, scope, recurrenceId: rid, timezone: snapshot.settings.timezone });
    },
    testAccount: input => call('testAccount', input),
    saveAccount: input => call('saveAccount', input),
    deleteAccount: id => call('deleteAccount', id),
    sync: id => call('sync', id),
    cancelSync: () => call('cancelSync'),
    saveEvent: async raw => {
      const input = eventInput.parse(raw);
      const existing = input.resourceId ? await call<Resource>('eventResource', input.resourceId) : undefined;
      const ics = await editInWorker<string>({ kind: 'edit', input, original: existing?.ics });
      await call('queueEvent', input.calendarId, existing?.id ?? null, existing?.ics ?? null, ics, false);
    },
    deleteEvent: async (id, scope, rid) => {
      const resource = await call<Resource>('eventResource', id);
      if (scope === 'instance') {
        if (!rid) throw new Error('请选择重复实例');
        const ics = await editInWorker<string>({ kind: 'exclude', ics: resource.ics, recurrenceId: rid });
        await call('queueEvent', resource.calendarId, resource.id, resource.ics, ics, false);
      } else {
        await call('queueEvent', resource.calendarId, resource.id, resource.ics, resource.ics, true);
      }
    },
    setCalendar: (id, visible, color) => call('setCalendar', id, visible, color),
    settings: input => call('settings', input),
    resolveConflict: async (id, choice) => {
      const conflict = (await call<Snapshot>('snapshot', defaultSettings)).conflicts.find(item => item.id === id);
      if (!conflict) throw new Error('冲突已处理');
      const copy = choice === 'both' ? await editInWorker<string>({ kind: 'copy', ics: conflict.localIcs }) : null;
      await call('resolveConflict', id, choice, copy);
    },
    clearCache: () => call('clearCache'),
    backup: () => call('backup', defaultSettings),
    restore: () => call('restore'),
    onChange: callback => subscribe('shixu:changed', callback),
    onOpenSettings: callback => subscribe('shixu:open-settings', callback),
  };
  window.shixu = Object.freeze(api);
  let checkingReminders = false;
  void listen('shixu:reminder-tick', async () => {
    if (checkingReminders) return;
    checkingReminders = true;
    try {
      const input = await call<{ resources: Resource[]; visibleCalendars: string[]; conflictResources: string[]; timezone: string }>('reminderResources', defaultSettings);
      const now = Date.now();
      const expanded = await expandInWorker({ ...input, start: new Date(now - 86400000).toISOString(), end: new Date(now + 8 * 86400000).toISOString() });
      for (const event of expanded.events as CalendarEvent[]) {
        if (event.reminder < 0) continue;
        const start = event.allDay ? DateTime.fromISO(event.start, { zone: input.timezone }).toMillis() : Date.parse(event.start);
        if (!Number.isFinite(start)) continue;
        const due = start - event.reminder * 60000;
        if (due > now || due < now - 60000) continue;
        const key = `${event.id}:${event.start}:${event.reminder}`;
        if (key.length > 2000) continue;
        const time = event.allDay ? '全天' : DateTime.fromMillis(start).setZone(input.timezone).toFormat('HH:mm');
        const body = `${time} ${event.location}`.trim().slice(0, 2000);
        try { await call('notifyReminder', key, event.title.slice(0, 500), body); }
        catch { /* A failed notification should not suppress other due events. */ }
      }
    } catch { /* Reminder processing retries on the next native tick. */ }
    finally { checkingReminders = false; }
  });
}
