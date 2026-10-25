import ICAL from 'ical.js';
import { DateTime } from 'luxon';
import { parseCalendar } from './events';
import { AppError } from '../shared/errors';

/** Truncate the recurrence set by original RECURRENCE-ID, preserving history.
 * null means the first occurrence (and therefore the resource) is deleted.
 */
export function deleteFuture(ics: string, recurrenceId: string): string | null {
  const root = parseCalendar(ics), events = root.getAllSubcomponents('vevent');
  const masters = events.filter(event => !event.hasProperty('recurrence-id'));
  if (masters.length !== 1) throw new AppError('此资源没有唯一的重复主记录，请在原服务中删除未来日程');
  if (events.some(event => event.getFirstProperty('recurrence-id')?.getFirstParameter('range'))) throw new AppError('此系列包含范围例外，请在原服务中删除未来日程以保留原有记录');
  const master = masters[0], event = new ICAL.Event(master), start = event.startDate;
  if (!event.isRecurring()) throw new AppError('此日程没有重复规则，请删除当前日程');
  const dateOnly = /^\d{4}-\d{2}-\d{2}$/.test(recurrenceId);
  if (dateOnly !== start.isDate || !DateTime.fromISO(recurrenceId).isValid) throw new AppError('请选择有效的重复实例');
  const cutoff = ICAL.Time.fromString(recurrenceId, undefined); cutoff.zone = start.zone;
  if (cutoff.compare(start) <= 0) {
    const earlierDate = master.getAllProperties('rdate').flatMap(property => property.getValues()).some(value => (value instanceof ICAL.Period ? value.start : value as ICAL.Time).compare(cutoff) < 0);
    const earlierException = events.some(component => { const rid = component.getFirstPropertyValue('recurrence-id') as ICAL.Time | null; return rid && rid.compare(cutoff) < 0; });
    if (earlierDate || earlierException) throw new AppError('此系列包含起始日期之前的例外，请在原服务中删除未来日程以保留历史');
    return null;
  }
  // RFC 5545: UNTIL is inclusive, DATE for all-day, UTC for zoned times.
  const until = cutoff.clone();
  until.addDuration(ICAL.Duration.fromSeconds(start.isDate ? -86400 : -1));
  const limit = start.isDate || start.zone.tzid === 'floating' ? until : until.convertToZone(ICAL.Timezone.utcTimezone);
  for (const property of master.getAllProperties('rrule')) {
    const rule = (property.getFirstValue() as ICAL.Recur).clone();
    if (rule.count != null) {
      // Keep COUNT rather than adding an incompatible UNTIL; count original
      // occurrences before EXDATE so deleted/moved exceptions do not extend it.
      const iterator = rule.iterator(start); let before = 0, steps = 0, next: ICAL.Time | null;
      while ((next = iterator.next())) {
        if (++steps > 100000) throw new AppError('重复规则过于密集，请在原服务中删除未来日程');
        if (next.compare(cutoff) >= 0) break;
        before++;
      }
      if (!before) master.removeProperty(property);
      else { rule.count = before; property.setValue(rule); }
    } else {
      if (!rule.until || rule.until.compare(limit) > 0) rule.until = limit.clone();
      property.setValue(rule);
    }
  }
  for (const name of ['rdate', 'exdate']) for (const property of master.getAllProperties(name)) {
    const values = property.getValues().filter(value => (value instanceof ICAL.Period ? value.start : value as ICAL.Time).compare(cutoff) < 0);
    if (values.length) property.setValues(values); else master.removeProperty(property);
  }
  for (const component of events) {
    const rid = component.getFirstPropertyValue('recurrence-id') as ICAL.Time | null;
    if (rid && rid.compare(cutoff) >= 0) root.removeSubcomponent(component);
  }
  event.sequence = (event.sequence || 0) + 1;
  const now = ICAL.Time.now().convertToZone(ICAL.Timezone.utcTimezone);
  master.updatePropertyWithValue('dtstamp', now);
  master.updatePropertyWithValue('last-modified', now);
  return root.toString();
}
