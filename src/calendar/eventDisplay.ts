import { DateTime } from 'luxon';
import type { CalendarEvent } from '../shared/contracts';

export function eventDateRange(event: CalendarEvent, timezone: string) {
  const start = DateTime.fromISO(event.start, { zone: timezone });
  const end = DateTime.fromISO(event.end, { zone: timezone }).minus({ milliseconds: 1 });
  return { start: start.toISODate(), end: end.toISODate() };
}

export function eventHasEnded(event: CalendarEvent, timezone: string, now: number) {
  const end = DateTime.fromISO(event.end, { zone: timezone }).toMillis();
  return Number.isFinite(end) && end <= now;
}

export interface WeekSpan {
  event: CalendarEvent; start: number; end: number; lane: number;
  continuesLeft: boolean; continuesRight: boolean;
}

/** Pack week segments into stable lanes; all-day DTEND stays exclusive. */
export function weekEventSpans(events: CalendarEvent[], days: string[], timezone: string): WeekSpan[] {
  const candidates = events.map(event => ({ event, ...eventDateRange(event, timezone) }))
    .filter((item): item is { event: CalendarEvent; start: string; end: string } =>
      !!item.start && !!item.end && item.start < item.end && item.start <= days[6] && item.end >= days[0])
    .sort((a, b) => a.start.localeCompare(b.start) || b.end.localeCompare(a.end) || a.event.id.localeCompare(b.event.id));
  const lanes: number[] = [];
  return candidates.map(item => {
    const start = Math.max(0, days.findIndex(day => day >= item.start));
    const end = days.findLastIndex(day => day <= item.end);
    let lane = lanes.findIndex(last => last < start);
    if (lane < 0) lane = lanes.length;
    lanes[lane] = end;
    return { event: item.event, start, end, lane, continuesLeft: item.start < days[0], continuesRight: item.end > days[6] };
  });
}
