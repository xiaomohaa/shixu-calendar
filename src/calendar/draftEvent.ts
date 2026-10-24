import { DateTime } from 'luxon';
import type { CalendarEvent, EventInput } from '../shared/contracts';

export function draftEvent(input: EventInput | null, duration: number): CalendarEvent | null {
  if (!input || input.resourceId) return null;
  const start = DateTime.fromISO(input.start, { zone: input.timezone });
  if (!start.isValid) return null;
  let end = DateTime.fromISO(input.end, { zone: input.timezone });
  if (!end.isValid || end <= start) end = input.allDay ? start.plus({ days: 1 }) : start.plus({ minutes: duration });
  return { ...input, id: '__shixu-draft__', resourceId: '', uid: '', title: input.title.trim() || '新建日程',
    start: input.allDay ? start.toISODate()! : start.toISO()!, end: input.allDay ? end.toISODate()! : end.toISO()!,
    recurring: false, pending: false, conflict: false, draft: true };
}
