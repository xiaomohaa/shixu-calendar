import { memo, useMemo } from 'react';
import { DateTime } from 'luxon';
import { yearMonths } from '../calendar/yearLayout';

export const YearGrid = memo(function YearGrid({ year, firstDay, timezone, now, openMonth, create }: {
  year: number; firstDay: number; timezone: string; now: number;
  openMonth(date: string): void; create(date: string): void;
}) {
  const months = useMemo(() => yearMonths(year, firstDay, timezone), [year, firstDay, timezone]);
  const today = DateTime.fromMillis(now).setZone(timezone).toISODate();
  return <section className="year-grid" aria-label={`${year}年全年日历`}>
    {months.map(month => <section className="year-month" key={month.month} aria-label={`${year}年${Number(month.month.slice(5, 7))}月`}>
      <h2><button className="year-month-title" onClick={() => openMonth(month.month)}>{month.label}</button></h2>
      <div className="year-weekdays">{Array.from({ length: 7 }, (_, i) => <span key={i}>{['日','一','二','三','四','五','六'][(firstDay + i) % 7]}</span>)}</div>
      <div className="year-days">{month.days.map(day => <button key={day.date} className={`year-day ${day.outside ? 'other-month' : ''} ${!day.outside && day.date === today ? 'is-today' : ''} ${!day.outside && day.lunarFirst ? 'lunar-first' : ''}`}
        aria-label={`${day.date}${day.lunarFirst ? '，农历初一' : ''}`} title={`${day.date}${day.lunarFirst ? ' · 农历初一' : ''}`} onDoubleClick={() => create(day.date)} onKeyDown={event => { if (event.key === 'Enter') { event.preventDefault(); openMonth(day.date); } }}><span>{day.day}</span></button>)}</div>
    </section>)}
  </section>;
});
