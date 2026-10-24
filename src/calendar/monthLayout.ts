import { DateTime } from 'luxon';
import type { CalendarEvent } from '../shared/contracts';

export function monthDays(month: string, firstDay: number, timezone: string): string[] {
  const start = DateTime.fromISO(month, { zone: timezone }).startOf('month');
  const offset = (start.weekday % 7 - firstDay + 7) % 7;
  return Array.from({ length: 42 }, (_, index) => start.minus({ days: offset }).plus({ days: index }).toISODate()!);
}
export const MONTH_EVENT_HEIGHT = 16, MONTH_EVENT_LANE = 18;

export function monthLayout(_width: number, height: number) {
  const row = height / 6;
  // Font sizes and row height stay fixed. Only the number of visible events changes.
  return { compact: row < 72, inlineOverflow: row < 62,
    capacity: Math.max(1, Math.min(5, Math.floor((row - 40) / MONTH_EVENT_LANE))) };
}
/** Compare civil dates; all-day DTEND is exclusive, timed ends use an instant. */
export function groupMonthEvents(events: CalendarEvent[], days: string[], timezone: string) {
  const groups = new Map(days.map(day => [day, [] as CalendarEvent[]]));
  for (const event of events) {
    const start = event.allDay ? event.start.slice(0, 10) : DateTime.fromISO(event.start).setZone(timezone).toISODate();
    const end = event.allDay ? DateTime.fromISO(event.end, { zone: timezone }).minus({ days: 1 }).toISODate() : DateTime.fromISO(event.end).minus({ milliseconds: 1 }).setZone(timezone).toISODate();
    if (!start || !end) continue;
    for (const day of days) if (day >= start && day <= end) groups.get(day)!.push(event);
  }
  for (const list of groups.values()) list.sort((a, b) => Number(!!b.draft) - Number(!!a.draft) || Number(b.allDay) - Number(a.allDay) || a.start.localeCompare(b.start) || a.title.localeCompare(b.title, 'zh-CN'));
  return groups;
}
