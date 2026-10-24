import { describe, expect, it } from 'vitest';
import { calendarDateKey, describeChineseDate, getChineseCalendarDay } from '../src/calendar/chineseCalendar';

describe('农历与黄历（日期边界和独立参考日期）', () => {
  // Lunar date references: Hong Kong Observatory 2026 Gregorian–Lunar calendar,
  // https://www.hko.gov.hk/tc/gts/time/calendar/pdf/files/2026.pdf
  it('节日当天日格标签仍使用农历日期', () => {
    expect(getChineseCalendarDay('2026-02-17')).toMatchObject({ lunarDate: '正月初一', shortLabel: '正月', festivals: ['春节'], zodiac: '马' });
    expect(getChineseCalendarDay('2026-09-25')).toMatchObject({ lunarDate: '八月十五', shortLabel: '十五' });
  });
  it('日格保留农历日，黄历信息单独保留节气', () => {
    const day = getChineseCalendarDay('2026-10-23')!;
    expect(day).toMatchObject({ lunarDate: '九月十四', shortLabel: '十四', solarTerm: '霜降', dayGanZhi: '庚午' });
    expect(day.yi).toContain('嫁娶'); expect(day.ji).toContain('探病');
    expect(day.chongSha).toBe('冲(甲子)鼠 · 煞北');
  });
  it('闰月首日展示完整闰月名称', () => {
    expect(getChineseCalendarDay('2025-07-25')).toMatchObject({ lunarDate: '闰六月初一', shortLabel: '闰六月' });
  });
  it('普通日期展示农历日，初一展示农历月', () => {
    expect(getChineseCalendarDay('2026-10-24')!.shortLabel).toBe('十五');
    expect(getChineseCalendarDay('2026-10-10')!.shortLabel).toBe('九月');
  });
  it('从日历显示时区推导日期，午夜和夏令时不受宿主机时区影响', () => {
    const instant = new Date('2026-10-22T16:00:00Z');
    expect(calendarDateKey(instant, 'Asia/Shanghai')).toBe('2026-10-23');
    expect(calendarDateKey(instant, 'America/New_York')).toBe('2026-10-22');
    expect(getChineseCalendarDay(calendarDateKey(instant, 'Asia/Shanghai'))!.solarTerm).toBe('霜降');
    expect(calendarDateKey(new Date('2026-03-08T07:30:00Z'), 'America/New_York')).toBe('2026-03-08');
  });
  it('无效日期或范围外不会生成伪农历', () => {
    for (const date of ['2026-02-30', '2026-2-17', 'invalid', '1900-12-31', '2100-01-01']) expect(getChineseCalendarDay(date)).toBeNull();
    expect(describeChineseDate('2026-10-23')).toContain('农历九月十四 · 霜降');
  });
});
