import { expect, it } from 'vitest';
import { editCalendar, editorInput } from '../src/ical/events';
import type { EventInput } from '../src/shared/contracts';
import type { Resource } from '../src/database/store';

const input: EventInput = { calendarId:'cal', title:'行程', start:'2026-10-29T10:00', end:'2026-10-29T11:00', timezone:'Asia/Shanghai', allDay:false, location:'', description:'', rrule:'', reminder:-1, scope:'series' };
const resource = (ics: string): Resource => ({ id:'r', calendarId:'cal', url:'https://example.com/cal/r.ics', etag:'"one"', ics, dirty:0, deleted:0 });

it('行程时间可保存和读取，并能单独移除，不改变事件时长', () => {
  const original = editCalendar({ ...input, travelMinutes:30 });
  expect(original).toContain('X-APPLE-TRAVEL-DURATION:PT30M');
  const detail = editorInput(resource(original),'series',undefined,'Asia/Shanghai');
  expect(detail.travelMinutes).toBe(30);
  const cleared = editCalendar({ ...detail,travelMinutes:0 },original);
  expect(cleared).not.toContain('X-APPLE-TRAVEL-DURATION');
  expect(editorInput(resource(cleared),'series',undefined,'Asia/Shanghai')).toMatchObject({ start:detail.start,end:detail.end,travelMinutes:0 });
});
it('未显式修改行程选项时保留外部扩展，不覆盖服务器未知属性', () => {
  const original = editCalendar(input).replace('SUMMARY:行程', 'X-APPLE-TRAVEL-DURATION:UNKNOWN\r\nSUMMARY:行程');
  const detail = editorInput(resource(original),'series',undefined,'Asia/Shanghai');
  expect(detail.travelMinutes).toBeUndefined();
  expect(editCalendar({ ...detail,title:'仅改标题' },original)).toContain('X-APPLE-TRAVEL-DURATION:UNKNOWN');
});
