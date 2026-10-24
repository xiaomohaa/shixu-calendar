import { describe, expect, it } from 'vitest';
import { newEventTime } from '../src/calendar/newEventTime';
import { popoverLayout } from '../src/renderer/popoverLayout';

describe('日期双击的新建时间', () => {
  const now = Date.parse('2026-10-24T02:35:42Z');
  it('使用点击的日期和显示时区的当前整点', () => {
    const start = newEventTime('2026-10-29', 'Asia/Shanghai', false, now);
    expect(start.toFormat('yyyy-MM-dd HH:mm:ss')).toBe('2026-10-29 10:00:00');
    expect(start.plus({ minutes: 90 }).toFormat('yyyy-MM-dd HH:mm')).toBe('2026-10-29 11:30');
  });
  it('不把当前 23 点滚到点击日期的下一天，结束时间可跨天', () => {
    const start = newEventTime('2026-12-31', 'Asia/Shanghai', false, Date.parse('2026-10-24T15:35:00Z'));
    expect(start.toFormat('yyyy-MM-dd HH:mm')).toBe('2026-12-31 23:00');
    expect(start.plus({ minutes: 120 }).toFormat('yyyy-MM-dd HH:mm')).toBe('2027-01-01 01:00');
  });
  it('保留明确指定的时间和全天日期', () => {
    expect(newEventTime('2026-10-29T09:30', 'Asia/Shanghai', false, now).hour).toBe(9);
    expect(newEventTime('2026-10-29', 'Asia/Shanghai', true, now).hour).toBe(0);
  });
});
describe('新建浮层避让窗口边缘', () => {
  it('有空间时在日格右侧，靠右时在左侧', () => {
    expect(popoverLayout({ left: 100, right: 200, top: 300, bottom: 400 }, 400, 600, 1380, 900).side).toBe('right');
    const right = popoverLayout({ left: 1150, right: 1300, top: 700, bottom: 800 }, 400, 600, 1380, 900);
    expect(right.side).toBe('left'); expect(right.top + 600).toBeLessThanOrEqual(888);
  });
  it('最小窗口浮层居中且所有边保持可见', () => {
    const result = popoverLayout({ left: 400, right: 470, top: 300, bottom: 350 }, 400, 336, 480, 360);
    expect(result.side).toBe('center'); expect(result.left).toBe(40); expect(result.top).toBe(12);
  });
});
