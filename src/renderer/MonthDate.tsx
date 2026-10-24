import { getChineseCalendarDay, calendarDateKey, describeChineseDate } from '../calendar/chineseCalendar';

export function MonthDate({ date, timezone, dayText }: { date: Date; timezone: string; dayText: string }) {
  const key = calendarDateKey(date, timezone), chinese = getChineseCalendarDay(key);
  return <span className="month-date-content" title={describeChineseDate(key)}>
    <span className="solar-date">{dayText.replace('日', '')}</span>
    <span className="lunar-date">{chinese?.shortLabel ?? ''}</span>
  </span>;
}
