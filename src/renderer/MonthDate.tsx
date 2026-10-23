import { getChineseCalendarDay, calendarDateKey, describeChineseDate } from '../calendar/chineseCalendar';
import { getChinaHoliday } from '../calendar/chinaHolidays';

export function MonthDate({ date, timezone, dayText }: { date: Date; timezone: string; dayText: string }) {
  const key = calendarDateKey(date, timezone), chinese = getChineseCalendarDay(key), holiday = getChinaHoliday(key);
  const special = !!chinese?.solarTerm || !!chinese?.festivals.length;
  return <span className="month-date-content" title={describeChineseDate(key)}>
    <span className="solar-date">{dayText.replace('日', '')}</span>
    <span className={`lunar-date ${special ? 'special-date' : ''}`}>{chinese?.shortLabel ?? ''}</span>
    {holiday && <span className={`day-status month-holiday ${holiday.kind}`} aria-label={`${holiday.name}${holiday.kind === 'rest' ? '放假休息' : '调休上班'}`}>{holiday.kind === 'rest' ? '休' : '班'}</span>}
  </span>;
}
