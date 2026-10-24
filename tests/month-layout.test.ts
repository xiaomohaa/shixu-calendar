import { describe, expect, it } from 'vitest';
import { groupMonthEvents, monthDays, monthLayout } from '../src/calendar/monthLayout';
import type { CalendarEvent } from '../src/shared/contracts';
import { eventHasEnded, eventDateRange, weekEventSpans } from '../src/calendar/eventDisplay';
const event = (extra: Partial<CalendarEvent>): CalendarEvent => ({ id:'e', resourceId:'r', calendarId:'c', uid:'u', title:'测试', start:'2026-10-23T02:00:00Z', end:'2026-10-23T03:00:00Z', allDay:false, timezone:'Asia/Shanghai', location:'', description:'', rrule:'', reminder:-1, recurring:false, pending:false, conflict:false, ...extra });
describe('固定月网格布局', () => {
  it('跨天胶囊按一周裁切，全天结束日不占用下一天', () => {
    const days = monthDays('2026-10-01', 1, 'Asia/Shanghai').slice(0, 7);
    const spans = weekEventSpans([event({ allDay: true, start: '2026-09-30', end: '2026-10-03' })], days, 'Asia/Shanghai');
    expect(spans[0]).toMatchObject({ start: 2, end: 4, lane: 0, continuesLeft: false, continuesRight: false });
    expect(weekEventSpans([event({ allDay: true, start: '2026-09-20', end: '2026-10-10' })], days, 'Asia/Shanghai')[0]).toMatchObject({ start: 0, end: 6, continuesLeft: true, continuesRight: true });
  });
  it('重叠跨天胶囊分行，不重叠的胶囊复用同一行', () => {
    const days = monthDays('2026-10-01', 1, 'UTC').slice(0, 7);
    const spans = weekEventSpans([
      event({ id: 'a', allDay: true, start: '2026-09-28', end: '2026-09-30' }),
      event({ id: 'b', allDay: true, start: '2026-09-29', end: '2026-10-02' }),
      event({ id: 'c', allDay: true, start: '2026-10-02', end: '2026-10-04' }),
    ], days, 'UTC');
    expect(spans.map(span => span.lane)).toEqual([0, 1, 0]);
  });
  it('带时区的跨天和午夜结束不额外延伸，单日不生成跨天胶囊', () => {
    expect(eventDateRange(event({ start: '2026-10-22T18:00:00Z', end: '2026-10-24T16:00:00Z' }), 'Asia/Shanghai')).toEqual({ start: '2026-10-23', end: '2026-10-24' });
    expect(weekEventSpans([event({})], monthDays('2026-10-01', 1, 'UTC').slice(21, 28), 'UTC')).toHaveLength(0);
  });
  it('按结束时刻淡化，全天和跨日事件结束前保持原色', () => {
    const now = Date.parse('2026-10-23T04:00:00Z');
    expect(eventHasEnded(event({}), 'Asia/Shanghai', now)).toBe(true);
    expect(eventHasEnded(event({ end: '2026-10-24T00:00:00Z' }), 'Asia/Shanghai', now)).toBe(false);
    expect(eventHasEnded(event({ allDay: true, start: '2026-10-23', end: '2026-10-24' }), 'Asia/Shanghai', now)).toBe(false);
    expect(eventHasEnded(event({ allDay: true, start: '2026-10-22', end: '2026-10-23' }), 'Asia/Shanghai', now)).toBe(true);
    expect(eventHasEnded(event({ end: 'invalid' }), 'Asia/Shanghai', now)).toBe(false);
  });
  it('星期起始偏好和六周日期连续，跨月跨年不丢失', () => { const monday=monthDays('2026-10-01',1,'Asia/Shanghai');expect(monday).toHaveLength(42);expect(monday[0]).toBe('2026-09-28');expect(monday[41]).toBe('2026-11-08');expect(monthDays('2026-01-01',0,'America/New_York')[0]).toBe('2025-12-28'); });
  it('固定字号保留至少一行胶囊，空间缩小时减少行数而不切换点阵', () => { expect(monthLayout(1200,720).capacity).toBe(4); expect(monthLayout(300,240)).toMatchObject({ capacity:1, inlineOverflow:true }); expect(monthLayout(750,420).capacity).toBe(1); expect(monthLayout(2000,1600).capacity).toBe(5); expect(monthLayout(300,720).capacity).toBe(monthLayout(1400,720).capacity); });
  it('全天事件结束日期不包含在内；跨月事件正确投影到日格', () => { const days=monthDays('2026-10-01',1,'Asia/Shanghai');const result=groupMonthEvents([event({allDay:true,start:'2026-09-30',end:'2026-10-03'})],days,'Asia/Shanghai');expect(result.get('2026-09-30')).toHaveLength(1);expect(result.get('2026-10-02')).toHaveLength(1);expect(result.get('2026-10-03')).toHaveLength(0); });
  it('带时区时间按显示时区分组，午夜结束不污染次日', () => { const days=monthDays('2026-10-01',1,'Asia/Shanghai');const result=groupMonthEvents([event({start:'2026-10-22T20:00:00Z',end:'2026-10-23T16:00:00Z'})],days,'Asia/Shanghai');expect(result.get('2026-10-22')).toHaveLength(0);expect(result.get('2026-10-23')).toHaveLength(1);expect(result.get('2026-10-24')).toHaveLength(0); });
  it('DST 23 小时日的全天日程仍按历日归属', () => { const days=monthDays('2026-03-01',0,'America/New_York');const result=groupMonthEvents([event({allDay:true,start:'2026-03-08',end:'2026-03-10'})],days,'America/New_York');expect(result.get('2026-03-08')).toHaveLength(1);expect(result.get('2026-03-09')).toHaveLength(1);expect(result.get('2026-03-10')).toHaveLength(0); });
  it('先展示全天，再按开始时间排序；每个重复实例保持独立 ID', () => { const days=monthDays('2026-10-01',1,'Asia/Shanghai');const result=groupMonthEvents([event({id:'later',start:'2026-10-23T04:00:00Z',end:'2026-10-23T05:00:00Z'}),event({id:'earlier'}),event({id:'all',allDay:true,start:'2026-10-23',end:'2026-10-24'})],days,'Asia/Shanghai');expect(result.get('2026-10-23')!.map(e=>e.id)).toEqual(['all','earlier','later']); });
});
