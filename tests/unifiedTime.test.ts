import { describe, expect, it } from 'vitest';
import { DateTime, Settings } from 'luxon';
import { DEFAULT_TIMEZONE, defaultSettings, type EventInput } from '../src/shared/contracts';
import { editorTime, sourceTime, changedEventTime } from '../src/calendar/editorTime';
import { editCalendar, editorInput, expandResource, parseCalendar } from '../src/ical/events';
import type { Resource } from '../src/database/store';

const input: EventInput = { calendarId:'cal', title:'统一显示', start:'2026-10-23T02:00:00Z', end:'2026-10-23T03:00:00Z', allDay:false, timezone:'UTC', location:'', description:'', rrule:'', reminder:-1, scope:'series' };
const resource = (ics: string): Resource => ({ id:'r', calendarId:'cal', url:'https://example.com/cal/r.ics', etag:'"one"', ics, dirty:0, deleted:0 });
describe('统一时区设置与来源时间保护', () => {
  it('修改开始时间自动结束于一小时后，支持跨天并保留来源时区', () => {
    const next=changedEventTime(input,'start','2026-10-25T23:30',DEFAULT_TIMEZONE);
    expect(editorTime(next.end,next,DEFAULT_TIMEZONE)).toBe('2026-10-26T00:30');
    expect(next.timezone).toBe('UTC');
    const manual=changedEventTime(next,'end','2026-10-26T02:00',DEFAULT_TIMEZONE);
    expect(editorTime(manual.end,manual,DEFAULT_TIMEZONE)).toBe('2026-10-26T02:00');
    expect(changedEventTime(manual,'start','2026-10-25T10:00',DEFAULT_TIMEZONE).end).toBe('2026-10-25T03:00:00.000Z');
  });
  it('全天修改日期保留天数，普通日程跨夏令时按实际一小时计算', () => {
    const allDay=changedEventTime({...input,allDay:true,start:'2026-10-25',end:'2026-10-27'},'start','2026-10-30',DEFAULT_TIMEZONE);
    expect(allDay.end).toBe('2026-11-01');
    const ny={...input,timezone:'America/New_York'};
    const next=changedEventTime(ny,'start','2026-03-08T01:30','America/New_York');
    expect(editorTime(next.end,next,'America/New_York')).toBe('2026-03-08T03:30');
  });
  it('默认始终为 UTC+8，不跟随宿主机时区', () => {
    const previous = Settings.defaultZone;
    try { Settings.defaultZone = 'America/Los_Angeles'; expect(defaultSettings.timezone).toBe(DEFAULT_TIMEZONE); expect(DateTime.now().setZone(defaultSettings.timezone).offset).toBe(480); }
    finally { Settings.defaultZone = previous; }
  });
  it('UTC 日程按统一 UTC+8 显示，改时间后仍写回 UTC 的实际时间', () => {
    expect(editorTime(input.start,input,DEFAULT_TIMEZONE)).toBe('2026-10-23T10:00');
    const start = sourceTime('2026-10-23T11:00',input,DEFAULT_TIMEZONE);
    const end = sourceTime('2026-10-23T12:00',input,DEFAULT_TIMEZONE);
    const rows = expandResource(resource(editCalendar({ ...input,start,end })), '2026-10-22','2026-10-25',DEFAULT_TIMEZONE);
    expect(rows[0].start).toBe('2026-10-23T03:00:00.000Z');
    expect(rows[0].end).toBe('2026-10-23T04:00:00.000Z');
  });
  it('纽约重复系列以北京时间展示，修改标题保留原始时区和夏令时规则', () => {
    const original = editCalendar({ ...input, timezone:'America/New_York', start:'2026-10-31T09:00', end:'2026-10-31T10:00', rrule:'FREQ=DAILY;COUNT=3' });
    const detail = editorInput(resource(original),'series',undefined,DEFAULT_TIMEZONE);
    expect(editorTime(detail.start,detail,DEFAULT_TIMEZONE)).toBe('2026-10-31T21:00');
    const edited = editCalendar({ ...detail,title:'只修改标题' },original);
    expect(parseCalendar(edited).getFirstSubcomponent('vevent')?.getFirstProperty('dtstart')?.getFirstParameter('tzid')).toBe('America/New_York');
    const rows = expandResource(resource(edited),'2026-10-30','2026-11-04',DEFAULT_TIMEZONE);
    expect(rows.map(row => DateTime.fromISO(row.start).setZone(DEFAULT_TIMEZONE).toFormat('HH:mm'))).toEqual(['21:00','22:00','22:00']);
  });
  it('来源夏令时回拨的重复小时仍保留准确的实际时间', () => {
    const ny = { ...input,timezone:'America/New_York' };
    const value = sourceTime('2026-11-01T14:30',ny,DEFAULT_TIMEZONE);
    expect(DateTime.fromISO(value).toUTC().toISO()).toBe('2026-11-01T06:30:00.000Z');
    const saved = editCalendar({ ...ny,start:value,end:sourceTime('2026-11-01T15:30',ny,DEFAULT_TIMEZONE) });
    expect(expandResource(resource(saved),'2026-11-01','2026-11-03',DEFAULT_TIMEZONE)[0].start).toBe('2026-11-01T06:30:00.000Z');
  });
  it('统一设置为夏令时地区时，不会静默平移不存在的输入时间', () => {
    expect(() => sourceTime('2026-03-08T02:30',input,'America/New_York')).toThrow('不存在');
  });
  it('全天日期不换算，浮动日程保留浮动类型', () => {
    const allDay = { ...input,allDay:true };
    expect(editorTime('2026-10-23',allDay,DEFAULT_TIMEZONE)).toBe('2026-10-23');
    expect(sourceTime('2026-10-23',allDay,DEFAULT_TIMEZONE)).toBe('2026-10-23');
    const floating = editCalendar({ ...input,timezone:DEFAULT_TIMEZONE,floating:true,start:'2026-10-23T10:00',end:'2026-10-23T11:00' });
    const detail = editorInput(resource(floating),'series',undefined,DEFAULT_TIMEZONE);
    const saved = editCalendar({ ...detail,start:sourceTime('2026-10-23T12:00',detail,DEFAULT_TIMEZONE),end:sourceTime('2026-10-23T13:00',detail,DEFAULT_TIMEZONE) },floating);
    expect(saved).toContain('DTSTART:20261023T120000'); expect(saved).not.toContain('DTSTART;TZID');
  });
});
