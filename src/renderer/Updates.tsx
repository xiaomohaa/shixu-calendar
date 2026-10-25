import { useEffect, useState } from 'react';
import { Download, ExternalLink, RefreshCw, RotateCw } from 'lucide-react';
import type { UpdateState } from '../shared/updates';

export function useUpdates() {
  const [state, setState] = useState<UpdateState | null>(null);
  useEffect(() => {
    let active = true, received = false;
    const unsubscribe = window.shixu?.onUpdateChange(next => { received = true; if (active) setState(next); });
    void window.shixu?.updateState().then(next => { if (active && !received) setState(next); }).catch(() => {});
    return () => { active = false; unsubscribe?.(); };
  }, []);
  return state;
}
export const hasAvailableUpdate = (state: UpdateState | null) => !!state?.release && state.release.version !== state.currentVersion && !['idle', 'current'].includes(state.phase);
const phaseText: Record<UpdateState['phase'], string> = {
  idle: '随时检查新版本', checking: '正在检查新版本…', current: '已是最新版本', available: '有新版本可用',
  downloading: '正在下载更新…', downloaded: '更新已就绪', installing: '正在安全退出并安装…', error: '暂时无法完成更新',
};
const mb = (value: number) => `${(value / 1024 / 1024).toFixed(1)} MB`;

export function UpdatesPanel() {
  const state = useUpdates();
  const [automatic, setAutomatic] = useState(true), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  useEffect(() => { void window.shixu.snapshot().then(s => setAutomatic(s.settings.autoUpdateCheck)).catch(e => setError(e.message)); }, []);
  const act = async (fn: () => Promise<unknown>) => { setError(''); try { await fn(); } catch (e) { setError((e as Error).message); } };
  if (!state) return <p role="status">正在读取版本信息…</p>;
  const blocked = ['checking', 'downloading', 'installing'].includes(state.phase);
  return <section className="updates-section">
    <h3>关于与更新</h3><p className="section-description">时序日历 · 留给生活的时间</p>
    <div className="version-heading"><img src={new URL('../../build/icon.png', import.meta.url).href} alt=""/><div><strong>时序日历</strong><span>版本 {state.currentVersion} · {({ installer: '安装版', portable: '便携版', unpacked: '解压版', development: '开发模式' })[state.mode]}</span></div></div>
    <div className="update-status" aria-live="polite"><strong>{phaseText[state.phase]}{state.release && ` · ${state.release.version}`}</strong>
      {state.phase === 'downloaded' && <p>下载文件已通过完整性校验。可现在安装，也可稍后回来；普通退出不会自动安装。</p>}
      {state.lastChecked && <small>上次成功检查：{new Date(state.lastChecked).toLocaleString('zh-CN')}</small>}
      {(state.error || error) && <div className="error-box" role="alert">{error || state.error}</div>}
      {state.phase === 'downloading' && <div className="update-progress"><progress aria-label="更新下载进度" max={100} value={state.progress?.percent || 0}/><span>{Math.min(100, state.progress?.percent || 0).toFixed(0)}% · {mb(state.progress?.transferred || 0)} / {mb(state.progress?.total || 0)}{state.progress ? ` · ${mb(state.progress.bytesPerSecond)}/s` : ''}</span></div>}
      {state.mode === 'development' && <p>开发模式不检查和安装更新。请使用正式安装版验证更新。</p>}
      {['portable', 'unpacked'].includes(state.mode) && <p>此版本可检查更新。请从发布页面下载，退出后替换应用文件；本地数据会保留。</p>}
      <div className="form-actions">
        <button disabled={blocked || state.mode === 'development' || state.phase === 'downloaded'} onClick={() => void act(() => window.shixu.checkForUpdates())}><RefreshCw size={15} className={state.phase === 'checking' ? 'spin' : ''}/>检查更新</button>
        {state.mode === 'installer' && state.release && ['available', 'error'].includes(state.phase) && <button className="primary" onClick={() => void act(() => window.shixu.downloadUpdate())}><Download size={15}/>下载更新</button>}
        {state.phase === 'downloading' && <button onClick={() => void act(() => window.shixu.cancelUpdateDownload())}>取消下载</button>}
        {state.phase === 'downloaded' && <button className="primary" onClick={() => void act(() => window.shixu.installUpdate())}><RotateCw size={15}/>重启并安装</button>}
        <button disabled={state.phase === 'installing'} onClick={() => void act(() => window.shixu.openReleasePage())}><ExternalLink size={15}/>发布页面</button>
      </div>
    </div>
    {state.release?.notes && <div className="release-notes"><h4>更新内容</h4><pre>{state.release.notes}</pre></div>}
    <div className="settings-group"><label className="check-row"><input type="checkbox" disabled={saving || state.mode === 'development' || state.phase === 'installing'} checked={automatic} onChange={event => {
      const checked = event.target.checked; setSaving(true);
      void act(async () => { const s = await window.shixu.snapshot(); await window.shixu.settings({ ...s.settings, autoUpdateCheck: checked }); setAutomatic(checked); }).finally(() => setSaving(false));
    }}/>自动检查新版本</label><p className="form-hint">启动后及运行期间每 6 小时检查 GitHub 正式版本，下载和安装由你决定。</p></div>
  </section>;
}

export function UpdateNotice({ open }: { open: () => void }) {
  const state = useUpdates();
  const [dismissed, setDismissed] = useState('');
  if (!state || !['available', 'downloaded'].includes(state.phase) || dismissed === `${state.release?.version}:${state.phase}`) return null;
  return <div className="update-notice" role="status"><Download size={16}/><span>{state.phase === 'downloaded' ? '更新已就绪' : '发现新版本'} {state.release?.version}</span><button onClick={open}>{state.phase === 'downloaded' ? '安装选项' : '查看更新'}</button><button aria-label="稍后处理更新" onClick={() => setDismissed(`${state.release?.version}:${state.phase}`)}>稍后</button></div>;
}
