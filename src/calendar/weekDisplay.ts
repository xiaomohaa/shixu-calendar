import type { CalendarEvent } from '../shared/contracts';
import { eventDateRange, weekEventSpans, type WeekSpan } from './eventDisplay';

/** Reserve a full text row for overflow. Never overlay +N on an event. */
export function weekDisplay(events: CalendarEvent[], days: string[], groups: Map<string, CalendarEvent[]>, timezone: string, capacity: number) {
  const spans = weekEventSpans(events, days, timezone);
  const cells = days.map((day, column) => {
    const list = groups.get(day) ?? [], draft = list.some(event => event.draft);
    const budget = list.length > capacity ? Math.max(draft ? 1 : 0, capacity - 1) : capacity;
    const visibleSpans = spans.filter(span => span.start <= column && span.end >= column && span.lane < budget);
    const reserved = visibleSpans.reduce((count, span) => Math.max(count, span.lane + 1), 0);
    const single = list.filter(event => { const range = eventDateRange(event, timezone); return !event.draft && range.start === range.end; });
    const occupied = new Set(visibleSpans.map(span => span.lane));
    const free = Array.from({length:budget},(_,lane)=>lane).filter(lane=>!occupied.has(lane));
    const visible = single.slice(0,free.length);
    const placements = visible.map((event,index)=>({event,lane:free[index]}));
    const nextLane = Math.max(-1,...occupied,...placements.map(item=>item.lane))+1;
    // A span can have a high lane because it overlaps events on other dates.
    // Keep +N inside this cell by using a remaining hole when necessary.
    const overflowLane = nextLane < capacity ? nextLane : free[visible.length] ?? nextLane;
    const hidden = list.length - visible.length - visibleSpans.length;
    // A one-row draft remains visible while editing; its agenda is still keyboard accessible.
    return { visible, placements, visibleSpans, reserved, overflowLane, overflow: draft && capacity === 1 ? 0 : hidden };
  });
  const segments: WeekSpan[] = [];
  for (const span of spans) {
    let start = -1;
    for (let column = span.start; column <= span.end + 1; column++) {
      const visible = column <= span.end && cells[column].visibleSpans.includes(span);
      if (visible && start < 0) start = column;
      if (!visible && start >= 0) {
        segments.push({ ...span, start, end: column - 1, continuesLeft: span.continuesLeft || start > span.start, continuesRight: span.continuesRight || column - 1 < span.end });
        start = -1;
      }
    }
  }
  return { cells, segments };
}
