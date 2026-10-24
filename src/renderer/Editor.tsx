import { useRef, useState } from 'react';
import { DateTime } from 'luxon';
import { CalendarDays, Clock3, MapPin, AlignLeft, Repeat2, Bell, Trash2, Check } from 'lucide-react';
import type { Calendar, EventInput } from '../shared/contracts';
import { Busy, Field, Panel } from './components';
import type { PanelAnchor } from './popoverLayout';
import { newEventTime } from '../calendar/newEventTime';

export function Editor({ initial, calendars, close, saved, anchor, duration = 60 }: { initial: EventInput; calendars: Calendar[]; close: () => void; saved: () => void; anchor?: PanelAnchor; duration?: number }) {
  const [form, setForm] = useState(initial), [busy, setBusy] = useState(false), [error, setError] = useState(''), [confirmDelete, setConfirmDelete] = useState(false);
  const dirty = useRef(false);
  const set = <K extends keyof EventInput>(key: K, value: EventInput[K]) => { dirty.current = true; setForm(f => ({ ...f, [key]: value })); };
  const [custom, setCustom] = useState(!['', 'FREQ=DAILY', 'FREQ=WEEKLY', 'FREQ=MONTHLY', 'FREQ=YEARLY'].includes(initial.rrule));
  const dismiss = () => { if (!dirty.current || window.confirm('放弃尚未保存的日程修改？')) close(); };
  const display = (value: string) => form.allDay ? value.slice(0, 10) : DateTime.fromISO(value, { zone: form.timezone }).toFormat("yyyy-MM-dd'T'HH:mm");
  const act = async (fn: () => Promise<void>) => { setBusy(true); setError(''); try { await fn(); dirty.current = false; saved(); close(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  const scope = async (value: 'series' | 'instance') => { if (!form.resourceId) return; setBusy(true); try { const input = await window.shixu.eventDetail(form.resourceId, value, form.recurrenceId); setForm(input); dirty.current = false; setError(''); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <Panel title={form.resourceId ? '编辑日程' : '新建日程'} floating anchor={anchor} close={dismiss}>
    <form className="editor-body" onSubmit={e => { e.preventDefault(); void act(() => window.shixu.saveEvent(form)); }}>
      <input className="event-title-input" aria-label="日程标题" placeholder="添加标题" autoFocus required maxLength={500} value={form.title} onChange={e => set('title', e.target.value)}/>
      {form.resourceId && (form.rrule || form.recurrenceId) && <Field label="修改范围" hint="切换范围会重新载入原始内容。系列起始时间不可在此平移。"><select disabled={busy} value={form.scope} onChange={e => void scope(e.target.value as 'series' | 'instance')}><option value="instance">仅此一次</option><option value="series">整个重复系列</option></select></Field>}
      <div className="editor-section"><CalendarDays size={18}/><div className="editor-fields"><Field label="所属日历"><select aria-label="所属日历" disabled={!!form.resourceId} value={form.calendarId} required onChange={e => set('calendarId', e.target.value)}><option value="" disabled>选择日历</option>{calendars.filter(c => !c.readOnly).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}</select></Field><label className="check-row"><input type="checkbox" checked={form.allDay} onChange={e => {
        const allDay = e.target.checked;
        setForm(f => { const start = newEventTime(display(f.start).slice(0, 10), f.timezone, allDay); return { ...f, allDay, start: allDay ? start.toISODate()! : start.toISO()!, end: allDay ? start.plus({ days: 1 }).toISODate()! : start.plus({ minutes: duration }).toISO()! }; }); dirty.current = true;
      }}/>全天日程</label></div></div>
      <div className="editor-section"><Clock3 size={18}/><div className="editor-fields"><Field label="开始"><input aria-label="开始时间" type={form.allDay ? 'date' : 'datetime-local'} required value={display(form.start)} onChange={e => set('start', e.target.value)}/></Field><Field label={form.allDay ? '结束（不包含此日期）' : '结束'}><input aria-label="结束时间" type={form.allDay ? 'date' : 'datetime-local'} required value={display(form.end)} onChange={e => set('end', e.target.value)}/></Field>{!form.allDay && <Field label="日程时区" hint="修改时区会按新时区解释输入的时间。"><input required list="timezones" value={form.timezone} onChange={e => { const start = display(form.start), end = display(form.end); setForm(f => ({ ...f, timezone: e.target.value, start, end })); dirty.current = true; }}/></Field>}</div></div>
      <div className="editor-section"><MapPin size={18}/><Field label="地点"><input placeholder="添加地点或会议链接" value={form.location} onChange={e => set('location', e.target.value)}/></Field></div>
      <div className="editor-section"><Repeat2 size={18}/><div className="editor-fields"><Field label="重复"><select disabled={form.scope === 'instance'} value={custom ? 'custom' : form.rrule} onChange={e => { setCustom(e.target.value === 'custom'); if (e.target.value !== 'custom') set('rrule', e.target.value); }}><option value="">不重复</option><option value="FREQ=DAILY">每天</option><option value="FREQ=WEEKLY">每周</option><option value="FREQ=MONTHLY">每月</option><option value="FREQ=YEARLY">每年</option><option value="custom">自定义 RRULE / 保留原规则</option></select></Field>{custom && <Field label="RRULE" hint="例如 FREQ=WEEKLY;BYDAY=MO,WE,FR。未改动的复杂规则原样保留。"><textarea value={form.rrule} disabled={form.scope === 'instance'} onChange={e => set('rrule', e.target.value)}/></Field>}</div></div>
      <div className="editor-section"><Bell size={18}/><Field label="提醒"><select value={form.reminder} onChange={e => set('reminder', Number(e.target.value))}><option value={-2}>保留原有提醒</option><option value={-1}>无提醒</option><option value={0}>日程开始时</option><option value={5}>提前 5 分钟</option><option value={15}>提前 15 分钟</option><option value={30}>提前 30 分钟</option><option value={60}>提前 1 小时</option><option value={1440}>提前 1 天</option>{![-2,-1,0,5,15,30,60,1440].includes(form.reminder) && <option value={form.reminder}>提前 {form.reminder} 分钟</option>}</select></Field></div>
      <div className="editor-section"><AlignLeft size={18}/><Field label="备注"><textarea rows={4} placeholder="记下一些细节…" value={form.description} onChange={e => set('description', e.target.value)}/></Field></div>
      <p className="form-hint">提醒在应用运行时由 Windows 通知显示；退出应用后不会提醒。复杂的远程提醒会保留，但可能无法在本机触发。</p>
      {form.floating && <p className="form-hint">此日程使用浮动时间，将按当前显示时区解释；保存时保留浮动时间类型。</p>}
      {error && <div className="error-box" role="alert">{error}</div>}
      {confirmDelete && <div className="confirm-box"><p>确认删除{form.scope === 'instance' ? '此次日程' : '整个日程系列'}？同步后也会从服务器删除。</p><button type="button" disabled={busy} className="danger" onClick={() => void act(() => window.shixu.deleteEvent(form.resourceId!, form.scope, form.recurrenceId))}>确认删除</button><button type="button" onClick={() => setConfirmDelete(false)}>返回</button></div>}
      <footer className="panel-footer">{form.resourceId && <button type="button" className="danger ghost" disabled={busy} onClick={() => setConfirmDelete(true)}><Trash2 size={16}/>删除</button>}<span className="spacer"/><button type="button" disabled={busy} onClick={dismiss}>取消</button><button className="primary" disabled={busy || !form.calendarId}>{busy ? <Busy text="保存中"/> : <><Check size={16}/>保存日程</>}</button></footer>
    </form>
  </Panel>;
}
