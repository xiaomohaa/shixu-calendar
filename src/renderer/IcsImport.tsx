import { useState } from 'react';
import { Download } from 'lucide-react';
import { Field } from './components';

export function IcsImport({ imported }: { imported: () => void }) {
  const [name, setName] = useState(''), [url, setUrl] = useState(''), [allowHttp, setAllowHttp] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [done, setDone] = useState(false);
  return <details className="ics-import settings-group"><summary>通过 ICS 链接导入日历</summary>
    <p className="form-hint">粘贴 iCloud 节假日或其他公开日历的 ICS 链接。导入后以只读日历显示，可手动或自动同步刷新。</p>
    <form onSubmit={event => {
      event.preventDefault(); setBusy(true); setError(''); setDone(false);
      void (async () => {
        try {
          if (!window.shixu.importCalendarUrl) throw new Error('请使用 Tauri 版导入 ICS 日历');
          await window.shixu.importCalendarUrl({ name, url: url.trim(), allowHttp });
          setDone(true); setUrl(''); setName(''); imported();
        } catch (error) { setError((error as Error).message); }
        finally { setBusy(false); }
      })();
    }}>
      <Field label="日历名称"><input aria-label="订阅日历名称" required maxLength={100} placeholder="例如：中国节假日" value={name} disabled={busy} onChange={e => setName(e.target.value)}/></Field>
      <Field label="ICS 链接"><input aria-label="ICS 链接" required placeholder="https://calendars.icloud.com/holidays/cn_zh.ics/" value={url} disabled={busy} onChange={e => setUrl(e.target.value)}/></Field>
      <label className="check-row"><input type="checkbox" checked={allowHttp} disabled={busy} onChange={e => setAllowHttp(e.target.checked)}/>允许 HTTP 链接</label>
      {error && <div className="error-box" role="alert">{error}</div>}
      {done && <p className="success-box" role="status">日历已导入，可在侧栏查看或调整颜色。</p>}
      <button className="primary" disabled={busy}><Download size={15}/>{busy ? '正在导入…' : '导入 ICS 日历'}</button>
    </form>
  </details>;
}
