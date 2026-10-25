import { useEffect, useState } from 'react';
import type { DesktopState } from '../shared/updates';

export function DesktopSettings() {
  const [desktop, setDesktop] = useState<DesktopState | null>(null), [closeToTray, setCloseToTray] = useState(true), [silentStartup, setSilentStartup] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  useEffect(() => { void Promise.all([window.shixu.desktopState(), window.shixu.snapshot()]).then(([d, s]) => { setDesktop(d); setCloseToTray(s.settings.closeToTray); setSilentStartup(s.settings.silentStartup ?? false); }).catch(e => setError(e.message)); }, []);
  const act = async (fn: () => Promise<unknown>) => { setBusy(true); setError(''); setMessage(''); try { await fn(); setMessage('设置已保存'); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } };
  return <section><h3>启动与后台</h3><p className="section-description">让日历在你需要时保持就绪。</p>
    {error && <div className="error-box" role="alert">{error}</div>}{message && <p className="success-box" role="status">{message}</p>}
    <label className="check-row"><input type="checkbox" disabled={busy || !desktop?.canAutoStart} checked={desktop?.openAtLogin || false} onChange={e => { const value = e.target.checked; void act(async () => setDesktop(await window.shixu.setAutoStart(value))); }}/>开机自启</label>
    <p className="form-hint">登录 Windows 后自动启动并收纳到系统托盘。默认关闭。{desktop && !desktop.canAutoStart && '安装正式安装版后可开启此项。'}</p>
    {desktop?.openAtLogin && !desktop.startupEnabled && <p className="error-box">启动项已保存，但被 Windows 禁用。请在任务管理器的“启动应用”中启用时序日历。</p>}
    <div className="settings-group"><label className="check-row"><input type="checkbox" disabled={busy} checked={silentStartup} onChange={e => { const checked = e.target.checked; void act(async () => { const s = await window.shixu.snapshot(); await window.shixu.settings({ ...s.settings, silentStartup: checked }); setSilentStartup(checked); }); }}/>静默启动</label><p className="form-hint">下次启动时直接进入系统托盘，不打开主窗口。点击托盘图标或再次启动应用可打开日历。后台同步和提醒继续运行。</p></div>
    <div className="settings-group"><label className="check-row"><input type="checkbox" disabled={busy} checked={closeToTray} onChange={e => { const checked = e.target.checked; void act(async () => { const s = await window.shixu.snapshot(); await window.shixu.settings({ ...s.settings, closeToTray: checked }); setCloseToTray(checked); }); }}/>关闭窗口后收纳到系统托盘</label><p className="form-hint">收纳后同步和日程提醒继续运行。点击右下角托盘图标打开日历；右键选择“退出时序日历”可彻底退出。若图标隐藏，请展开托盘箭头。</p></div>
    <div className="settings-group"><button disabled={busy} onClick={() => void act(() => window.shixu.quitApp())}>退出时序日历</button><p className="form-hint">退出前会停止同步并保存本地数据，未同步修改下次启动仍可继续提交。</p></div>
  </section>;
}
