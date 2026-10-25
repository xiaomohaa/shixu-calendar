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
  const clock = useRef<HTMLInputElement>(null), clockPicker = useRef<HTMLDivElement>(null);
  const [timeOpen,setTimeOpen] = useState(false);
  const [position, setPosition] = useState({ left: 12, top: 12 });
  const days = monthDays(month, 0, timezone), today = DateTime.now().setZone(timezone).toISODate();
  const close = () => { setOpen(false); trigger.current?.focus(); };
  const closeTime = () => { setTimeOpen(false); clock.current?.focus(); };
  const choose = (date: string) => { change(allDay ? date : `${date}T${time}`); close(); };
  const move = (months: number) => {
    const next = DateTime.fromISO(month).plus({ months }).toISODate()!;
    setMonth(next); setFocusDay(next);
  };
  useLayoutEffect(() => {
    if (!open && !timeOpen) return;
    const measure = () => {
      const anchor = (open ? trigger.current : clock.current)?.getBoundingClientRect(), popover = open ? picker.current : clockPicker.current; if (!anchor || !popover) return;
      const top = anchor.bottom + popover.offsetHeight + 8 <= innerHeight - 8 ? anchor.bottom + 5 : anchor.top - popover.offsetHeight - 5;
      setPosition({ left: Math.max(8, Math.min(anchor.left, innerWidth - popover.offsetWidth - 8)), top: Math.max(8, Math.min(top, innerHeight - popover.offsetHeight - 8)) });
    };
    measure(); window.addEventListener('resize', measure); document.addEventListener('scroll', measure, true);
    return () => { window.removeEventListener('resize', measure); document.removeEventListener('scroll', measure, true); };
  }, [open,timeOpen]);
  useEffect(() => {
    if (!open && !timeOpen) return;
    const outside = (event: PointerEvent) => { if (!picker.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false); if (!clockPicker.current?.contains(event.target as Node) && !clock.current?.contains(event.target as Node)) setTimeOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open,timeOpen]);
  useLayoutEffect(() => { if (timeOpen) clockPicker.current?.querySelector<HTMLSelectElement>('select')?.focus(); },[timeOpen]);
  useEffect(() => { if (disabled || allDay) setTimeOpen(false); },[disabled,allDay]);
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
    <button ref={trigger} type="button" className="event-date-trigger" aria-label={`${label}日期`} aria-haspopup="dialog" aria-expanded={open} data-date={day} disabled={disabled} onClick={() => { setTimeOpen(false); setMonth(day.slice(0, 7) + '-01'); setFocusDay(day); setOpen(value => !value); }}>{day.replaceAll('-', '/')}</button>
    {!allDay && <input ref={clock} className="event-time-input" aria-label={`${label}时间`} aria-haspopup="dialog" aria-expanded={timeOpen} type="time" required disabled={disabled} value={time} onChange={event => { if (event.target.value) change(`${day}T${event.target.value}`); }} onClick={() => { setOpen(false); setTimeOpen(true); }} onKeyDown={event => { if (event.key === 'Enter' || event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setTimeOpen(false); event.currentTarget.blur(); } if (event.altKey && event.key === 'ArrowDown') { event.preventDefault(); setOpen(false); setTimeOpen(true); } }}/>}
    {open && createPortal(<div ref={picker} className="event-date-picker" role="dialog" aria-modal="true" aria-label={`选择${label}日期`} data-month={month.slice(0, 7)} style={position} onKeyDown={keyboard}>
      <header><strong>{DateTime.fromISO(month).toFormat('yyyy年M月')}</strong><button type="button" aria-label="日期选择上个月" onClick={() => move(-1)}><ChevronLeft size={12}/></button><button type="button" aria-label="日期选择今天" onClick={() => choose(today!)}><Circle size={8} fill="currentColor"/></button><button type="button" aria-label="日期选择下个月" onClick={() => move(1)}><ChevronRight size={12}/></button></header>
      <div className="event-picker-weekdays">{['日','一','二','三','四','五','六'].map(label => <span key={label}>{label}</span>)}</div>
      <div className="event-picker-days">{days.map(date => <button key={date} type="button" tabIndex={date === focusDay ? 0 : -1} data-date={date} className={`event-picker-day ${date.slice(0, 7) !== month.slice(0, 7) ? 'other-month' : ''} ${date === day ? 'is-selected' : ''} ${date === today ? 'is-today' : ''}`} aria-label={`选择 ${date}`} aria-pressed={date === day} onClick={() => choose(date)}>{Number(date.slice(8))}</button>)}</div>
      <footer className="event-picker-footer"><button type="button" aria-label={`${label}日期完成`} onClick={close}>完成</button></footer>
    </div>, document.querySelector('.desktop-window') ?? document.body)}
    {timeOpen && !allDay && createPortal(<div ref={clockPicker} className="event-date-picker event-time-picker" role="dialog" aria-modal="true" aria-label={`选择${label}时间`} style={position} onKeyDown={event => {
      if (event.key === 'Escape' || event.key === 'Enter') { event.preventDefault(); event.stopPropagation(); closeTime(); }
      if (event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); const nodes=Array.from(clockPicker.current?.querySelectorAll<HTMLElement>('select,button') ?? []); const index=nodes.indexOf(document.activeElement as HTMLElement); nodes[(index+(event.shiftKey?-1:1)+nodes.length)%nodes.length]?.focus(); }
    }}><header><strong>{label}时间</strong></header><div className="event-clock-columns">
      <label>小时<select aria-label={`${label}小时`} size={5} value={time.slice(0,2)} onChange={event => change(`${day}T${event.target.value}:${time.slice(3,5)}`)}>{Array.from({length:24},(_,index)=>String(index).padStart(2,'0')).map(hour=><option key={hour}>{hour}</option>)}</select></label>
      <label>分钟<select aria-label={`${label}分钟`} size={5} value={time.slice(3,5)} onChange={event => change(`${day}T${time.slice(0,2)}:${event.target.value}`)}>{Array.from({length:60},(_,index)=>String(index).padStart(2,'0')).map(minute=><option key={minute}>{minute}</option>)}</select></label>
    </div><footer className="event-picker-footer"><button type="button" aria-label={`${label}时间完成`} onClick={closeTime}>完成</button></footer></div>,document.querySelector('.desktop-window') ?? document.body)}
  </div>;
}
