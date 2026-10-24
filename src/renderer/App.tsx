import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import timeGridPlugin from '@fullcalendar/timegrid';
import listPlugin from '@fullcalendar/list';
import interactionPlugin from '@fullcalendar/interaction';
import luxonPlugin from '@fullcalendar/luxon3';
import zhCn from '@fullcalendar/core/locales/zh-cn';
import type { EventApi, EventInput as FCEvent, DatesSetArg } from '@fullcalendar/core';
import { DateTime } from 'luxon';
import { CalendarDays, ChevronLeft, ChevronRight, Plus, Search, RefreshCw, Settings2, Cloud, CircleCheck, TriangleAlert, X, Repeat2, List } from 'lucide-react';
import type { CalendarEvent, EventInput, Snapshot } from '../shared/contracts';
import { Editor } from './Editor';
import { SettingsPanel } from './Settings';
import { IconButton } from './components';
import { Almanac } from './Almanac';
import { MonthDate } from './MonthDate';
import { UpdateNotice } from './Updates';
import { MonthGrid } from './MonthGrid';
import { YearGrid } from './YearGrid';
import { getChineseCalendarDay } from '../calendar/chineseCalendar';
import { draftEvent } from '../calendar/draftEvent';
import { WindowChrome } from './WindowChrome';
import { eventHasEnded } from '../calendar/eventDisplay';
import { monthDays } from '../calendar/monthLayout';
import { newEventTime } from '../calendar/newEventTime';
import type { PanelAnchor } from './popoverLayout';
const calendarPlugins = [dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin, luxonPlugin];

export function App() {
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null), [events, setEvents] = useState<CalendarEvent[]>([]);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const update = () => setNow(Date.now());
    const timer = setInterval(update, 30000);
    window.addEventListener('focus', update);
    document.addEventListener('visibilitychange', update);
    return () => { clearInterval(timer); window.removeEventListener('focus', update); document.removeEventListener('visibilitychange', update); };
  }, []);
  const [view, setView] = useState('dayGridMonth'), [title, setTitle] = useState(''), [selected, setSelected] = useState(DateTime.local().toISODate()!);
  const [month, setMonth] = useState(DateTime.local().startOf('month').toISODate()!);
  const [miniMonth, setMiniMonth] = useState<DateTime>(DateTime.local().startOf('month')), [sidebar, setSidebar] = useState(false), [narrow, setNarrow] = useState(() => matchMedia('(max-width: 900px)').matches);
  const [searchOpen, setSearchOpen] = useState(false), [query, setQuery] = useState(''), [editor, setEditor] = useState<EventInput | null>(null), [settingsTab, setSettingsTab] = useState<string | null>(null);
  const [draft, setDraft] = useState<EventInput | null>(null);
  const [editorAnchor, setEditorAnchor] = useState<PanelAnchor>();
  const [error, setError] = useState(''), [notice, setNotice] = useState(''), [loading, setLoading] = useState(true);
  const calendarRef = useRef<FullCalendar>(null), range = useRef({ start: DateTime.local().startOf('month').minus({ days: 7 }).toISO()!, end: DateTime.local().endOf('month').plus({ days: 7 }).toISO()! });
  const loadId = useRef(0), booted = useRef(false), searchRef = useRef<HTMLInputElement>(null);
  const calendarContainer = useRef<HTMLDivElement>(null);
  const refresh = useCallback(async () => {
    if (!window.shixu) { setError('请使用桌面应用打开此日历。浏览器预览无法访问本地数据库。'); setLoading(false); return; }
    const id = ++loadId.current;
    try {
      const list = await window.shixu.events(range.current.start, range.current.end);
      const data = await window.shixu.snapshot();
      if (loadId.current !== id) return;
      setSnapshot(data); setEvents(list);
      if (!booted.current) { booted.current = true; setView(data.settings.view); }
    } catch (e) { setError((e as Error).message); } finally { setLoading(false); }
  }, []);
  useEffect(() => { void refresh(); return window.shixu?.onChange(() => void refresh()); }, [refresh]);
  useEffect(() => window.shixu?.onOpenSettings(tab => setSettingsTab(tab)), []);
  useEffect(() => {
    if (view !== 'dayGridMonth' || !snapshot) return;
    const days = monthDays(month, snapshot.settings.firstDay, snapshot.settings.timezone);
    const next = { start: DateTime.fromISO(days[0], { zone: snapshot.settings.timezone }).toISO()!, end: DateTime.fromISO(days[41], { zone: snapshot.settings.timezone }).plus({ days: 1 }).toISO()! };
    if (next.start !== range.current.start || next.end !== range.current.end) { range.current = next; void refresh(); }
  }, [month, view, snapshot?.settings.firstDay, snapshot?.settings.timezone, refresh]);
  useEffect(() => {
    if (view === 'dayGridMonth' || view === 'multiMonthYear') return;
    const element = calendarContainer.current; if (!element) return;
    let timer: ReturnType<typeof setTimeout>, active = true, previous = '';
    const resize = () => { const size = `${element.clientWidth}:${element.clientHeight}`; if (size === previous) return; previous = size; clearTimeout(timer); timer = setTimeout(() => { if (active) calendarRef.current?.getApi().updateSize(); }, 80); };
    const observer = new ResizeObserver(resize); observer.observe(element);
    void document.fonts.ready.then(() => { if (active) { previous = ''; resize(); } });
    return () => { active = false; observer.disconnect(); clearTimeout(timer); };
  }, [view, loading]);
  useEffect(() => { const media = matchMedia('(max-width: 900px)'); const apply = () => { setNarrow(media.matches); setSidebar(false); }; apply(); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply); }, []);
  useEffect(() => { const media = matchMedia('(prefers-color-scheme: dark)'); const apply = () => { document.documentElement.dataset.theme = snapshot?.settings.theme === 'dark' || (snapshot?.settings.theme === 'system' && media.matches) ? 'dark' : 'light'; }; apply(); media.addEventListener('change', apply); return () => media.removeEventListener('change', apply); }, [snapshot?.settings.theme]);
  useEffect(() => { if (searchOpen) searchRef.current?.focus(); }, [searchOpen]);
  useEffect(() => { const key = (event: KeyboardEvent) => { if ((event.ctrlKey || event.metaKey) && event.key === ',') { event.preventDefault(); setSettingsTab('display'); } if (event.key === 'Escape') setSidebar(false); }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); }, []);
  useEffect(() => { document.documentElement.dataset.boldText = String(snapshot?.settings.boldText ?? false); }, [snapshot?.settings.boldText]);
  useEffect(() => { if (notice) { const t = setTimeout(() => setNotice(''), 5000); return () => clearTimeout(t); } }, [notice]);
  const execute = async (fn: () => Promise<unknown>, done?: string) => { setError(''); try { await fn(); if (done) setNotice(done); await refresh(); } catch (e) { setError((e as Error).message); } };
  const create = (start?: string, end?: string, allDay = false, anchor?: PanelAnchor) => {
    if (!snapshot?.calendars.some(c => !c.readOnly)) { setSettingsTab('accounts'); return; }
    const pref = snapshot.settings;
    const base = newEventTime(start || selected, pref.timezone, allDay);
    if (view === 'multiMonthYear') { setView('dayGridMonth'); setMonth(base.startOf('month').toISODate()!); setMiniMonth(base.startOf('month')); }
    setEditorAnchor(anchor);
    const initial: EventInput = { calendarId: pref.defaultCalendar || snapshot.calendars.find(c => !c.readOnly)!.id, title: '', start: allDay ? base.toISODate()! : base.toISO()!, end: end || (allDay ? base.plus({ days: 1 }).toISODate()! : base.plus({ minutes: pref.duration }).toISO()!), allDay, timezone: pref.timezone, location: '', description: '', rrule: '', reminder: pref.reminder, scope: 'series' }; setEditor(initial); setDraft(initial);
  };
  useEffect(() => { const key = (e: KeyboardEvent) => { const editing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((e.target as HTMLElement).tagName); if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'f') { e.preventDefault(); setSearchOpen(true); } if (e.key === 'Escape' && !editor && !settingsTab) { setSearchOpen(false); setQuery(''); } if (!editing && !editor && !settingsTab && e.key.toLowerCase() === 'n') create(); if (!editing && !editor && !settingsTab && e.key.toLowerCase() === 't') go(DateTime.now().setZone(snapshot?.settings.timezone || 'local').toISODate()!); }; window.addEventListener('keydown', key); return () => window.removeEventListener('keydown', key); });
  const openEvent = (ev: CalendarEvent) => void execute(async () => { setDraft(null); setEditorAnchor(undefined); setEditor(await window.shixu.eventDetail(ev.resourceId, ev.recurring ? 'instance' : 'series', ev.recurrenceId)); });
  const go = (date: string) => { setSelected(date); setMiniMonth(DateTime.fromISO(date).startOf('month')); if (view === 'dayGridMonth' || view === 'multiMonthYear') setMonth(DateTime.fromISO(date).startOf('month').toISODate()!); else calendarRef.current?.getApi().gotoDate(date); };
  const navigate = (direction: number) => { if (view === 'dayGridMonth' || view === 'multiMonthYear') go(DateTime.fromISO(month).plus(view === 'multiMonthYear' ? { years: direction } : { months: direction }).toISODate()!); else if (direction < 0) calendarRef.current?.getApi().prev(); else calendarRef.current?.getApi().next(); };
  const setViewTo = (next: string) => {
    // Never ask FullCalendar to mount its old month layout while React is
    // replacing it with our fixed grid. Dense event measurement can otherwise
    // block the click before the replacement is committed.
    if (next === 'dayGridMonth' || next === 'multiMonthYear') { setMonth(DateTime.fromISO(selected).startOf('month').toISODate()!); setView(next); return; }
    if (view === 'dayGridMonth' || view === 'multiMonthYear') { setView(next); return; }
    calendarRef.current?.getApi().changeView(next);
  };
  const datesSet = useCallback((info: DatesSetArg) => {
    setTitle(info.view.title); setView(info.view.type); const current = DateTime.fromJSDate(info.view.calendar.getDate()).setZone(snapshot?.settings.timezone || 'local'); setSelected(current.toISODate()!); setMiniMonth(current.startOf('month'));
    const next = { start: info.start.toISOString(), end: info.end.toISOString() };
    if (range.current.start !== next.start || range.current.end !== next.end) { range.current = next; void refresh(); }
  }, [refresh, snapshot?.settings.timezone]);
  const moveMonthEvent = (event: CalendarEvent, target: string, origin: string) => {
    const delta = DateTime.fromISO(target, { zone: 'UTC' }).diff(DateTime.fromISO(origin, { zone: 'UTC' }), 'days').days;
    if (!delta || !Number.isInteger(delta)) return;
    void execute(async () => {
      const input = await window.shixu.eventDetail(event.resourceId, event.recurring ? 'instance' : 'series', event.recurrenceId);
      const shift = (date: string) => { const next = DateTime.fromISO(date, { zone: input.timezone }).plus({ days: delta }); return input.allDay ? next.toISODate()! : next.toISO({ includeOffset: !input.floating })!; };
      await window.shixu.saveEvent({ ...input, start: shift(input.start), end: shift(input.end) });
    }, '时间已调整，等待同步');
  };
  const moveEvent = (info: { event: EventApi; revert: () => void }) => {
    const ev = events.find(e => e.id === info.event.id); if (!ev || !info.event.start) { info.revert(); return; }
    void execute(async () => {
      try { const input = await window.shixu.eventDetail(ev.resourceId, ev.recurring ? 'instance' : 'series', ev.recurrenceId); const start = info.event.startStr; const end = info.event.endStr || DateTime.fromISO(start).plus({ minutes: snapshot!.settings.duration }).toISO()!; await window.shixu.saveEvent({ ...input, start: info.event.allDay ? start.slice(0, 10) : start, end: info.event.allDay ? end.slice(0, 10) : end, allDay: info.event.allDay }); setNotice('时间已调整，等待同步'); } catch (e) { info.revert(); throw e; }
    });
  };
  const prefs = snapshot?.settings;
  const filtered = useMemo(() => events.filter(e => `${e.title} ${e.location} ${e.description}`.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [events, query]);
  const preview = useMemo(() => draftEvent(draft, prefs?.duration ?? 60), [draft, prefs?.duration]);
  const displayEvents = useMemo(() => preview ? [...filtered, preview] : filtered, [filtered, preview]);
  const updateDraft = useCallback((input: EventInput) => {
    setDraft(input);
    const date = DateTime.fromISO(input.start, { zone: input.timezone });
    if (!date.isValid) return;
    setMonth(current => {
      const days = monthDays(current, prefs?.firstDay ?? 1, prefs?.timezone || 'local'), day = date.toISODate()!;
      return day < days[0] || day > days[41] ? date.startOf('month').toISODate()! : current;
    });
  }, [prefs?.firstDay, prefs?.timezone]);
  const year = DateTime.fromISO(month).year;
  const yearLunar = useMemo(() => getChineseCalendarDay(`${year}-07-01`), [year]);
  const openYearMonth = (date: string) => { const dt = DateTime.fromISO(date); setSelected(date); setMonth(dt.startOf('month').toISODate()!); setMiniMonth(dt.startOf('month')); setView('dayGridMonth'); };
  const sidebarGroups = useMemo(() => {
    const groups = new Map<string, NonNullable<Snapshot>['calendars']>();
    for (const account of snapshot?.accounts ?? []) {
      let name = '日历';
      try { const host = new URL(account.url).hostname; name = host === 'icloud.com' || host.endsWith('.icloud.com') ? 'iCloud' : host; } catch { /* Validated accounts normally have an HTTP(S) host. */ }
      groups.set(name, [...(groups.get(name) ?? []), ...(snapshot?.calendars.filter(calendar => calendar.accountId === account.id) ?? [])]);
    }
    return [...groups].map(([name, calendars]) => ({ name, calendars }));
  }, [snapshot?.accounts, snapshot?.calendars]);
  const fcEvents: FCEvent[] = useMemo(() => displayEvents.map(e => {
    const c = snapshot?.calendars.find(c => c.id === e.calendarId), color = c?.color || '#d65c4f';
    return { id: e.id, title: e.title, start: e.start, end: e.end, allDay: e.allDay, backgroundColor: color, borderColor: color, textColor: '#fdfcfb', editable: !e.draft && !c?.readOnly && !e.conflict, classNames: [e.draft ? 'event-draft' : '', e.allDay ? 'event-all-day' : 'event-timed', e.pending ? 'event-pending' : '', e.conflict ? 'event-conflict' : '', !e.draft && eventHasEnded(e, snapshot?.settings.timezone || 'local', now) ? 'event-ended' : ''], extendedProps: { ...e, color } };
  }), [displayEvents, snapshot?.calendars, snapshot?.settings.timezone, now]);
  const firstDay = prefs?.firstDay ?? 1, offset = (miniMonth.weekday % 7 - firstDay + 7) % 7;
  const miniStart = miniMonth.minus({ days: offset }), days = Array.from({ length: 42 }, (_, i) => miniStart.plus({ days: i }));
  const today = DateTime.now().setZone(prefs?.timezone || 'local').toISODate();
  const selectedEvents = filtered.filter(e => { const s = e.allDay ? e.start : DateTime.fromISO(e.start).setZone(prefs?.timezone || 'local').toISODate()!; const end = e.allDay ? DateTime.fromISO(e.end).minus({ days: 1 }).toISODate()! : DateTime.fromISO(e.end).minus({ milliseconds: 1 }).setZone(prefs?.timezone || 'local').toISODate()!; return s <= selected && end >= selected; });
  return <div className={`desktop-window ${window.__TAURI_INTERNALS__ ? 'native-chrome' : ''}`}><WindowChrome/><div className={`app-shell ${narrow && !sidebar ? 'sidebar-collapsed' : ''} ${narrow && sidebar ? 'sidebar-overlay' : ''}`}>
    {narrow && <div className="sidebar-reveal-edge" aria-label="侧栏感应区" tabIndex={0} onPointerEnter={() => setSidebar(true)} onFocus={() => setSidebar(true)}/>}
    {narrow && sidebar && <div className="sidebar-dismiss" onPointerEnter={() => { if (!settingsTab) setSidebar(false); }} onClick={() => setSidebar(false)}/>}
    <aside className={`sidebar ${prefs?.showSidebarEvents === false ? 'sidebar-events-hidden' : ''}`} aria-label="日历侧边栏" onPointerLeave={() => { if (narrow && !settingsTab) setSidebar(false); }}><div className="brand"><img className="app-mark" src={new URL('../../build/icon.png', import.meta.url).href} alt="时序日历"/><div><strong>时序</strong><span>留给生活的时间</span></div><IconButton label="设置" onClick={() => setSettingsTab('accounts')}><Settings2 size={12}/></IconButton></div>
      <button className="new-event-button" onClick={() => create()}><Plus size={18}/>新建日程<kbd>N</kbd></button>
      <button className="today-link" onClick={() => go(today!)}><CalendarDays size={17}/><span>今天</span><span className="today-number">{DateTime.now().setZone(prefs?.timezone || 'local').day}</span></button>
      <div className="sidebar-scroll">
      <section className="mini-calendar" aria-label="迷你日历"><div className="mini-header"><strong>{miniMonth.toFormat('yyyy年 M月')}</strong><IconButton label="迷你日历上个月" onClick={() => setMiniMonth(m => m.minus({ months: 1 }))}><ChevronLeft size={15}/></IconButton><IconButton label="迷你日历下个月" onClick={() => setMiniMonth(m => m.plus({ months: 1 }))}><ChevronRight size={15}/></IconButton></div><div className="mini-grid">{Array.from({ length: 7 }, (_, i) => <span className="mini-weekday" key={`w${i}`}>{['日','一','二','三','四','五','六'][(firstDay + i) % 7]}</span>)}{days.map(day => <button key={day.toISODate()} aria-label={day.toFormat('yyyy年M月d日')} aria-pressed={day.toISODate() === selected} className={`${day.month !== miniMonth.month ? 'other-month' : ''} ${day.toISODate() === today ? 'is-today' : ''} ${day.toISODate() === selected ? 'is-selected' : ''}`} onClick={() => go(day.toISODate()!)}>{day.day}</button>)}</div></section>
      <div className="sidebar-calendars"><div className="sidebar-section-heading"><h2>我的日历</h2><IconButton label="添加日历账户" onClick={() => setSettingsTab('accounts')}><Plus size={15}/></IconButton></div>
        {!snapshot?.accounts.length && <button className="connect-calendar" onClick={() => setSettingsTab('accounts')}><Cloud size={17}/><span>连接 CalDAV 账户<small>同步你已有的日程</small></span><ChevronRight size={14}/></button>}
        {sidebarGroups.map(group => <section className="calendar-account" key={group.name}><h3 className="account-label">{group.name}</h3>{group.calendars.map(c => <label className="calendar-toggle" key={c.id}><input type="checkbox" style={{ accentColor: c.color }} checked={c.visible} onChange={e => void execute(() => window.shixu.setCalendar(c.id, e.target.checked, c.color))}/><span>{c.name}</span></label>)}</section>)}
      </div>
      <section className="day-summary">{(prefs?.showSidebarEvents ?? true) && <div className="sidebar-section-heading"><h2>{DateTime.fromISO(selected).setLocale('zh-cn').toFormat(prefs?.dateFormat === 'numeric' ? 'yyyy/MM/dd cccc' : 'M月d日 cccc')}</h2><small>{selectedEvents.length} 项</small></div>}{(prefs?.showAlmanac ?? true) && <Almanac date={selected}/>}{(prefs?.showSidebarEvents ?? true) && <div className="sidebar-events">{selectedEvents.slice(0, 4).map(e => <button className={`summary-event ${eventHasEnded(e, prefs?.timezone || 'local', now) ? 'event-ended' : ''}`} key={e.id} onClick={() => openEvent(e)}><i className="color-dot" style={{ background: snapshot?.calendars.find(c => c.id === e.calendarId)?.color }}/><div><span>{e.title}</span></div></button>)}{selectedEvents.length === 0 && <p className="empty-day-message">这一天，还留有空白。</p>}</div>}</section>
      </div>
    </aside>
    <main className="main-content"><header className="toolbar">
      <div className="toolbar-left"><IconButton label="新建日程" onClick={() => create()}><Plus size={15}/></IconButton></div>
      <div className="view-switch" aria-label="日历视图">{[{ id: 'timeGridDay', label: '日' }, { id: 'timeGridWeek', label: '周' }, { id: 'dayGridMonth', label: '月' }, { id: 'multiMonthYear', label: '年' }].map(v => <button key={v.id} aria-pressed={view === v.id} className={view === v.id ? 'active' : ''} onClick={() => setViewTo(v.id)}>{v.label}</button>)}</div>
      <div className="toolbar-right"><IconButton label="日程列表" aria-pressed={view === 'listMonth'} onClick={() => setViewTo('listMonth')}><List size={13}/></IconButton><button className="toolbar-search" aria-label="搜索日程" onClick={() => setSearchOpen(v => !v)}><Search size={14}/><span>搜索</span><kbd>Ctrl F</kbd></button><IconButton label={snapshot?.syncing.length ? '取消同步' : '同步日历'} disabled={!snapshot?.accounts.length} onClick={() => void execute(() => snapshot?.syncing.length ? window.shixu.cancelSync() : window.shixu.sync(), snapshot?.syncing.length ? '同步已取消' : '同步完成')}><RefreshCw size={14} className={snapshot?.syncing.length ? 'spin' : ''}/></IconButton></div>
    </header>
      <div className="calendar-heading"><div><h1>{view === 'multiMonthYear' ? `${year}年` : view === 'dayGridMonth' ? DateTime.fromISO(month).toFormat(prefs?.dateFormat === 'numeric' ? 'yyyy/MM' : 'yyyy年M月') : prefs?.dateFormat === 'numeric' ? title.replaceAll('年', '/').replaceAll('月', '/').replaceAll('日', '').replace(/\/(?=$|[ –])/g, '') : title}</h1><span>{query ? `当前日期范围内，找到 ${filtered.length} 项日程` : prefs?.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone}</span></div>
        <div className="heading-trailing">{view === 'multiMonthYear' && <div className="year-legend"><span><i/>{yearLunar ? `${yearLunar.yearGanZhi}${yearLunar.zodiac}年` : '农历年份'}</span><span><i/>农历初一</span></div>}{snapshot?.conflicts.length ? <button className="conflict-pill" onClick={() => setSettingsTab('conflicts')}><TriangleAlert size={15}/>{snapshot.conflicts.length} 个冲突</button> : snapshot?.pending ? <span className="pending-pill">{snapshot.pending} 项待同步</span> : null}<div className="period-navigation"><IconButton label="上一周期" onClick={() => navigate(-1)}><ChevronLeft size={14}/></IconButton><button className="today-button" onClick={() => go(today!)}>今天</button><IconButton label="下一周期" onClick={() => navigate(1)}><ChevronRight size={14}/></IconButton></div></div>
      </div>
      {searchOpen && <div className="search-bar"><Search size={14}/><input ref={searchRef} aria-label="搜索标题、地点和备注" placeholder="搜索标题、地点和备注…" value={query} onChange={e => setQuery(e.target.value)}/><span>当前日期范围</span><IconButton label="关闭搜索" onClick={() => { setSearchOpen(false); setQuery(''); }}><X size={16}/></IconButton></div>}
      {error && <div className="app-error" role="alert"><TriangleAlert size={17}/><span>{error}</span><IconButton label="关闭错误提示" onClick={() => setError('')}><X size={15}/></IconButton></div>}
      {snapshot?.diagnostics.map(d => <div className="app-error" key={d}><TriangleAlert size={16}/>{d}</div>)}
      <UpdateNotice open={() => setSettingsTab('updates')}/>
      {!loading && snapshot?.accounts.length === 0 && <div className="onboarding-strip"><Cloud size={18}/><div><strong>从你的第一本日历开始</strong><span>连接 CalDAV 账户，日程即可在这里出现。</span></div><button onClick={() => setSettingsTab('accounts')}>连接账户<ChevronRight size={15}/></button></div>}
      <div className="calendar-container" ref={calendarContainer}>{loading ? <div className="calendar-loading">正在读取本地日历…</div> : view === 'dayGridMonth' ? <MonthGrid now={now} month={month} firstDay={firstDay} timezone={prefs?.timezone || 'local'} selected={selected} timeFormat={prefs?.timeFormat || '24'} events={displayEvents} calendars={snapshot?.calendars || []} select={setSelected} create={create} open={openEvent} move={moveMonthEvent}/> : view === 'multiMonthYear' ? <YearGrid year={year} firstDay={firstDay} timezone={prefs?.timezone || 'local'} now={now} openMonth={openYearMonth} create={date => { openYearMonth(date); create(date); }}/> : <FullCalendar key={booted.current ? 'calendar' : 'initial'} ref={calendarRef} plugins={calendarPlugins} locale={zhCn} initialView={view} initialDate={selected} handleWindowResize={false} headerToolbar={false} height="100%" firstDay={firstDay} timeZone={prefs?.timezone || 'local'} events={fcEvents} selectable selectMirror editable nowIndicator dayMaxEvents={true} moreLinkText={n => `还有 ${n} 项`} allDayText="全天" noEventsContent="这段时间没有安排，留一点时间给自己。" eventTimeFormat={{ hour: '2-digit', minute: '2-digit', hour12: prefs?.timeFormat === '12' }} slotLabelFormat={{ hour: 'numeric', minute: '2-digit', hour12: prefs?.timeFormat === '12' }} slotMinTime="00:00:00" slotMaxTime="24:00:00" scrollTime="08:00:00" slotDuration="00:30:00" defaultTimedEventDuration={{ minutes: prefs?.duration || 60 }} weekends fixedWeekCount displayEventTime={false}
        datesSet={datesSet}
        dateClick={info => { if (info.jsEvent.detail === 2) { setSelected(info.dateStr.slice(0, 10)); create(info.dateStr, undefined, false, info.dayEl.getBoundingClientRect()); } }}
        select={info => { if (info.allDay && Date.parse(info.endStr) - Date.parse(info.startStr) <= 86400000) return; create(info.startStr, info.endStr, info.allDay); calendarRef.current?.getApi().unselect(); }}
        eventClick={info => { const event = events.find(e => e.id === info.event.id); if (event) openEvent(event); }}
        eventDrop={moveEvent} eventResize={moveEvent} eventDidMount={info => info.el.style.setProperty('--event-color', info.event.extendedProps.color)}
        dayCellClassNames={[]}
        dayCellContent={info => info.view.type === 'dayGridMonth' ? <MonthDate date={info.date} timezone={prefs?.timezone || 'local'} dayText={info.dayNumberText}/> : info.dayNumberText.replace('日', '')} dayHeaderFormat={view === 'dayGridMonth' ? { weekday: 'short' } : { weekday: 'short', month: 'numeric', day: 'numeric' }} eventContent={info => <div className="calendar-event-content" title={`${info.event.title}${info.event.extendedProps.location ? ` · ${info.event.extendedProps.location}` : ''}`}><span className="event-name">{info.event.title}</span>{info.event.extendedProps.pending && <span className="event-unsynced" title="待同步">·</span>}{info.event.extendedProps.recurring && <Repeat2 size={10}/>}</div>}
      />}</div>
    </main>
    {notice && <div className="toast" role="status"><CircleCheck size={17}/>{notice}</div>}
    {editor && snapshot && <Editor key={`${editor.resourceId ?? 'new'}:${editor.start}`} initial={editor} anchor={editorAnchor} duration={snapshot.settings.duration} changed={updateDraft} calendars={snapshot.calendars} close={() => { setEditor(null); setDraft(null); }} saved={() => { setNotice('日程已保存在本地'); void refresh(); }}/>} {settingsTab && snapshot && <SettingsPanel snapshot={snapshot} close={() => setSettingsTab(null)} refresh={() => void refresh()} initialTab={settingsTab}/>}
    <datalist id="timezones">{['Asia/Shanghai','Asia/Hong_Kong','Asia/Tokyo','Asia/Singapore','Europe/London','Europe/Berlin','America/New_York','America/Los_Angeles','Australia/Sydney','UTC'].map(t => <option key={t} value={t}/>)}</datalist>
  </div></div>;
}
