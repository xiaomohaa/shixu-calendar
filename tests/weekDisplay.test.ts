import { describe, expect, it } from 'vitest';
import { weekDisplay } from '../src/calendar/weekDisplay';
import { groupMonthEvents } from '../src/calendar/monthLayout';
import type { CalendarEvent } from '../src/shared/contracts';

const days = ['2026-10-26','2026-10-27','2026-10-28','2026-10-29','2026-10-30','2026-10-31','2026-11-01'];
const make = (id: string, start = '2026-10-29', end = '2026-10-30'): CalendarEvent => ({ id, resourceId:id, calendarId:'cal', uid:id, title:id, start, end, allDay:true, timezone:'Asia/Shanghai', location:'', description:'', rrule:'', reminder:-1, recurring:false, pending:false, conflict:false });
const plan = (events: CalendarEvent[], capacity: number) => weekDisplay(events,days,groupMonthEvents(events,days,'Asia/Shanghai'),'Asia/Shanghai',capacity);
describe('日格行数不足时只显示数量', () => {
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
