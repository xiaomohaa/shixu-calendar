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
      !!item.start && !!item.end && (item.start < item.end || !!item.event.draft) && item.start <= days[6] && item.end >= days[0])
    .sort((a, b) => Number(!!b.event.draft) - Number(!!a.event.draft) || a.start.localeCompare(b.start) || b.end.localeCompare(a.end) || a.event.id.localeCompare(b.event.id));
  const lanes: boolean[][] = [];
  return candidates.map(item => {
    const start = Math.max(0, days.findIndex(day => day >= item.start));
    const end = days.findLastIndex(day => day <= item.end);
    let lane = lanes.findIndex(occupied => Array.from({ length: end - start + 1 }, (_, index) => !occupied[start + index]).every(Boolean));
    if (lane < 0) { lane = lanes.length; lanes.push(Array(7).fill(false)); }
    for (let day = start; day <= end; day++) lanes[lane][day] = true;
    return { event: item.event, start, end, lane, continuesLeft: item.start < days[0], continuesRight: item.end > days[6] };
  });
}
