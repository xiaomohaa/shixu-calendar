import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent } from 'react';
import { createPortal } from 'react-dom';
import { DateTime } from 'luxon';
import { ChevronLeft, ChevronRight, Circle } from 'lucide-react';
import { monthDays } from '../calendar/monthLayout';

export function EventDateTime({ label, value, allDay, timezone, disabled, change }: {
  label: string; value: string; allDay: boolean; timezone: string; disabled: boolean; change(value: string): void;
}) {
  const day = value.slice(0, 10), time = value.slice(11, 16) || '09:00';
  const [open, setOpen] = useState(false), [month, setMonth] = useState(day.slice(0, 7) + '-01'), [focusDay, setFocusDay] = useState(day);
  const trigger = useRef<HTMLButtonElement>(null), picker = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  const days = monthDays(month, 0, timezone), today = DateTime.now().setZone(timezone).toISODate();
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const choose = (date: string) => { change(allDay ? date : `${date}T${time}`); close(); };
  const move = (months: number) => {
    const next = DateTime.fromISO(month).plus({ months }).toISODate()!;
    setMonth(next); setFocusDay(next);
  };
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => {
      const anchor = trigger.current?.getBoundingClientRect(), popover = picker.current; if (!anchor || !popover) return;
      const top = anchor.bottom + popover.offsetHeight + 8 <= innerHeight - 8 ? anchor.bottom + 5 : anchor.top - popover.offsetHeight - 5;
      setPosition({ left: Math.max(8, Math.min(anchor.left, innerWidth - popover.offsetWidth - 8)), top: Math.max(8, Math.min(top, innerHeight - popover.offsetHeight - 8)) });
    };
    measure(); window.addEventListener('resize', measure); document.addEventListener('scroll', measure, true);
    return () => { window.removeEventListener('resize', measure); document.removeEventListener('scroll', measure, true); };
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!picker.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  useLayoutEffect(() => { if (open) picker.current?.querySelector<HTMLButtonElement>(`[data-date="${focusDay}"]`)?.focus(); }, [open, month, focusDay]);
  const keyboard = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key === 'Escape') { event.stopPropagation(); event.preventDefault(); close(); return; }
    if (event.key === 'Tab') {
      const nodes = Array.from(picker.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []).filter(node => node.tabIndex >= 0);
      const index = nodes.indexOf(document.activeElement as HTMLButtonElement);
      if (nodes.length) { event.preventDefault(); event.stopPropagation(); nodes[(index + (event.shiftKey ? -1 : 1) + nodes.length) % nodes.length]?.focus(); }
      return;
    }
    if (!(event.target as HTMLElement).hasAttribute('data-date')) return;
    const delta = ({ ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 } as Record<string, number>)[event.key];
    if (delta) {
      event.preventDefault(); event.stopPropagation(); const next = DateTime.fromISO(focusDay).plus({ days: delta });
      setFocusDay(next.toISODate()!); if (!days.includes(next.toISODate()!)) setMonth(next.startOf('month').toISODate()!);
    }
  };
  return <div className="event-date-time">
    <button ref={trigger} type="button" className="event-date-trigger" aria-label={`${label}日期`} aria-haspopup="dialog" aria-expanded={open} data-date={day} disabled={disabled} onClick={() => { setMonth(day.slice(0, 7) + '-01'); setFocusDay(day); setOpen(value => !value); }}>{day.replaceAll('-', '/')}</button>
    {!allDay && <input className="event-time-input" aria-label={`${label}时间`} type="time" required disabled={disabled} value={time} onChange={event => { if (event.target.value) change(`${day}T${event.target.value}`); }} onClick={event => { const input = event.currentTarget; if (typeof input.showPicker === 'function') { try { input.showPicker(); } catch { /* Keyboard editing remains available where native pickers are unavailable. */ } } }}/>}
    {open && createPortal(<div ref={picker} className="event-date-picker" role="dialog" aria-modal="true" aria-label={`选择${label}日期`} data-month={month.slice(0, 7)} style={position} onKeyDown={keyboard}>
      <header><strong>{DateTime.fromISO(month).toFormat('yyyy年M月')}</strong><button type="button" aria-label="日期选择上个月" onClick={() => move(-1)}><ChevronLeft size={12}/></button><button type="button" aria-label="日期选择今天" onClick={() => choose(today!)}><Circle size={8} fill="currentColor"/></button><button type="button" aria-label="日期选择下个月" onClick={() => move(1)}><ChevronRight size={12}/></button></header>
      <div className="event-picker-weekdays">{['日','一','二','三','四','五','六'].map(label => <span key={label}>{label}</span>)}</div>
      <div className="event-picker-days">{days.map(date => <button key={date} type="button" tabIndex={date === focusDay ? 0 : -1} data-date={date} className={`event-picker-day ${date.slice(0, 7) !== month.slice(0, 7) ? 'other-month' : ''} ${date === day ? 'is-selected' : ''} ${date === today ? 'is-today' : ''}`} aria-label={`选择 ${date}`} aria-pressed={date === day} onClick={() => choose(date)}>{Number(date.slice(8))}</button>)}</div>
    </div>, document.querySelector('.desktop-window') ?? document.body)}
  </div>;
}
