import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { DateTime } from 'luxon';
import { Plus, Repeat2, X } from 'lucide-react';
import type { Calendar, CalendarEvent } from '../shared/contracts';
import { groupMonthEvents, monthDays, monthLayout } from '../calendar/monthLayout';
import { MonthDate } from './MonthDate';
import { eventDateRange, eventHasEnded, weekEventSpans } from '../calendar/eventDisplay';

interface Props {
  now: number; month: string; firstDay: number; timezone: string; selected: string; timeFormat: '24' | '12';
  events: CalendarEvent[]; calendars: Calendar[];
  select(date: string): void; create(start: string, end?: string, allDay?: boolean): void;
  open(event: CalendarEvent): void; move(event: CalendarEvent, day: string, origin: string): void;
}
const timeLabel = (event: CalendarEvent, zone: string, format: '24' | '12') => event.allDay ? '全天' : DateTime.fromISO(event.start).setZone(zone).toFormat(format === '12' ? 'h:mm a' : 'HH:mm');

/** Content never controls row size. Only this component observes its own grid;
 * resizing cannot cause range changes, database reads or FullCalendar reflow. */
export const MonthGrid = memo(function MonthGrid(p: Props) {
  const grid = useRef<HTMLDivElement>(null), popup = useRef<HTMLDivElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const [layout, setLayout] = useState(() => monthLayout(1200, 650)), [expanded, setExpanded] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null), [selection, setSelection] = useState<{ start: string; end: string } | null>(null);
  const dragStart = useRef<string | null>(null), popupOpener = useRef<HTMLElement | null>(null);
  const days = useMemo(() => monthDays(p.month, p.firstDay, p.timezone), [p.month, p.firstDay, p.timezone]);
  const groups = useMemo(() => groupMonthEvents(p.events, days, p.timezone), [p.events, days, p.timezone]);
  const weeks = useMemo(() => Array.from({ length: 6 }, (_, row) => weekEventSpans(p.events, days.slice(row * 7, row * 7 + 7), p.timezone)), [p.events, days, p.timezone]);
  const spanCapacity = layout.capacity;
  const colors = useMemo(() => new Map(p.calendars.map(calendar => [calendar.id, calendar])), [p.calendars]);
  const today = DateTime.now().setZone(p.timezone).toISODate();
  useLayoutEffect(() => {
    const element = grid.current; if (!element) return;
    let frame = 0;
    const measure = () => { const next = monthLayout(element.clientWidth, element.clientHeight); setLayout(old => old.compact === next.compact && old.capacity === next.capacity && old.inlineOverflow === next.inlineOverflow ? old : next); };
    measure();
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); });
    observer.observe(element); return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);
  useEffect(() => { setExpanded(null); setSelection(null); dragStart.current = null; }, [p.month]);
  useEffect(() => {
    if (!expanded) return;
    closeButton.current?.focus();
    const close = () => { setExpanded(null); popupOpener.current?.focus(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
    const outside = (event: PointerEvent) => { if (!popup.current?.contains(event.target as Node)) close(); };
    document.addEventListener('keydown', key); document.addEventListener('pointerdown', outside);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', outside); };
  }, [expanded]);
  useEffect(() => {
    const cancel = () => { dragStart.current = null; setSelection(null); };
    window.addEventListener('pointerup', cancel); window.addEventListener('blur', cancel);
    return () => { window.removeEventListener('pointerup', cancel); window.removeEventListener('blur', cancel); };
  }, []);
  const expand = (day: string, opener: HTMLElement) => { p.select(day); popupOpener.current = opener; setExpanded(day); };
  const color = (event: CalendarEvent) => colors.get(event.calendarId)?.color || '#d65c4f';
  const isWritable = (event: CalendarEvent) => !colors.get(event.calendarId)?.readOnly && !event.conflict;
  const eventButton = (event: CalendarEvent, day: string) => <button key={event.id} type="button" className={`month-event ${event.allDay ? 'event-capsule event-all-day' : 'event-timed'} ${event.pending ? 'event-pending' : ''} ${event.conflict ? 'event-conflict' : ''} ${eventHasEnded(event, p.timezone, p.now) ? 'event-ended' : ''}`}
    style={{ '--event-color': color(event) } as CSSProperties} aria-label={`${timeLabel(event, p.timezone, p.timeFormat)} ${event.title}${event.pending ? '，待同步' : ''}`}
    title={`${timeLabel(event, p.timezone, p.timeFormat)} ${event.title}${event.location ? ` · ${event.location}` : ''}`} draggable={isWritable(event)}
    onPointerDown={e => e.stopPropagation()} onDragStart={e => {
      e.stopPropagation();
      const week = e.currentTarget.closest('.month-week-row');
      const cells = week?.querySelectorAll<HTMLElement>('.month-cell');
      const rect = week?.getBoundingClientRect();
      const column = rect ? Math.min(6, Math.max(0, Math.floor((e.clientX - rect.left) / (rect.width / 7)))) : 0;
      const origin = e.currentTarget.closest('.month-span') ? cells?.[column]?.dataset.date || day : day;
      e.dataTransfer.setData('application/x-shixu-event', event.id);
      e.dataTransfer.setData('application/x-shixu-day', origin);
      e.dataTransfer.effectAllowed = 'move';
    }}
    onClick={e => { e.stopPropagation(); p.open(event); }} onDoubleClick={e => e.stopPropagation()}>
    <i className="event-color-dot"/>{<><span className="month-event-title">{event.title}</span>{event.recurring && <Repeat2 size={11}/>} {event.pending && <span className="pending-mark" aria-hidden="true">·</span>}</>}
  </button>;
  return <section className="month-view" role="grid" aria-label="月日历">
    <div className="month-weekdays" role="row">{Array.from({ length: 7 }, (_, i) => { const day = (p.firstDay + i) % 7; return <span role="columnheader" className={day === 0 || day === 6 ? 'weekend' : ''} key={day}>周{['日','一','二','三','四','五','六'][day]}</span>; })}</div>
    <div className="month-scroll"><div ref={grid} className={`month-grid ${layout.inlineOverflow ? 'inline-overflow' : ''}`} role="rowgroup" aria-label="月视图日期与日程" data-event-mode="capsules">
      {Array.from({ length: 6 }, (_, row) => <div role="row" className="month-week-row" key={row}>{days.slice(row * 7, row * 7 + 7).map(day => {
        const list = groups.get(day)!, dt = DateTime.fromISO(day, { zone: p.timezone });
        const activeRange = selection && day >= [selection.start, selection.end].sort()[0] && day <= [selection.start, selection.end].sort()[1];
        const spans = weeks[row].filter(span => span.lane < spanCapacity && day >= days[row * 7 + span.start] && day <= days[row * 7 + span.end]);
        const reserved = spans.reduce((count, span) => Math.max(count, span.lane + 1), 0);
        const singleDay = list.filter(event => { const range = eventDateRange(event, p.timezone); return range.start === range.end; });
        const limit = Math.max(0, layout.capacity - reserved);
        const visible = singleDay.slice(0, limit), overflow = list.length - visible.length - spans.length;
        return <div role="gridcell" tabIndex={0} aria-selected={day === p.selected} aria-label={`${dt.setLocale('zh-CN').toFormat('M月d日 cccc')}，${list.length} 项日程`} data-date={day} key={day}
          className={`month-cell ${day.slice(0, 7) !== p.month.slice(0, 7) ? 'other-month' : ''} ${day === today ? 'is-today' : ''} ${day === p.selected ? 'is-selected' : ''} ${dt.weekday > 5 ? 'weekend' : ''} ${dragOver === day ? 'drop-target' : ''} ${activeRange ? 'range-selected' : ''} ${overflow > 0 ? 'has-overflow' : ''}`}
          onClick={() => p.select(day)} onDoubleClick={e => { if (!(e.target as HTMLElement).closest('button')) p.create(day, undefined, true); }}
          onKeyDown={e => {
            if (e.target !== e.currentTarget) return;
            const offset = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<string, number>)[e.key];
            if (offset) { e.preventDefault(); const next = days[days.indexOf(day) + offset]; if (next) { p.select(next); grid.current?.querySelector<HTMLElement>(`[data-date="${next}"]`)?.focus(); } }
            if (e.key === 'Enter') { e.preventDefault(); p.select(day); if (e.ctrlKey || e.metaKey) p.create(day, undefined, true); else if (list.length) expand(day, e.currentTarget); }
          }}
          onPointerDown={e => { if (e.button === 0 && !(e.target as HTMLElement).closest('button')) dragStart.current = day; }}
          onPointerEnter={e => { if (dragStart.current && e.buttons === 1) setSelection({ start: dragStart.current, end: day }); }}
          onPointerUp={() => { if (dragStart.current && dragStart.current !== day) { const [start, last] = [dragStart.current, day].sort(); p.create(start, DateTime.fromISO(last).plus({ days: 1 }).toISODate()!, true); } dragStart.current = null; setSelection(null); }}
          onDragOver={e => { if (e.dataTransfer.types.includes('application/x-shixu-event')) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOver(day); } }}
          onDragLeave={() => setDragOver(null)} onDrop={e => { e.preventDefault(); setDragOver(null); const event = p.events.find(event => event.id === e.dataTransfer.getData('application/x-shixu-event')); if (event && isWritable(event)) p.move(event, day, e.dataTransfer.getData('application/x-shixu-day')); }}>
          <button className="month-day-button" type="button" aria-label={`选择 ${day}`} onClick={e => { e.stopPropagation(); p.select(day); }} onDoubleClick={e => { e.stopPropagation(); p.create(day, undefined, true); }}><MonthDate date={dt.toJSDate()} timezone={p.timezone} dayText={String(dt.day)}/></button>
          <div className="month-event-list" style={{ '--reserved-lanes': reserved } as CSSProperties}>{visible.map(event => eventButton(event, day))}
            {overflow > 0 && <button className="month-more" type="button" aria-label={`${day} 查看全部 ${list.length} 项日程`} onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); expand(day, e.currentTarget); }} onDoubleClick={e => e.stopPropagation()}>+{overflow}个</button>}
          </div>
        </div>;
      })}<div className="month-span-layer">{weeks[row].filter(span => span.lane < spanCapacity).map(span => <div key={span.event.id} className={`month-span ${span.continuesLeft ? 'continues-left' : ''} ${span.continuesRight ? 'continues-right' : ''}`} data-start={days[row * 7 + span.start]} data-end={days[row * 7 + span.end]} style={{ gridColumn: `${span.start + 1} / ${span.end + 2}`, gridRow: span.lane + 1 }}>{eventButton(span.event, days[row * 7 + span.start])}</div>)}</div></div>)}
    </div></div>
    {expanded && <div ref={popup} className="day-agenda" role="dialog" aria-modal="false" aria-label={`${expanded} 的全部日程`}>
      <header><div><strong>{DateTime.fromISO(expanded).setLocale('zh-CN').toFormat('M月d日 cccc')}</strong><span>{groups.get(expanded)?.length || 0} 项日程</span></div><button className="icon-button" aria-label="关闭当天日程" ref={closeButton} onClick={() => { setExpanded(null); popupOpener.current?.focus(); }}><X size={17}/></button></header>
      <div className="day-agenda-list">{groups.get(expanded)?.map(event => <button className={`agenda-event ${eventHasEnded(event, p.timezone, p.now) ? 'event-ended' : ''}`} style={{ '--event-color': color(event) } as CSSProperties} key={event.id} onClick={() => { setExpanded(null); p.open(event); }}><i className="event-color-dot"/><div><strong>{event.title}</strong></div>{event.pending && <small>待同步</small>}</button>)}</div>
      <button className="agenda-create" onClick={() => { setExpanded(null); p.create(expanded, undefined, true); }}><Plus size={15}/>新建日程</button>
    </div>}
  </section>;
});
