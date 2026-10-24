import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { DateTime } from 'luxon';
import { Plus, Repeat2, X } from 'lucide-react';
import type { Calendar, CalendarEvent } from '../shared/contracts';
import { groupMonthEvents, monthDays, monthLayout, MONTH_EVENT_HEIGHT, MONTH_EVENT_LANE } from '../calendar/monthLayout';
import { MonthDate } from './MonthDate';
import type { PanelAnchor } from './popoverLayout';
import { EventMark } from './EventMark';
import { weekDisplay } from '../calendar/weekDisplay';

interface Props {
  now: number; month: string; firstDay: number; timezone: string; selected: string; timeFormat: '24' | '12';
  events: CalendarEvent[]; calendars: Calendar[]; holidays: Set<string>;
  select(date: string): void; create(start: string, end?: string, allDay?: boolean, anchor?: PanelAnchor): void;
  open(event: CalendarEvent): void; move(event: CalendarEvent, day: string, origin: string): void;
}
const timeLabel = (event: CalendarEvent, zone: string, format: '24' | '12') => event.allDay ? '全天' : DateTime.fromISO(event.start).setZone(zone).toFormat(format === '12' ? 'h:mm a' : 'HH:mm');

/** Content never controls row size. Only this component observes its own grid;
 * resizing cannot cause range changes, database reads or FullCalendar reflow. */
export const MonthGrid = memo(function MonthGrid(p: Props) {
  const grid = useRef<HTMLDivElement>(null), popup = useRef<HTMLDivElement>(null), closeButton = useRef<HTMLButtonElement>(null);
  const [layout, setLayout] = useState(() => monthLayout(1200, 650)), [expanded, setExpanded] = useState<string | null>(null);
  const [dragOver, setDragOver] = useState<string | null>(null);
  const popupOpener = useRef<HTMLElement | null>(null);
  const days = useMemo(() => monthDays(p.month, p.firstDay, p.timezone), [p.month, p.firstDay, p.timezone]);
  const groups = useMemo(() => groupMonthEvents(p.events, days, p.timezone), [p.events, days, p.timezone]);
  const weeks = useMemo(() => Array.from({ length: 6 }, (_, row) => weekDisplay(p.events, days.slice(row * 7, row * 7 + 7), groups, p.timezone, layout.capacity)), [p.events, days, groups, p.timezone, layout.capacity]);
  const colors = useMemo(() => new Map(p.calendars.map(calendar => [calendar.id, calendar])), [p.calendars]);
  const today = DateTime.now().setZone(p.timezone).toISODate();
  useLayoutEffect(() => {
    const element = grid.current; if (!element) return;
    let frame = 0;
    const measure = () => {
      const rows = Array.from(element.querySelectorAll<HTMLElement>('.month-week-row'));
      const cell = element.querySelector<HTMLElement>('.month-cell'), header = element.querySelector<HTMLElement>('.month-day-button'), list = element.querySelector<HTMLElement>('.month-event-list');
      const bottomSpace = (cell ? parseFloat(getComputedStyle(cell).borderBottomWidth) : 1) + (list ? parseFloat(getComputedStyle(list).paddingBottom) : 0);
      const next = monthLayout(element.clientWidth, element.clientHeight, {
        rowHeight: rows.length ? Math.min(...rows.map(row => row.getBoundingClientRect().height)) : undefined,
        headerHeight: header?.getBoundingClientRect().height,
        bottomSpace, eventHeight: MONTH_EVENT_HEIGHT, laneHeight: MONTH_EVENT_LANE,
      });
      setLayout(old => old.compact === next.compact && old.capacity === next.capacity && old.inlineOverflow === next.inlineOverflow ? old : next);
    };
    measure();
    const observer = new ResizeObserver(() => { cancelAnimationFrame(frame); frame = requestAnimationFrame(measure); });
    observer.observe(element); return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, []);
  useEffect(() => { setExpanded(null); }, [p.month]);
  useEffect(() => {
    if (!expanded) return;
    closeButton.current?.focus();
    const close = () => { setExpanded(null); popupOpener.current?.focus(); };
    const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); close(); } };
    const outside = (event: PointerEvent) => { if (!popup.current?.contains(event.target as Node)) close(); };
    document.addEventListener('keydown', key); document.addEventListener('pointerdown', outside);
    return () => { document.removeEventListener('keydown', key); document.removeEventListener('pointerdown', outside); };
  }, [expanded]);
  const expand = (day: string, opener: HTMLElement) => { p.select(day); popupOpener.current = opener; setExpanded(day); };
  const color = (event: CalendarEvent) => colors.get(event.calendarId)?.color || '#d65c4f';
  const isWritable = (event: CalendarEvent) => !event.draft && !colors.get(event.calendarId)?.readOnly && !event.conflict;
  const eventButton = (event: CalendarEvent, day: string) => <button key={event.id} type="button" className={`month-event ${event.allDay ? 'event-capsule event-all-day' : 'event-timed'} ${event.draft ? 'event-draft' : ''} ${event.pending ? 'event-pending' : ''} ${event.conflict ? 'event-conflict' : ''} `}
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
    onClick={e => { e.stopPropagation(); if (!event.draft) p.open(event); }} onDoubleClick={e => e.stopPropagation()}>
    <EventMark allDay={event.allDay} holiday={p.holidays.has(event.calendarId)}/><span className="month-event-title">{event.title}</span>{event.recurring && <Repeat2 size={11}/>} {event.pending && <span className="pending-mark" aria-hidden="true">·</span>}
  </button>;
  return <section className="month-view" role="grid" aria-label="月日历">
    <div className="month-weekdays" role="row">{Array.from({ length: 7 }, (_, i) => { const day = (p.firstDay + i) % 7; return <span role="columnheader" className={day === 0 || day === 6 ? 'weekend' : ''} key={day}>周{['日','一','二','三','四','五','六'][day]}</span>; })}</div>
    <div className="month-scroll"><div ref={grid} className={`month-grid ${layout.inlineOverflow ? 'inline-overflow' : ''}`} style={{ '--event-lane-height': `${MONTH_EVENT_LANE}px` } as CSSProperties} role="rowgroup" aria-label="月视图日期与日程" data-event-mode="capsules" data-event-capacity={layout.capacity}>
      {Array.from({ length: 6 }, (_, row) => <div role="row" className="month-week-row" key={row}>{days.slice(row * 7, row * 7 + 7).map(day => {
        const list = groups.get(day)!, dt = DateTime.fromISO(day, { zone: p.timezone });
        const { visible, reserved, overflow } = weeks[row].cells[days.indexOf(day) % 7];
        return <div role="gridcell" tabIndex={0} aria-selected={false} aria-label={`${dt.setLocale('zh-CN').toFormat('M月d日 cccc')}，${list.length} 项日程`} data-date={day} key={day}
          className={`month-cell ${day.slice(0, 7) !== p.month.slice(0, 7) ? 'other-month' : ''} ${day === today ? 'is-today' : ''} ${dt.weekday > 5 ? 'weekend' : ''} ${dragOver === day ? 'drop-target' : ''} ${overflow > 0 ? 'has-overflow' : ''}`}
          onDoubleClick={e => { if (!(e.target as HTMLElement).closest('button')) { p.select(day); p.create(day, undefined, false, e.currentTarget.getBoundingClientRect()); } }}
          onKeyDown={e => {
            if (e.target !== e.currentTarget) return;
            const offset = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<string, number>)[e.key];
            if (offset) { e.preventDefault(); const next = days[days.indexOf(day) + offset]; if (next) { p.select(next); grid.current?.querySelector<HTMLElement>(`[data-date="${next}"]`)?.focus(); } }
            if (e.key === 'Enter') { e.preventDefault(); p.select(day); if (e.ctrlKey || e.metaKey) p.create(day, undefined, true); else if (list.length) expand(day, e.currentTarget); }
          }}
          onDragOver={e => { if (e.dataTransfer.types.includes('application/x-shixu-event')) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; setDragOver(day); } }}
          onDragLeave={() => setDragOver(null)} onDrop={e => { e.preventDefault(); setDragOver(null); const event = p.events.find(event => event.id === e.dataTransfer.getData('application/x-shixu-event')); if (event && isWritable(event)) p.move(event, day, e.dataTransfer.getData('application/x-shixu-day')); }}>
          <button className="month-day-button" type="button" aria-label={`选择 ${day}`} onClick={e => e.stopPropagation()} onDoubleClick={e => { e.stopPropagation(); p.select(day); p.create(day, undefined, false, e.currentTarget.closest('.month-cell')!.getBoundingClientRect()); }}><MonthDate date={dt.toJSDate()} timezone={p.timezone} dayText={String(dt.day)}/></button>
          <div className="month-event-list" style={{ '--reserved-lanes': reserved } as CSSProperties}>{visible.map(event => eventButton(event, day))}
            {overflow > 0 && <button className="month-more" type="button" aria-label={`${day} 查看全部 ${list.length} 项日程`} onPointerDown={e => e.stopPropagation()} onClick={e => { e.stopPropagation(); expand(day, e.currentTarget); }} onDoubleClick={e => e.stopPropagation()}>+{overflow}个</button>}
          </div>
        </div>;
      })}<div className="month-span-layer">{weeks[row].segments.map(span => <div key={`${span.event.id}:${span.start}`} className={`month-span ${span.continuesLeft ? 'continues-left' : ''} ${span.continuesRight ? 'continues-right' : ''}`} data-start={days[row * 7 + span.start]} data-end={days[row * 7 + span.end]} style={{ gridColumn: `${span.start + 1} / ${span.end + 2}`, gridRow: span.lane + 1 }}>{eventButton(span.event, days[row * 7 + span.start])}</div>)}</div></div>)}
    </div></div>
    {expanded && <div ref={popup} className="day-agenda" role="dialog" aria-modal="false" aria-label={`${expanded} 的全部日程`}>
      <header><div><strong>{DateTime.fromISO(expanded).setLocale('zh-CN').toFormat('M月d日 cccc')}</strong><span>{groups.get(expanded)?.length || 0} 项日程</span></div><button className="icon-button" aria-label="关闭当天日程" ref={closeButton} onClick={() => { setExpanded(null); popupOpener.current?.focus(); }}><X size={17}/></button></header>
      <div className="day-agenda-list">{groups.get(expanded)?.map(event => <button className="agenda-event" style={{ '--event-color': color(event) } as CSSProperties} key={event.id} onClick={() => { setExpanded(null); p.open(event); }}><EventMark allDay={event.allDay} holiday={p.holidays.has(event.calendarId)}/><div><strong>{event.title}</strong></div>{event.pending && <small>待同步</small>}</button>)}</div>
      <button className="agenda-create" onClick={() => { setExpanded(null); p.create(expanded, undefined, true); }}><Plus size={15}/>新建日程</button>
    </div>}
  </section>;
});
