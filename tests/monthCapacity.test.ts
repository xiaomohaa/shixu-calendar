import { expect, it } from 'vitest';
import { monthLayout } from '../src/calendar/monthLayout';
import { weekDisplay } from '../src/calendar/weekDisplay';
import { groupMonthEvents, monthDays } from '../src/calendar/monthLayout';
import type { CalendarEvent } from '../src/shared/contracts';

it('77px 日格能显示三行，不为旧日期栏和末行行距预留空白', () => {
  expect(monthLayout(900,77 * 6).capacity).toBe(3);
  expect(monthLayout(900,76 * 6).capacity).toBe(2);
  expect(monthLayout(900,59 * 6).capacity).toBe(2);
  expect(monthLayout(900,58 * 6).capacity).toBe(1);
});
it('测量到紧凑日期栏时按实际21px计算，并使用最短的周行高度', () => {
  expect(monthLayout(900,900,{ rowHeight:74,headerHeight:21,bottomSpace:1 }).capacity).toBe(3);
  expect(monthLayout(900,900,{ rowHeight:73,headerHeight:21,bottomSpace:1 }).capacity).toBe(2);
});
it('高窗口不再将日程行数限制为五行', () => {
  expect(monthLayout(900,1100).capacity).toBeGreaterThan(5);
  expect(monthLayout(900,1600).capacity).toBe(13);
});
it('有三行空间时，截图中的三项全部显示；仅够两行才使用1项和+2个', () => {
  const days = monthDays('2026-10-01',1,'Asia/Shanghai').slice(21,28);
  const events: CalendarEvent[] = Array.from({ length:3 },(_,index) => ({ id:String(index),resourceId:String(index),calendarId:'c',uid:String(index),title:`日程${index}`,start:'2026-10-20',end:'2026-10-21',allDay:true,timezone:'Asia/Shanghai',location:'',description:'',rrule:'',reminder:-1,recurring:false,pending:false,conflict:false }));
  const groups = groupMonthEvents(events,days,'Asia/Shanghai'), index = days.indexOf('2026-10-20');
  const full = weekDisplay(events,days,groups,'Asia/Shanghai',monthLayout(900,77*6).capacity).cells[index];
  expect(full.visible).toHaveLength(3); expect(full.overflow).toBe(0);
  const smaller = weekDisplay(events,days,groups,'Asia/Shanghai',monthLayout(900,76*6).capacity).cells[index];
  expect(smaller.visible).toHaveLength(1); expect(smaller.overflow).toBe(2);
});
