import ICAL from 'ical.js';
const randomUUID = () => globalThis.crypto.randomUUID();
import { DateTime } from 'luxon';
import type { CalendarEvent, EventInput } from '../shared/contracts';
import type { Resource } from '../database/store';
import { AppError } from '../shared/errors';
import { timezoneComponent } from './timezones';
const recurrenceRules = (c: ICAL.Component) => c.getAllProperties('rrule').map(p => p.toICALString().replace(/\r?\n[ \t]/g, '').replace(/^RRULE:/i, '')).join('\n');
const standardRuleParts = new Set(['FREQ','UNTIL','COUNT','INTERVAL','BYSECOND','BYMINUTE','BYHOUR','BYDAY','BYMONTHDAY','BYYEARDAY','BYWEEKNO','BYMONTH','BYSETPOS','WKST']);

export function parseCalendar(ics: string): ICAL.Component {
  try {
    const c = new ICAL.Component(ICAL.parse(ics)); if (c.name !== 'vcalendar') throw new Error();
    // ical.js 2.2.1 expands only the first RDATE value of each VTIMEZONE
    // property and omits DTSTART when RDATE exists. Split equivalent values
    // and include DTSTART explicitly. No timezone observances are discarded.
    for (const zone of c.getAllSubcomponents('vtimezone')) for (const part of zone.getAllSubcomponents()) {
      const props = part.getAllProperties('rdate'); if (!props.length) continue;
      const values = props.flatMap(p => p.getValues());
      if (!part.hasProperty('rrule')) { const start = part.getFirstPropertyValue('dtstart'); if (start && !values.some(v => v.toString() === start.toString())) values.unshift(start); }
      const template = props[0].toJSON(); part.removeAllProperties('rdate');
      for (const value of values) { const p = new ICAL.Property(JSON.parse(JSON.stringify(template))); p.setValue(value); part.addProperty(p); }
    }
    return c;
  } catch { throw new AppError('服务器返回的 iCalendar 数据无效，原始资源已保留'); }
}
function eventTime(t: ICAL.Time, tzid: string): string {
  if (t.isDate) return t.toString().slice(0, 10);
  if (t.zone.tzid !== 'floating') return new Date(t.toUnixTime() * 1000).toISOString();
  const dt = DateTime.fromISO(t.toString(), { zone: tzid });
  if (!dt.isValid) throw new AppError(`无法识别事件时区：${tzid}`);
  return dt.toUTC().toISO()!;
}
function timezone(e: ICAL.Event, fallback: string) { return e.component.getFirstProperty('dtstart')?.getFirstParameter('tzid') || (e.startDate.zone.tzid === 'UTC' ? 'UTC' : fallback); }
// https://github.com/apple/ccs-calendarserver/blob/master/twistedcaldav/stdconfig.py
function travelMinutes(component: ICAL.Component): number | undefined {
  const value = component.getFirstPropertyValue('x-apple-travel-duration');
  if (value == null) return 0;
  try { const seconds = ICAL.Duration.fromString(String(value)).toSeconds(); return Number.isInteger(seconds / 60) && seconds >= 0 && seconds <= 86400 ? seconds / 60 : undefined; }
  catch { return undefined; }
}
function reminder(e: ICAL.Event) {
  const alarms = e.component.getAllSubcomponents('valarm');
  if (!alarms.length) return -1;
  if (alarms.length !== 1) return -2;
  const alarm = alarms[0], trigger = alarm.getFirstProperty('trigger');
  if (alarm.getFirstPropertyValue('action') !== 'DISPLAY' || trigger?.getFirstParameter('related') === 'END' || alarm.hasProperty('repeat') || trigger?.type !== 'duration') return -2;
  const d = trigger.getFirstValue() as ICAL.Duration;
  return d.toSeconds() <= 0 && d.toSeconds() % 60 === 0 ? -d.toSeconds() / 60 : -2;
}
export function expandResource(r: Resource, rangeStart: string, rangeEnd: string, fallback: string, conflict = false): CalendarEvent[] {
  if (r.deleted) return [];
  const root = parseCalendar(r.ics), components = root.getAllSubcomponents('vevent');
  const result: CalendarEvent[] = [], lower = Date.parse(rangeStart), upper = Date.parse(rangeEnd);
  const masters = components.filter(c => !c.hasProperty('recurrence-id'));
  const add = (master: ICAL.Event, item: ICAL.Event, start: ICAL.Time, end: ICAL.Time, rid?: string) => {
    if (item.component.getFirstPropertyValue('status') === 'CANCELLED') return;
    const tz = timezone(item, fallback), s = eventTime(start, tz), e = eventTime(end, tz);
    const sm = start.isDate ? DateTime.fromISO(s, { zone: fallback }).toMillis() : Date.parse(s);
    const em = end.isDate ? DateTime.fromISO(e, { zone: fallback }).toMillis() : Date.parse(e);
    if (sm >= upper || (em <= lower && sm !== lower)) return;
    const rrule = recurrenceRules(master.component);
    result.push({ id: `${r.id}:${rid ?? ''}`, resourceId: r.id, calendarId: r.calendarId, uid: master.uid, title: item.summary || '未命名日程', start: s, end: e, allDay: start.isDate, timezone: tz, location: item.location || '', description: item.description || '', rrule, reminder: reminder(item), recurrenceId: rid, recurring: master.isRecurring() || !!rid, pending: !!r.dirty, conflict,
      warning: master.component.hasProperty('organizer') ? '此事件包含组织者；本应用不发送会议邀请或回复。' : undefined });
  };
  for (const component of masters) {
    const ev = new ICAL.Event(component);
    if (!ev.startDate) continue;
    const periods = component.getAllProperties('rdate').flatMap(p => p.getValues()).filter((v): v is ICAL.Period => v instanceof ICAL.Period);
    // RecurExpansion in ical.js expects Time values, even for RDATE PERIOD.
    // Convert only this in-memory display tree and retain each period's duration.
    for (const p of component.getAllProperties('rdate').filter(p => p.type === 'period')) { const times = p.getValues().map(v => (v as ICAL.Period).start); p.resetType('date-time'); p.setValues(times); }
    if (component.hasProperty('rdate') && !component.hasProperty('rrule') && !component.getAllProperties('rdate').flatMap(p => p.getValues()).some(v => v instanceof ICAL.Time && v.compare(ev.startDate) === 0)) {
      const p = new ICAL.Property('rdate'); p.setValue(ev.startDate.clone()); if (ev.startDate.zone.tzid !== 'UTC' && ev.startDate.zone.tzid !== 'floating') p.setParameter('tzid', ev.startDate.zone.tzid); component.addProperty(p);
    }
    if (recurrenceRules(component).split(/[;\n]/).some(part => part && !standardRuleParts.has(part.split('=')[0].toUpperCase()))) throw new AppError('日程包含不支持的重复规则扩展，原始 ICS 已完整保留；请在原服务中查看');
    if (!ev.isRecurring()) { add(ev, ev, ev.startDate, ev.endDate); continue; }
    const iterator = ev.iterator();
    let next: ICAL.Time | null, count = 0;
    // Hard cap protects the main process from hostile SECONDLY rules. Never write
    // back a reduced recurrence rule merely because display expansion is bounded.
    while ((next = iterator.next())) {
      if (++count > 100000) throw new AppError('重复事件过于密集，当前范围无法完整展开；原始重复规则已保留');
      if (Date.parse(eventTime(next, timezone(ev, fallback))) >= upper + 172800000) break;
      const details = ev.getOccurrenceDetails(next);
      if (details.item === ev) {
        const period = periods.find(v => v.start.compare(next!) === 0);
        if (period) { details.endDate = details.startDate.clone(); details.endDate.addDuration(period.getDuration()); }
      }
      add(ev, details.item, details.startDate, details.endDate, next.toString());
    }
    // Detached exceptions can move outside their recurrence's original range.
    for (const c of components.filter(c => c.hasProperty('recurrence-id') && c.getFirstPropertyValue('uid') === ev.uid)) {
      const ex = new ICAL.Event(c), rid = ex.recurrenceId.toString();
      if (!result.some(x => x.resourceId === r.id && x.recurrenceId === rid)) add(ev, ex, ex.startDate, ex.endDate, rid);
    }
  }
  // Some providers return orphan exceptions in their own resource.
  if (!masters.length) for (const c of components) { const ev = new ICAL.Event(c); add(ev, ev, ev.startDate, ev.endDate, ev.recurrenceId?.toString()); }
  return result;
}
function inputTime(value: string, allDay: boolean, tz: string, root: ICAL.Component, floating = false): ICAL.Time {
  if (allDay) { if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || !DateTime.fromISO(value).isValid) throw new AppError('全天日期格式无效'); return ICAL.Time.fromDateString(value); }
  const dt = DateTime.fromISO(value, { zone: tz }).setZone(tz);
  if (!dt.isValid || dt.year < 1901 || dt.year > 2099) throw new AppError('日期时间或时区无效（支持 1901–2099 年）');
  const wall = value.match(/^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(?::\d{2})?$/);
  if (wall && dt.toFormat("yyyy-MM-dd'T'HH:mm") !== wall[1]) throw new AppError('该当地时间因夏令时切换而不存在，请选择其他时间');
  let zone = ICAL.Timezone.utcTimezone;
  if (floating) zone = ICAL.Timezone.localTimezone;
  else if (tz !== 'UTC') {
    let component = root.getAllSubcomponents('vtimezone').find(c => c.getFirstPropertyValue('tzid') === tz);
    if (!component) { component = timezoneComponent(tz); root.addSubcomponent(component); }
    zone = new ICAL.Timezone({ component, tzid: tz });
  }
  return new ICAL.Time({ year: dt.year, month: dt.month, day: dt.day, hour: dt.hour, minute: dt.minute, second: dt.second, isDate: false }, zone);
}
export function editCalendar(input: EventInput, original?: string): string {
  const root = original ? parseCalendar(original) : new ICAL.Component(['vcalendar', [], []]);
  if (!original) { root.updatePropertyWithValue('version', '2.0'); root.updatePropertyWithValue('prodid', '-//Shixu Calendar//CN'); }
  const masters = root.getAllSubcomponents('vevent').filter(c => !c.hasProperty('recurrence-id'));
  if (masters.length > 1) throw new AppError('资源包含多个独立事件，为避免数据损坏，请在原服务中编辑');
  const master = masters[0];
  let target: ICAL.Component | undefined = master;
  if (input.scope === 'instance') {
    if (!master || !input.recurrenceId) throw new AppError('请选择有效的重复实例');
    if (root.getAllSubcomponents('vevent').some(c => c.getFirstProperty('recurrence-id')?.getFirstParameter('range'))) throw new AppError('此系列包含“本次及以后”的范围例外，请在原服务中编辑单次实例以保留其语义');
    const masterEvent = new ICAL.Event(master);
    if (masterEvent.startDate.isDate !== input.allDay) throw new AppError('单个重复实例不能切换全天类型，请编辑整个系列');
    target = root.getAllSubcomponents('vevent').find(c => c.getFirstPropertyValue('recurrence-id')?.toString() === input.recurrenceId);
    if (!target) {
      target = new ICAL.Component(JSON.parse(JSON.stringify(master.toJSON())));
      for (const p of ['rrule', 'rdate', 'exdate']) target.removeAllProperties(p);
      const rid = ICAL.Time.fromString(input.recurrenceId, undefined); rid.zone = masterEvent.startDate.zone;
      new ICAL.Event(target).recurrenceId = rid; root.addSubcomponent(target);
    }
  }
  if (!target) { target = new ICAL.Component('vevent'); root.addSubcomponent(target); }
  const event = new ICAL.Event(target);
  event.uid = event.uid || input.uid || randomUUID();
  const start = inputTime(input.start, input.allDay, input.timezone, root, input.floating), end = inputTime(input.end, input.allDay, input.timezone, root, input.floating);
  if (end.compare(start) <= 0) throw new AppError('结束时间必须晚于开始时间；全天事件的结束日期为不包含的次日');
  if (original && input.scope === 'series' && master) {
    // Changing DTSTART of a recurring master would invalidate RECURRENCE-ID,
    // EXDATE and RDATE. Require edits on instances instead of silently losing them.
    const before = new ICAL.Event(master);
    if ((before.isRecurring() || root.getAllSubcomponents('vevent').length > 1) && (before.startDate.toString() !== start.toString() || before.startDate.zone.tzid !== start.zone.tzid)) throw new AppError('重复系列的起始时间和时区请通过单个实例修改；可在原服务中调整整个系列锚点');
  }
  event.startDate = start; event.endDate = end;
  event.summary = input.title; event.location = input.location; event.description = input.description;
  if (input.travelMinutes !== undefined) {
    target.removeAllProperties('x-apple-travel-duration');
    if (input.travelMinutes > 0) target.addPropertyWithValue('x-apple-travel-duration', ICAL.Duration.fromSeconds(input.travelMinutes * 60).toString());
  }
  event.sequence = (event.sequence || 0) + 1;
  target.updatePropertyWithValue('dtstamp', ICAL.Time.now().convertToZone(ICAL.Timezone.utcTimezone));
  target.updatePropertyWithValue('last-modified', ICAL.Time.now().convertToZone(ICAL.Timezone.utcTimezone));
  if (input.scope === 'series') {
    const old = recurrenceRules(target);
    if (input.rrule !== old) {
      if (target.hasProperty('rdate') || target.hasProperty('exdate') || root.getAllSubcomponents('vevent').length > 1) throw new AppError('此系列包含重复例外，为保留数据，请在原服务中修改重复规则');
      let rule: ICAL.Recur | undefined;
      try { if (input.rrule) { if (!/^(?:FREQ=)(?:DAILY|WEEKLY|MONTHLY|YEARLY)(?:;|$)/i.test(input.rrule) || /[\r\n]/.test(input.rrule) || input.rrule.split(';').some(part => !standardRuleParts.has(part.split('=')[0].toUpperCase()))) throw new Error(); rule = ICAL.Recur.fromString(input.rrule); if (rule.interval < 1 || (rule.count !== null && rule.count < 1)) throw new Error(); } } catch { throw new AppError('重复规则无效，请输入每日、每周、每月或每年的合法 RRULE'); }
      target.removeAllProperties('rrule'); if (rule) target.addPropertyWithValue('rrule', rule);
    }
  }
  // -2 means preserve imported alarms exactly. Explicit user changes replace them.
  if (input.reminder !== -2 && input.reminder !== reminder(event)) {
    target.removeAllSubcomponents('valarm');
    if (input.reminder >= 0) { const alarm = new ICAL.Component('valarm'); alarm.addPropertyWithValue('action', 'DISPLAY'); alarm.addPropertyWithValue('description', input.title); alarm.addPropertyWithValue('trigger', ICAL.Duration.fromSeconds(-input.reminder * 60)); target.addSubcomponent(alarm); }
  }
  return root.toString();
}
export function excludeInstance(ics: string, recurrenceId: string): string {
  const root = parseCalendar(ics), master = root.getAllSubcomponents('vevent').find(c => !c.hasProperty('recurrence-id'));
  if (!master) throw new AppError('找不到重复事件主记录，请在原服务中处理此实例');
  if (root.getAllSubcomponents('vevent').some(c => c.getFirstProperty('recurrence-id')?.getFirstParameter('range'))) throw new AppError('此系列包含范围例外，请在原服务中删除单次实例');
  const ev = new ICAL.Event(master), rid = ICAL.Time.fromString(recurrenceId, undefined); rid.zone = ev.startDate.zone;
  const prop = new ICAL.Property('exdate'); prop.setValue(rid); if (!rid.isDate && rid.zone.tzid !== 'UTC' && rid.zone.tzid !== 'floating') prop.setParameter('tzid', rid.zone.tzid);
  master.addProperty(prop);
  for (const c of root.getAllSubcomponents('vevent')) if (c.getFirstPropertyValue('recurrence-id')?.toString() === recurrenceId) root.removeSubcomponent(c);
  ev.sequence = (ev.sequence || 0) + 1; master.updatePropertyWithValue('dtstamp', ICAL.Time.now().convertToZone(ICAL.Timezone.utcTimezone));
  return root.toString();
}
export function copyWithNewUid(ics: string) { const root = parseCalendar(ics), uid = randomUUID(); for (const c of root.getAllSubcomponents('vevent')) c.updatePropertyWithValue('uid', uid); return root.toString(); }
export function editorInput(r: Resource, scope: 'series' | 'instance', recurrenceId: string | undefined, fallback: string): EventInput {
  const root = parseCalendar(r.ics), master = root.getAllSubcomponents('vevent').find(c => !c.hasProperty('recurrence-id'));
  if (!master) throw new AppError('此资源仅包含例外实例，请在原服务中编辑');
  const ev = new ICAL.Event(master);
  let item = ev, start = ev.startDate, end = ev.endDate;
  if (scope === 'instance' && recurrenceId) { const rid = ICAL.Time.fromString(recurrenceId, undefined); rid.zone = start.zone; const details = ev.getOccurrenceDetails(rid); item = details.item; start = details.startDate; end = details.endDate; }
  if (scope === 'instance' && item === ev) { const period = master.getAllProperties('rdate').flatMap(p => p.getValues()).find(v => v instanceof ICAL.Period && v.start.compare(start) === 0) as ICAL.Period | undefined; if (period) { end = start.clone(); end.addDuration(period.getDuration()); } }
  const tz = timezone(item, fallback);
  return { resourceId: r.id, calendarId: r.calendarId, uid: ev.uid, title: item.summary || '', start: eventTime(start, tz), end: eventTime(end, tz), allDay: start.isDate, timezone: tz, travelMinutes: travelMinutes(item.component), floating: start.zone.tzid === 'floating', location: item.location || '', description: item.description || '', rrule: recurrenceRules(ev.component), reminder: reminder(item), scope, recurrenceId };
}
