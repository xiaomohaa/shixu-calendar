/** Mainland China holiday schedules, transcribed from State Council notices.
 * Ranges are inclusive and include the weekends within each announced break.
 * No schedule is inferred for a year that has not been included here.
 * Verification sources and publication dates: docs/CHINESE_CALENDAR.md. */
import { DateTime } from 'luxon';

export interface HolidaySchedule {
  name: string;
  start: string;
  end: string;
  workdays: readonly string[];
}
export const holidaySchedules: Readonly<Record<number, readonly HolidaySchedule[]>> = {
  2024: [
    { name: '元旦', start: '2023-12-30', end: '2024-01-01', workdays: [] },
    { name: '春节', start: '2024-02-10', end: '2024-02-17', workdays: ['2024-02-04', '2024-02-18'] },
    { name: '清明节', start: '2024-04-04', end: '2024-04-06', workdays: ['2024-04-07'] },
    { name: '劳动节', start: '2024-05-01', end: '2024-05-05', workdays: ['2024-04-28', '2024-05-11'] },
    { name: '端午节', start: '2024-06-08', end: '2024-06-10', workdays: [] },
    { name: '中秋节', start: '2024-09-15', end: '2024-09-17', workdays: ['2024-09-14'] },
    { name: '国庆节', start: '2024-10-01', end: '2024-10-07', workdays: ['2024-09-29', '2024-10-12'] },
  ],
  2025: [
    { name: '元旦', start: '2025-01-01', end: '2025-01-01', workdays: [] },
    { name: '春节', start: '2025-01-28', end: '2025-02-04', workdays: ['2025-01-26', '2025-02-08'] },
    { name: '清明节', start: '2025-04-04', end: '2025-04-06', workdays: [] },
    { name: '劳动节', start: '2025-05-01', end: '2025-05-05', workdays: ['2025-04-27'] },
    { name: '端午节', start: '2025-05-31', end: '2025-06-02', workdays: [] },
    { name: '国庆节、中秋节', start: '2025-10-01', end: '2025-10-08', workdays: ['2025-09-28', '2025-10-11'] },
  ],
  2026: [
    { name: '元旦', start: '2026-01-01', end: '2026-01-03', workdays: ['2026-01-04'] },
    { name: '春节', start: '2026-02-15', end: '2026-02-23', workdays: ['2026-02-14', '2026-02-28'] },
    { name: '清明节', start: '2026-04-04', end: '2026-04-06', workdays: [] },
    { name: '劳动节', start: '2026-05-01', end: '2026-05-05', workdays: ['2026-05-09'] },
    { name: '端午节', start: '2026-06-19', end: '2026-06-21', workdays: [] },
    { name: '中秋节', start: '2026-09-25', end: '2026-09-27', workdays: [] },
    { name: '国庆节', start: '2026-10-01', end: '2026-10-07', workdays: ['2026-09-20', '2026-10-10'] },
  ],
};
export interface HolidayDay { kind: 'rest' | 'work'; name: string; schedule: HolidaySchedule }
const holidayDays = new Map<string, HolidayDay>();
for (const schedules of Object.values(holidaySchedules)) for (const schedule of schedules) {
  for (let day = DateTime.fromISO(schedule.start, { zone: 'UTC' }); day.toISODate()! <= schedule.end; day = day.plus({ days: 1 })) holidayDays.set(day.toISODate()!, { kind: 'rest', name: schedule.name, schedule });
  for (const day of schedule.workdays) holidayDays.set(day, { kind: 'work', name: schedule.name, schedule });
}
export function getChinaHoliday(date: string): HolidayDay | undefined { return holidayDays.get(date); }
export function hasHolidaySchedule(year: number) { return Object.hasOwn(holidaySchedules, year); }
export function describeHoliday(date: string): string {
  const day = getChinaHoliday(date);
  if (day) return `${day.name} · ${day.kind === 'work' ? '调休上班' : '放假休息'}`;
  const dt = DateTime.fromISO(date, { zone: 'UTC' });
  if (!hasHolidaySchedule(dt.year)) return `${dt.year}年放假调休安排未收录`;
  return dt.weekday >= 6 ? '周末休息' : '常规工作日';
}
