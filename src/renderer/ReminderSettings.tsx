import { useEffect, useState } from 'react';
import { Bell } from 'lucide-react';
import './notification-settings.css';

export function ReminderSettings() {
  const [mode,setMode] = useState<'system'|'floating'>('system'), [busy,setBusy] = useState(true), [error,setError] = useState(''), [message,setMessage] = useState('');
  useEffect(() => { void window.shixu.snapshot().then(state => setMode(state.settings.notificationMode ?? 'system')).catch(error => setError(error.message)).finally(() => setBusy(false)); },[]);
  if (!window.shixu.testNotification) return null;
  const change = async (next: 'system'|'floating') => {
    const previous = mode; setMode(next);
    setBusy(true); setError(''); setMessage('');
    try { const state = await window.shixu.snapshot(); await window.shixu.settings({ ...state.settings,notificationMode:next }); setMode(next); }
    catch (error) { setMode(previous); setError((error as Error).message); } finally { setBusy(false); }
  };
  return <section className="settings-group reminder-settings"><h4>日程通知</h4>
    <div className="reminder-mode-options"><label className="check-row"><input type="radio" name="notificationMode" checked={mode === 'system'} disabled={busy} onChange={() => void change('system')}/>系统通知</label><label className="check-row"><input type="radio" name="notificationMode" checked={mode === 'floating'} disabled={busy} onChange={() => void change('floating')}/>macOS 风格悬浮通知</label></div>
    <p className="form-hint">悬浮提醒显示在当前显示器右上角，不抢占焦点。悬停暂停消失，可在10分钟后再次提醒或打开对应日程。应用须保持运行，收纳到托盘后仍可提醒。</p>
    <button disabled={busy} onClick={() => { setError(''); setMessage(''); void window.shixu.testNotification!().then(() => setMessage('测试通知已发送')).catch(error => setError(error.message)); }}><Bell size={14}/>测试通知</button>
    {error && <p className="error-box" role="alert">{error}</p>}{message && <p className="success-box" role="status">{message}</p>}
  </section>;
}
