import { describe, expect, it } from 'vitest';
import { calendarDateKey, describeChineseDate, getChineseCalendarDay } from '../src/calendar/chineseCalendar';
import { describeHoliday, getChinaHoliday, hasHolidaySchedule } from '../src/calendar/chinaHolidays';

describe('农历与黄历（日期边界和独立参考日期）', () => {
  // Lunar date references: Hong Kong Observatory 2026 Gregorian–Lunar calendar,
  // https://www.hko.gov.hk/tc/gts/time/calendar/pdf/files/2026.pdf
  it('春节与中秋显示农历和传统节日', () => {
    expect(getChineseCalendarDay('2026-02-17')).toMatchObject({ lunarDate: '正月初一', shortLabel: '春节', festivals: ['春节'], zodiac: '马' });
    expect(getChineseCalendarDay('2026-09-25')).toMatchObject({ lunarDate: '八月十五', shortLabel: '中秋节' });
  });
  it('节气优先显示，同时保留完整农历日期', () => {
    const day = getChineseCalendarDay('2026-10-23')!;
    expect(day).toMatchObject({ lunarDate: '九月十四', shortLabel: '霜降', solarTerm: '霜降', dayGanZhi: '庚午' });
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

describe('中国大陆放假调休（国务院办公厅通知）', () => {
  it('2026 年全部公告放假日和补班日与官方日期一致', () => {
    const ranges = [ ['01-01','01-03'], ['02-15','02-23'], ['04-04','04-06'], ['05-01','05-05'], ['06-19','06-21'], ['09-25','09-27'], ['10-01','10-07'] ];
    let count = 0;
    for (const [start, end] of ranges) for (let day = Number(start.slice(3)); day <= Number(end.slice(3)); day++) {
      expect(getChinaHoliday(`2026-${start.slice(0, 2)}-${String(day).padStart(2,'0')}`)?.kind).toBe('rest'); count++;
    }
    expect(count).toBe(33);
    for (const date of ['2026-01-04','2026-02-14','2026-02-28','2026-05-09','2026-09-20','2026-10-10']) expect(getChinaHoliday(date)?.kind).toBe('work');
  });
  it('普通周末不误标法定放假，补班覆盖周末', () => {
    expect(getChinaHoliday('2026-10-24')).toBeUndefined();
    expect(describeHoliday('2026-10-24')).toBe('周末休息');
    expect(describeHoliday('2026-10-10')).toBe('国庆节 · 调休上班');
    expect(describeHoliday('2026-10-08')).toBe('常规工作日');
  });
  it('春节前后边界和周末补班不扩展到相邻日', () => {
    expect(getChinaHoliday('2026-02-13')).toBeUndefined();
    expect(describeHoliday('2026-02-14')).toBe('春节 · 调休上班');
    expect(describeHoliday('2026-02-15')).toBe('春节 · 放假休息');
    expect(getChinaHoliday('2026-02-24')).toBeUndefined();
  });
  it('处理 2025 中秋国庆合并、2024 鼓励休假与跨年元旦', () => {
    expect(getChinaHoliday('2025-10-08')).toMatchObject({ kind: 'rest', name: '国庆节、中秋节' });
    expect(getChinaHoliday('2025-10-11')?.kind).toBe('work');
    expect(getChinaHoliday('2024-02-09')).toBeUndefined();
    expect(getChinaHoliday('2023-12-30')).toMatchObject({ kind: 'rest', name: '元旦' });
  });
  it('未收录年份不根据节日或周末猜测调休', () => {
    expect(hasHolidaySchedule(2026)).toBe(true); expect(hasHolidaySchedule(2027)).toBe(false);
    expect(getChinaHoliday('2027-10-01')).toBeUndefined();
    expect(describeHoliday('2027-10-01')).toBe('2027年放假调休安排未收录');
    expect(getChineseCalendarDay('2027-10-01')!.festivals).toContain('国庆节');
  });
});
