import { DateTime } from 'luxon';
import { Solar } from 'lunar-typescript';
import { monthDays } from './monthLayout';

const labels = ['一月','二月','三月','四月','五月','六月','七月','八月','九月','十月','十一月','十二月'];
/** Only lunar month starts are needed here; avoid calculating a full almanac for every day. */
export function yearMonths(year: number, firstDay: number, timezone: string) {
  const starts = new Map<string, boolean>();
  return labels.map((label, index) => {
    const month = DateTime.fromObject({ year, month: index + 1, day: 1 }, { zone: timezone }).toISODate()!;
    return { month, label, days: monthDays(month, firstDay, timezone).map(date => {
      if (!starts.has(date)) {
        const [y, m, d] = date.split('-').map(Number);
        starts.set(date, y >= 1901 && y <= 2099 && Solar.fromYmd(y, m, d).getLunar().getDay() === 1);
      }
      return { date, day: Number(date.slice(8)), outside: date.slice(0, 7) !== month.slice(0, 7), lunarFirst: starts.get(date)! };
    }) };
  });
}
