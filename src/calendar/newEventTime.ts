import { DateTime } from 'luxon';

/** Date-only creation uses that civil date at the current local hour.
 * An explicit time (for example a time-grid slot) keeps its chosen time. */
export function newEventTime(date: string, timezone: string, allDay = false, now = Date.now()) {
  const base = DateTime.fromISO(date, { zone: timezone });
  return allDay || date.includes('T') ? base : base.set({ hour: DateTime.fromMillis(now).setZone(timezone).hour, minute: 0, second: 0, millisecond: 0 });
}
