import { describe, expect, it } from 'vitest';
import { yearMonths } from '../src/calendar/yearLayout';
import { draftEvent } from '../src/calendar/draftEvent';
import { weekEventSpans } from '../src/calendar/eventDisplay';
import type { EventInput } from '../src/shared/contracts';

const input: EventInput = { calendarId: 'cal', title: '', start: '2026-10-29T10:00', end: '2026-10-29T11:00', allDay: false, timezone: 'Asia/Shanghai', location: '', description: '', rrule: '', reminder: -1, scope: 'series' };
describe('全年概览', () => {
  it('全年十二个月各有六周，标记真实农历初一', () => {
    const months = yearMonths(2026, 0, 'Asia/Shanghai');
    expect(months).toHaveLength(12); expect(months.every(month => month.days.length === 42)).toBe(true);
    expect(months[0].days[0].date).toBe('2025-12-28');
    expect(months[0].days.find(day => day.date === '2026-01-19')?.lunarFirst).toBe(true);
    expect(months[1].days.find(day => day.date === '2026-02-17')?.lunarFirst).toBe(true);
    expect(months[1].days.find(day => day.date === '2026-02-18')?.lunarFirst).toBe(false);
  });
  it('尊重周起始设置，包含闰年的二月二十九日', () => {
    const months = yearMonths(2028, 1, 'America/New_York');
    expect(months[0].days[0].date).toBe('2027-12-27');
    expect(months[1].days.find(day => day.date === '2028-02-29')?.outside).toBe(false);
  });
});
describe('未保存日程预览', () => {
  it('空标题有占位，输入标题后跟随且不成为待同步修改', () => {
    expect(draftEvent(input, 60)).toMatchObject({ title: '新建日程', draft: true, pending: false, allDay: false, resourceId: '' });
    expect(draftEvent({ ...input, title: '准备会议' }, 60)?.title).toBe('准备会议');
    expect(draftEvent(null, 60)).toBeNull();
    expect(draftEvent({ ...input, resourceId: 'existing' }, 60)).toBeNull();
  });
  it('全天范围与用户修改日期跟随，暂时无效的结束不破坏预览', () => {
    expect(draftEvent({ ...input, allDay: true, start: '2026-10-29', end: '2026-11-02' }, 60)).toMatchObject({ allDay: true, start: '2026-10-29', end: '2026-11-02' });
    expect(draftEvent({ ...input, start: '2026-11-18T10:00' }, 90)?.end).toBe('2026-11-18T11:30:00.000+08:00');
    expect(draftEvent({ ...input, start: '' }, 60)).toBeNull();
  });
  it('繁忙周预览优先显示，前后的不重叠日程仍能共用首行', () => {
    const draft = draftEvent(input, 60)!;
    const past = { ...draft, id: 'past', draft: false, allDay: true, start: '2026-10-26', end: '2026-10-28' };
    const future = { ...past, id: 'future', start: '2026-10-30', end: '2026-11-02' };
    const spans = weekEventSpans([past, future, draft], ['2026-10-26','2026-10-27','2026-10-28','2026-10-29','2026-10-30','2026-10-31','2026-11-01'], 'Asia/Shanghai');
    expect(spans[0].event.id).toBe(draft.id); expect(spans.every(span => span.lane === 0)).toBe(true);
  });
});
