import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { X, Clock3 } from 'lucide-react';
import type { ReminderNotice } from '../shared/reminders';
import './notification-toast.css';

const call = <T,>(method: string, paused?: boolean, height?: number, reducedMotion?: boolean) => invoke<T>('notification_call', { method, paused, height, reducedMotion });

export function NotificationToast() {
  const [notice,setNotice] = useState<ReminderNotice>(), [theme,setTheme] = useState('system'), [leaving,setLeaving] = useState(false), [error,setError] = useState('');
  const hovered = useRef(false), action = useRef(false), timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const card = useRef<HTMLElement>(null), lastHeight = useRef(0);
  const leave = (method: 'dismiss' | 'open' | 'snooze') => {
    if (action.current) return; action.current = true; setError(''); setLeaving(true);
    const delay = matchMedia('(prefers-reduced-motion: reduce)').matches ? 0 : 220;
    timer.current = setTimeout(() => { void call(method).catch(error => { action.current = false; setLeaving(false); setError((error as Error).message); }); },delay);
  };
  useEffect(() => {
    let disposed = false; const stops: (() => void)[] = [];
    const subscribe = async () => {
      const exit = await listen('shixu:notification-exit', () => leave('dismiss'));
      const theme = await listen<string>('shixu:notification-theme', event => setTheme(event.payload));
      if (disposed) { exit(); theme(); return; } stops.push(exit,theme);
      try { const notice = await call<ReminderNotice>('ready',undefined,undefined,matchMedia('(prefers-reduced-motion: reduce)').matches); if (!disposed) { setNotice(notice); setTheme(notice.theme); } }
      catch (error) { if (!disposed) setError((error as Error).message); }
    };
    void subscribe();
    const heartbeat = setInterval(() => { if (hovered.current) void call('hover',true).catch(() => {}); },5000);
    return () => { disposed = true; stops.forEach(stop => stop()); clearInterval(heartbeat); clearTimeout(timer.current); };
  }, []);
  useLayoutEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const update = () => { document.documentElement.dataset.theme = theme === 'system' ? media.matches ? 'dark' : 'light' : theme; };
    update(); media.addEventListener('change',update); return () => media.removeEventListener('change',update);
  },[theme]);
  useLayoutEffect(() => {
    const element = card.current; if (!notice || !element) return;
    let disposed = false;
    const measure = () => {
      const height = Math.max(80, Math.min(260, Math.ceil(element.getBoundingClientRect().height) + 8));
      if (height === lastHeight.current) return; lastHeight.current = height;
      void call('resize',undefined,height).then(() => call('present')).catch(error => { if (!disposed) setError((error as Error).message); });
    };
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    return () => { disposed = true; lastHeight.current = 0; observer.disconnect(); };
  },[notice?.key]);
  if (!notice) return null;
  return <div className="notification-stage"><article ref={card} className={`reminder-toast ${leaving ? 'is-leaving' : ''}`} role="status" aria-live="polite"
    onPointerEnter={() => { hovered.current = true; void call('hover',true).catch(() => {}); }} onPointerLeave={() => { hovered.current = false; void call('hover',false).catch(() => {}); }}>
    <header><img src={new URL('../../build/icon.png',import.meta.url).href} alt=""/><span>时序日历</span><small>{notice.test ? '测试通知' : '日程提醒'}</small><button aria-label="关闭提醒" onClick={() => leave('dismiss')}><X size={13}/></button></header>
    <h1 title={notice.title}>{notice.title}</h1>
    <p title={notice.body}>{error || notice.body}</p>
    <footer><button className="reminder-snooze" onClick={() => leave('snooze')} title="10分钟后再次提醒"><Clock3 size={12}/>稍后提醒</button><button className="reminder-open" onClick={() => leave('open')}>{notice.event ? '打开日程' : '打开日历'}</button></footer>
  </article></div>;
}
