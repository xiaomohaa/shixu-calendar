import { CalendarDays, Star } from 'lucide-react';

export function EventMark({ allDay, holiday = false }: { allDay: boolean; holiday?: boolean }) {
  if (!allDay) return <i className="event-color-dot event-color-bar" aria-hidden="true"/>;
  return <span className={`event-symbol ${holiday ? 'holiday-marker' : 'calendar-marker'}`} aria-hidden="true">
    {holiday ? <Star size={8} fill="currentColor" strokeWidth={1.5}/> : <CalendarDays size={8} strokeWidth={1.6}/>}
  </span>;
}
