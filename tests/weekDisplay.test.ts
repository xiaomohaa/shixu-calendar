import { describe, expect, it } from 'vitest';
import { weekDisplay } from '../src/calendar/weekDisplay';
import { groupMonthEvents } from '../src/calendar/monthLayout';
import type { CalendarEvent } from '../src/shared/contracts';

const days = ['2026-10-26','2026-10-27','2026-10-28','2026-10-29','2026-10-30','2026-10-31','2026-11-01'];
const make = (id: string, start = '2026-10-29', end = '2026-10-30'): CalendarEvent => ({ id, resourceId:id, calendarId:'cal', uid:id, title:id, start, end, allDay:true, timezone:'Asia/Shanghai', location:'', description:'', rrule:'', reminder:-1, recurring:false, pending:false, conflict:false });
const plan = (events: CalendarEvent[], capacity: number) => weekDisplay(events,days,groupMonthEvents(events,days,'Asia/Shanghai'),'Asia/Shanghai',capacity);
describe('日格行数不足时只显示数量', () => {
  it('跨天非全天按完整历日跨度降序，跨周续接不改优先级', () => {
    const events=[
      {...make('short','2026-10-26T09:00:00+08:00','2026-10-27T10:00:00+08:00'),allDay:false},
      {...make('long','2026-10-27T09:00:00+08:00','2026-11-05T10:00:00+08:00'),allDay:false},
      make('medium','2026-10-28','2026-11-01'),
    ];
    const result=plan(events,5);
    expect(result.segments.map(span=>[span.event.id,span.lane])).toEqual([['long',0],['medium',1],['short',1]]);
    const nextDays=['2026-11-02','2026-11-03','2026-11-04','2026-11-05','2026-11-06','2026-11-07','2026-11-08'];
    const next=weekDisplay(events,nextDays,groupMonthEvents(events,nextDays,'Asia/Shanghai'),'Asia/Shanghai',5);
    expect(next.segments[0]).toMatchObject({start:0,end:3,lane:0,continuesLeft:true,continuesRight:false});
    expect(result.cells[1].overflow).toBe(0);
  });
  it('恰好午夜结束不占下一天，单日非全天不变成跨天条', () => {
    const event={...make('midnight','2026-10-27T10:00:00+08:00','2026-10-29T00:00:00+08:00'),allDay:false};
    const result=plan([event],3);
    expect(result.segments[0]).toMatchObject({start:1,end:2});
    expect(result.cells[3].reserved).toBe(0);
    const single={...make('single','2026-10-29T10:00:00+08:00','2026-10-29T11:00:00+08:00'),allDay:false};
    expect(plan([single],3).segments).toHaveLength(0);
  });
  it('两项只放得下一行时显示 +2，足够两行则恢复两项', () => {
    const events = [make('one'),make('two')];
    expect(plan(events,1).cells[3]).toMatchObject({ visible:[], reserved:0, overflow:2 });
    expect(plan(events,2).cells[3]).toMatchObject({ overflow:0 });
    expect(plan(events,2).cells[3].visible).toHaveLength(2);
  });
  it('有多行时也给 +N 留一整行，不和胶囊重叠', () => {
    const cell = plan([make('one'),make('two'),make('three')],2).cells[3];
    expect(cell.visible).toHaveLength(1); expect(cell.overflow).toBe(2);
  });
  it('跨天胶囊经过折叠日期时分段，不遮挡 +N', () => {
    const result = plan([make('span','2026-10-27','2026-11-01'),make('single')],1);
    expect(result.cells[3].overflow).toBe(2);
    expect(result.segments.map(span => [span.start,span.end])).toEqual([[1,2],[4,5]]);
    expect(result.segments[0].continuesRight).toBe(true); expect(result.segments[1].continuesLeft).toBe(true);
  });
  it('只有一项仍显示标题，草稿预览优先保留', () => {
    expect(plan([make('one')],1).cells[3].visible).toHaveLength(1);
    const result = plan([{ ...make('draft'),draft:true },make('other')],1);
    expect(result.cells[3].overflow).toBe(0); expect(result.segments[0].event.id).toBe('draft');
  });
  it('连续跨周胶囊完整保留独占日期的行和数量', () => {
    const result = plan([make('span','2026-10-24','2026-11-04')],1);
    expect(result.segments).toHaveLength(1); expect(result.segments[0]).toMatchObject({ start:0,end:6,continuesLeft:true,continuesRight:true });
    expect(result.cells.every(cell => cell.overflow === 0 && cell.reserved === 1)).toBe(true);
  });
});
