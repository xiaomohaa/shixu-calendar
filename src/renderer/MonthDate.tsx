import { getChineseCalendarDay, calendarDateKey, describeChineseDate } from '../calendar/chineseCalendar';

export function MonthDate({ date, timezone, dayText }: { date: Date; timezone: string; dayText: string }) {
  const key = calendarDateKey(date, timezone), chinese = getChineseCalendarDay(key);
  return <span className="month-date-content" data-month-start={key.endsWith('-01')} title={describeChineseDate(key)}>
    <span className="solar-date">{Number(dayText.replace('日', '')) === 1 ? `${Number(key.slice(5, 7))}月1日` : `${Number(dayText.replace('日', ''))}日`}</span>
    <span className="lunar-date">{chinese?.shortLabel ?? ''}</span>
  </span>;
}
