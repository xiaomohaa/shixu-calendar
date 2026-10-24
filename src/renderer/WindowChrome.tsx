import { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Minus, Square, Copy, X } from 'lucide-react';

export function WindowChrome() {
  const [maximized, setMaximized] = useState(false);
  useEffect(() => {
    if (!window.__TAURI_INTERNALS__) return;
    const appWindow = getCurrentWindow();
    let stop: (() => void) | undefined, disposed = false;
    const update = () => void appWindow.isMaximized().then(value => {
      if (!disposed) { setMaximized(value); document.documentElement.dataset.maximized = String(value); }
    });
    update();
    void appWindow.onResized(update).then(unlisten => { if (disposed) unlisten(); else stop = unlisten; });
    return () => { disposed = true; stop?.(); };
  }, []);
  if (!window.__TAURI_INTERNALS__) return null;
  return <div className="window-chrome">
    <div className="window-drag-region" data-tauri-drag-region><span data-tauri-drag-region>时序日历</span></div>
    <div className="window-actions">
      <button aria-label="最小化窗口" title="最小化" onClick={() => void getCurrentWindow().minimize()}><Minus size={13}/></button>
      <button aria-label={maximized ? '还原窗口' : '最大化窗口'} title={maximized ? '还原' : '最大化'} onClick={() => void getCurrentWindow().toggleMaximize()}>{maximized ? <Copy size={12}/> : <Square size={12}/>}</button>
      <button className="window-close" aria-label="关闭窗口" title="关闭" onClick={() => void getCurrentWindow().close()}><X size={14}/></button>
    </div>
  </div>;
}
