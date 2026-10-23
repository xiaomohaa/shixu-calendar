import { editCalendar, editorInput, excludeInstance, copyWithNewUid } from '../ical/events';
import type { EventInput } from '../shared/contracts';
import type { Resource } from '../database/store';

type Request =
  | { id: number; kind: 'edit'; input: EventInput; original?: string }
  | { id: number; kind: 'detail'; resource: Resource; scope: 'series' | 'instance'; recurrenceId?: string; timezone: string }
  | { id: number; kind: 'exclude'; ics: string; recurrenceId: string }
  | { id: number; kind: 'copy'; ics: string };

self.addEventListener('message', (message: MessageEvent<Request>) => {
  const request = message.data;
  try {
    const value = request.kind === 'edit' ? editCalendar(request.input, request.original)
      : request.kind === 'detail' ? editorInput(request.resource, request.scope, request.recurrenceId, request.timezone)
      : request.kind === 'exclude' ? excludeInstance(request.ics, request.recurrenceId)
      : copyWithNewUid(request.ics);
    self.postMessage({ id: request.id, ok: true, value });
  } catch (error) {
    self.postMessage({ id: request.id, ok: false, error: error instanceof Error ? error.message : '日程处理失败' });
  }
});
