import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from 'react';
import { Trash2, Check } from 'lucide-react';
import type { Calendar, EventInput } from '../shared/contracts';
import { Busy, Panel } from './components';
import type { PanelAnchor } from './popoverLayout';
import { newEventTime } from '../calendar/newEventTime';
import { editorTime, sourceTime } from '../calendar/editorTime';
import { EventDateTime } from './EventDateTime';

export function Editor({ initial, calendars, close, saved, anchor, duration = 60, changed, displayTimezone, registerCloseGuard }: { initial: EventInput; calendars: Calendar[]; close: () => void; saved: () => void; anchor?: PanelAnchor; duration?: number; changed?: (draft: EventInput) => void; displayTimezone: string; registerCloseGuard?: (guard: () => boolean) => void }) {
  const [form, setForm] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirmDelete, setConfirmDelete] = useState(false);
  const titleInput = useRef<HTMLTextAreaElement>(null), dirty = useRef(false);
  useEffect(() => {
    registerCloseGuard?.(() => !dirty.current || window.confirm('打开提醒中的日程？当前未保存的修改将被放弃。'));
    return () => registerCloseGuard?.(() => true);
  },[registerCloseGuard]);
  useEffect(() => { if (!form.resourceId) changed?.(form); }, [form, changed]);
  useLayoutEffect(() => { const input = titleInput.current; if (input) { input.style.height = 'auto'; input.style.height = `${Math.max(48, Math.min(100, input.scrollHeight))}px`; } }, [form.title]);
  const set = <K extends keyof EventInput>(key: K, value: EventInput[K]) => { dirty.current = true; setForm(f => ({ ...f, [key]: value })); };
  const [custom, setCustom] = useState(!['', 'FREQ=DAILY', 'FREQ=WEEKLY', 'FREQ=MONTHLY', 'FREQ=YEARLY'].includes(initial.rrule));
  const dismiss = () => { if (!dirty.current || window.confirm('放弃尚未保存的日程修改？')) close(); };
  const display = (value: string) => editorTime(value, form, displayTimezone);
  const changeTime = (key: 'start' | 'end', value: string) => {
    try { set(key, sourceTime(value, form, displayTimezone)); setError(''); }
    catch (error) { setError((error as Error).message); }
  };
  const act = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn(); dirty.current = false; saved(); close(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const scope = async (value: 'series' | 'instance') => { if (!form.resourceId) return; setBusy(true); try { const input = await window.shixu.eventDetail(form.resourceId, value, form.recurrenceId); setForm(input); dirty.current = false; setError(''); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const color = calendars.find(calendar => calendar.id === form.calendarId)?.color || '#a638eb';
  return <Panel title={form.resourceId ? '编辑日程' : '新建日程'} floating hideHeader anchor={anchor} close={dismiss}>
    <form className="editor-body reference-event-editor" style={{ '--event-color': color } as CSSProperties} onSubmit={e => { e.preventDefault(); void act(() => window.shixu.saveEvent(form)); }}>
      <div className="event-primary">
        <textarea ref={titleInput} className="event-title-input" aria-label="日程标题" placeholder="新建日程" autoFocus required maxLength={500} rows={2} value={form.title} onChange={e => set('title', e.target.value)} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); event.currentTarget.blur(); } }}/>
        <div className="event-options" role="group" aria-label="日程设置">
          {form.resourceId && (form.rrule || form.recurrenceId) && <label className="event-option-row"><span>修改范围：</span><select aria-label="修改范围" disabled={busy} value={form.scope} onChange={e => void scope(e.target.value as 'series' | 'instance')}><option value="instance">仅此一次</option><option value="series">整个重复系列</option></select></label>}
          <label className="event-option-row"><span>全天：</span><div className="event-all-day-control"><input type="checkbox" aria-label="全天日程" disabled={busy} checked={form.allDay} onChange={e => {
            const allDay = e.target.checked;
            setForm(f => { const start = newEventTime(display(f.start).slice(0, 10), displayTimezone, allDay); return { ...f, allDay, timezone: displayTimezone, start: allDay ? start.toISODate()! : start.toISO()!, end: allDay ? start.plus({ days: 1 }).toISODate()! : start.plus({ minutes: duration }).toISO()! }; }); dirty.current = true;
          }}/></div></label>
          <div className="event-option-row"><span>开始时间：</span><EventDateTime label="开始" value={display(form.start)} allDay={form.allDay} timezone={displayTimezone} disabled={busy} change={value => changeTime('start', value)}/></div>
          <div className="event-option-row"><span title={form.allDay ? '全天日程的结束日期不包含当天' : undefined}>结束时间：</span><EventDateTime label="结束" value={display(form.end)} allDay={form.allDay} timezone={displayTimezone} disabled={busy} change={value => changeTime('end', value)}/></div>
          <label className="event-option-row"><span>重复：</span><select aria-label="重复" disabled={busy || form.scope === 'instance'} value={custom ? 'custom' : form.rrule} onChange={e => { setCustom(e.target.value === 'custom'); if (e.target.value !== 'custom') set('rrule', e.target.value); }}><option value="">永不</option><option value="FREQ=DAILY">每天</option><option value="FREQ=WEEKLY">每周</option><option value="FREQ=MONTHLY">每月</option><option value="FREQ=YEARLY">每年</option><option value="custom">自定义规则</option></select></label>
          {custom && <textarea className="event-rule-input" aria-label="RRULE" placeholder="FREQ=WEEKLY;BYDAY=MO,WE,FR" value={form.rrule} disabled={busy || form.scope === 'instance'} onChange={e => set('rrule', e.target.value)}/>}
          <label className="event-option-row"><span>行程时间：</span><select aria-label="行程时间" value={form.travelMinutes ?? 0} disabled={busy} onChange={event => set('travelMinutes', Number(event.target.value))}>{[0,5,10,15,30,60,120].map(minutes => <option key={minutes} value={minutes}>{minutes === 0 ? '无' : minutes < 60 ? `${minutes} 分钟` : `${minutes / 60} 小时`}</option>)}{form.travelMinutes && ![0,5,10,15,30,60,120].includes(form.travelMinutes) ? <option value={form.travelMinutes}>{form.travelMinutes} 分钟</option> : null}</select></label>
          <label className="event-option-row"><span>提醒：</span><select aria-label="提醒" disabled={busy} value={form.reminder} onChange={e => set('reminder', Number(e.target.value))}><option value={-2}>保留原有提醒</option><option value={-1}>无</option><option value={0}>开始时</option><option value={5}>提前 5 分钟</option><option value={15}>提前 15 分钟</option><option value={30}>提前 30 分钟</option><option value={60}>提前 1 小时</option><option value={1440}>提前 1 天</option>{![-2,-1,0,5,15,30,60,1440].includes(form.reminder) && <option value={form.reminder}>提前 {form.reminder} 分钟</option>}</select></label>
        </div>
      </div>
      <div className="event-location-box"><input aria-label="地点" placeholder="添加位置或视频通话" value={form.location} disabled={busy} onChange={e => set('location', e.target.value)}/></div>
      <div className="event-calendar-box"><i aria-hidden="true"/><select aria-label="所属日历" disabled={!!form.resourceId || busy} value={form.calendarId} required onChange={e => set('calendarId', e.target.value)}><option value="" disabled>选择日历</option>{calendars.filter(c => !c.readOnly || c.id === form.calendarId).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></div>
      <div className="event-notes-box"><textarea aria-label="备注" rows={2} placeholder="添加备注或 URL" value={form.description} disabled={busy} onChange={e => set('description', e.target.value)}/></div>
      {error && <div className="error-box" role="alert">{error}</div>}
      {confirmDelete && <div className="confirm-box"><p>确认删除{form.scope === 'instance' ? '此次日程' : '整个日程系列'}？同步后也会从服务器删除。</p><button type="button" disabled={busy} className="danger" onClick={() => void act(() => window.shixu.deleteEvent(form.resourceId!, form.scope, form.recurrenceId))}>确认删除</button><button type="button" onClick={() => setConfirmDelete(false)}>返回</button></div>}
      <footer className="panel-footer">{form.resourceId && <button type="button" className="danger ghost" disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 size={12}/>删除</button>}<span className="spacer"/><button type="button" disabled={busy} onClick={dismiss}>取消</button><button className="primary" disabled={busy || !form.calendarId}>{busy ? <Busy text="保存中"/> : <><Check size={12}/>保存日程</>}</button></footer>
    </form>
  </Panel>;
}
