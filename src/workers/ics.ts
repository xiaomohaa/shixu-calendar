import { expandResource } from '../ical/events';
import type { Resource } from '../database/store';
import type { CalendarEvent } from '../shared/contracts';
import { AppError } from '../shared/errors';

interface Request {
  id: number;
  resources: Resource[];
  visibleCalendars: string[];
  conflictResources: string[];
  start: string;
  end: string;
  timezone: string;
}

self.addEventListener('message', (message: MessageEvent<Request>) => {
  const request = message.data;
  try {
    const start = Date.parse(request.start), end = Date.parse(request.end);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start || end - start > 370 * 86400000) throw new Error('查询日期范围无效，单次最多一年');
    if (request.resources.length > 100000) throw new Error('日程资源过多，无法完成本次查询');
    const visible = new Set(request.visibleCalendars), conflicts = new Set(request.conflictResources);
    const events: CalendarEvent[] = [], diagnostics = new Set<string>();
    for (const resource of request.resources) {
      if (!visible.has(resource.calendarId)) continue;
      try { events.push(...expandResource(resource, request.start, request.end, request.timezone, conflicts.has(resource.id))); }
      catch (error) { diagnostics.add(error instanceof AppError ? error.message : '部分远程 ICS 事件无法解析；原始资源已保留'); }
    }
    events.sort((a, b) => a.start.localeCompare(b.start));
    self.postMessage({ id: request.id, ok: true, events, diagnostics: [...diagnostics] });
  } catch (error) {
    self.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : '日程解析失败' });
  }
});
