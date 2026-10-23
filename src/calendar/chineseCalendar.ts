import { Solar } from 'lunar-typescript';
import { DateTime } from 'luxon';
import { describeHoliday, getChinaHoliday, type HolidayDay } from './chinaHolidays';

export interface ChineseCalendarDay {
  date: string;
  lunarDate: string;
  lunarYear: string;
  shortLabel: string;
  solarTerm: string;
  festivals: string[];
  yearGanZhi: string;
  monthGanZhi: string;
  dayGanZhi: string;
  zodiac: string;
  yi: string[];
  ji: string[];
  chongSha: string;
  god: string;
  godLuck: string;
  wealthDirection: string;
  joyDirection: string;
  pengZu: string;
  holiday?: HolidayDay;
}
const cache = new Map<string, ChineseCalendarDay>();
const chineseSolarFestivals = new Set(['元旦节', '妇女节', '植树节', '消费者权益日', '劳动节', '青年节', '儿童节', '建党节', '建军节', '教师节', '国庆节']);
/** Interpret a civil date directly. Never convert midnight through the host's
 * timezone: Chinese calendars are date based, and solar terms use Beijing dates. */
export function getChineseCalendarDay(date: string): ChineseCalendarDay | null {
  const dt = DateTime.fromISO(date, { zone: 'UTC' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || !dt.isValid || dt.year < 1901 || dt.year > 2099) return null;
  const cached = cache.get(date); if (cached) return cached;
  const solar = Solar.fromYmd(dt.year, dt.month, dt.day), lunar = solar.getLunar();
  const month = `${lunar.getMonthInChinese()}月`, lunarDay = lunar.getDayInChinese();
  const festivals = [...new Set([...lunar.getFestivals(), ...solar.getFestivals().filter(s => chineseSolarFestivals.has(s)).map(s => s === '元旦节' ? '元旦' : s)])];
  const solarTerm = lunar.getJieQi();
  const day: ChineseCalendarDay = {
    date, lunarDate: `${month}${lunarDay}`, lunarYear: lunar.getYearInChinese(),
    shortLabel: solarTerm || festivals[0] || (lunar.getDay() === 1 ? month : lunarDay), solarTerm, festivals,
    yearGanZhi: lunar.getYearInGanZhi(), monthGanZhi: lunar.getMonthInGanZhi(), dayGanZhi: lunar.getDayInGanZhi(), zodiac: lunar.getYearShengXiao(),
    yi: lunar.getDayYi(), ji: lunar.getDayJi(), chongSha: `冲${lunar.getDayChongDesc()} · 煞${lunar.getDaySha()}`,
    god: lunar.getDayTianShen(), godLuck: lunar.getDayTianShenLuck(), wealthDirection: lunar.getDayPositionCaiDesc(), joyDirection: lunar.getDayPositionXiDesc(), pengZu: `${lunar.getPengZuGan()}；${lunar.getPengZuZhi()}`,
    holiday: getChinaHoliday(date),
  };
  if (cache.size >= 512) cache.delete(cache.keys().next().value!);
  cache.set(date, day); return day;
}
export function describeChineseDate(date: string): string {
  const d = getChineseCalendarDay(date);
  return [date, d ? `农历${d.lunarDate}` : '农历支持1901–2099年', d?.solarTerm, ...(d?.festivals ?? []), describeHoliday(date)].filter(Boolean).join(' · ');
}
/** Calendar libraries provide actual JS instants; project the instant into the
 * selected display timezone before deriving its civil day (including DST). */
export function calendarDateKey(date: Date, timezone: string): string { return DateTime.fromJSDate(date).setZone(timezone).toISODate() ?? ''; }
