import { describe, expect, it } from 'vitest';
import ICAL from 'ical.js';
import { deleteFuture } from '../src/ical/deleteFuture';
import { editCalendar, editorInput, excludeInstance, expandResource, parseCalendar } from '../src/ical/events';
import type { EventInput } from '../src/shared/contracts';
import type { Resource } from '../src/database/store';

const base: EventInput = { calendarId:'cal', title:'重复测试', start:'2026-10-19T10:00:00', end:'2026-10-19T11:00:00', allDay:false, timezone:'Asia/Shanghai', location:'会议室', description:'保留历史', rrule:'FREQ=DAILY;COUNT=8', reminder:15, scope:'series' };
const resource = (ics: string): Resource => ({ id:'r',calendarId:'cal',url:'https://example.test/r.ics',etag:null,ics,dirty:0,deleted:0 });
const rows = (ics: string) => expandResource(resource(ics),'2026-10-01','2026-12-01','Asia/Shanghai');

describe('删除当前及未来重复日程', () => {
  it('COUNT 截断保留之前的实例、UID、提醒和未知属性，不能同时写 COUNT/UNTIL', () => {
    const original = editCalendar(base).replace('SUMMARY:', 'X-PRIVATE:keep\r\nSUMMARY:');
    const truncated = deleteFuture(original,'2026-10-22T10:00:00')!;
    expect(rows(truncated).map(event => event.start)).toEqual(['2026-10-19T02:00:00.000Z','2026-10-20T02:00:00.000Z','2026-10-21T02:00:00.000Z']);
    expect(truncated).toContain('COUNT=3'); expect(truncated).not.toContain('UNTIL='); expect(truncated).toContain('X-PRIVATE:keep');
    expect(rows(truncated)[0]).toMatchObject({uid:rows(original)[0].uid,reminder:15,location:'会议室',description:'保留历史'});
  });
  it('已经删除的早期实例不消耗新的计数，过去的改期例外继续保留', () => {
    let original = excludeInstance(editCalendar(base),'2026-10-20T10:00:00');
    const input = editorInput(resource(original),'instance','2026-10-21T10:00:00','Asia/Shanghai');
    original = editCalendar({...input,title:'早期改期',start:'2026-10-28T10:00:00',end:'2026-10-28T11:00:00'},original);
    const result = rows(deleteFuture(original,'2026-10-22T10:00:00')!);
    expect(result).toHaveLength(2); expect(result.some(event => event.title==='早期改期')).toBe(true);
  });
  it('未来的 detached 例外按原始 RECURRENCE-ID 删除，即使已移到过去', () => {
    let original = editCalendar(base);
    const input = editorInput(resource(original),'instance','2026-10-24T10:00:00','Asia/Shanghai');
    original = editCalendar({...input,title:'未来例外',start:'2026-10-18T10:00:00',end:'2026-10-18T11:00:00'},original);
    expect(rows(deleteFuture(original,'2026-10-22T10:00:00')!)).toHaveLength(3);
    expect(deleteFuture(original,'2026-10-22T10:00:00')).not.toContain('未来例外');
  });
  it('无限系列使用 UTC UNTIL，在夏令时切换后仍保留前一天的本地时间', () => {
    const original = editCalendar({...base,timezone:'America/New_York',start:'2026-10-30T10:00:00',end:'2026-10-30T11:00:00',rrule:'FREQ=DAILY'});
    const truncated = deleteFuture(original,'2026-11-02T10:00:00')!;
    expect(truncated).toContain('UNTIL=20261102T145959Z');
    expect(rows(truncated).map(event => event.start)).toEqual(['2026-10-30T14:00:00.000Z','2026-10-31T14:00:00.000Z','2026-11-01T15:00:00.000Z']);
  });
  it('全天系列使用前一天的 DATE UNTIL，浮动系列使用浮动 UNTIL', () => {
    const allDay = deleteFuture(editCalendar({...base,allDay:true,start:'2026-10-19',end:'2026-10-20',rrule:'FREQ=DAILY'}),'2026-10-22')!;
    expect(allDay).toContain('UNTIL=20261021'); expect(rows(allDay)).toHaveLength(3);
    const floating = deleteFuture(editCalendar({...base,floating:true,rrule:'FREQ=DAILY'}),'2026-10-22T10:00:00')!;
    expect(floating).toContain('UNTIL=20261022T095959'); expect(floating).not.toContain('UNTIL=20261022T095959Z'); expect(rows(floating)).toHaveLength(3);
  });
  it('不延长已经结束的 COUNT 或 UNTIL 系列', () => {
    for (const rrule of ['FREQ=DAILY;COUNT=2','FREQ=DAILY;UNTIL=20261020T020000Z']) {
      const result = deleteFuture(editCalendar({...base,rrule}),'2026-10-25T10:00:00')!;
      expect(rows(result)).toHaveLength(2);
    }
  });
  it('RDATE PERIOD 和 EXDATE 按起始时间裁剪，保留之前的时长和属性', () => {
    const root = parseCalendar(editCalendar({...base,rrule:''})), master = root.getFirstSubcomponent('vevent')!;
    const rdate = new ICAL.Property('rdate'); rdate.resetType('period'); rdate.setValues([
      ICAL.Period.fromString('2026-10-20T02:00:00Z/PT2H', rdate), ICAL.Period.fromString('2026-10-24T02:00:00Z/PT3H', rdate),
    ]); master.addProperty(rdate);
    const result = rows(deleteFuture(root.toString(),'2026-10-22T10:00:00')!);
    expect(result).toHaveLength(2); expect(result[1].end).toBe('2026-10-20T04:00:00.000Z');
  });
  it('删除第一次意味着整个资源删除，普通日程与范围例外明确拒绝', () => {
    expect(deleteFuture(editCalendar(base),'2026-10-19T10:00:00')).toBeNull();
    expect(() => deleteFuture(editCalendar({...base,rrule:''}),'2026-10-22T10:00:00')).toThrow('没有重复');
    expect(() => deleteFuture(editCalendar(base),'2026-10-22')).toThrow('有效');
    expect(() => deleteFuture(editCalendar(base),'bad')).toThrow('有效');
    const root = parseCalendar(editCalendar(base)), exception = new ICAL.Component('vevent');
    const rid = new ICAL.Property('recurrence-id'); rid.setValue(ICAL.Time.fromString('2026-10-22T10:00:00', undefined)); rid.setParameter('range','THISANDFUTURE'); exception.addProperty(rid); root.addSubcomponent(exception);
    expect(() => deleteFuture(root.toString(),'2026-10-22T10:00:00')).toThrow('范围例外');
  });
  it('起始日期之前存在 RDATE 时阻止整资源删除，避免误删历史', () => {
    const root = parseCalendar(editCalendar(base)), master = root.getFirstSubcomponent('vevent')!;
    master.addPropertyWithValue('rdate',ICAL.Time.fromString('2026-10-18T02:00:00Z',undefined));
    expect(() => deleteFuture(root.toString(),'2026-10-19T10:00:00')).toThrow('起始日期之前');
  });
});
