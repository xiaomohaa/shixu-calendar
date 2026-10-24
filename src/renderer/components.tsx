import { cloneElement, isValidElement, useEffect, useLayoutEffect, useId, useRef, useState, type ButtonHTMLAttributes, type CSSProperties, type ReactElement, type ReactNode } from 'react';
import { X, LoaderCircle } from 'lucide-react';
import { popoverLayout, type PanelAnchor } from './popoverLayout';
export function IconButton({ label, children, ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { label: string; children: ReactNode }) { return <button className="icon-button" title={label} aria-label={label} {...props}>{children}</button>; }
export function Panel({ title, subtitle, close, children, wide = false, floating = false, anchor, hideHeader = false }: { title: string; subtitle?: string; close: () => void; children: ReactNode; wide?: boolean; floating?: boolean; anchor?: PanelAnchor; hideHeader?: boolean }) {
  const ref = useRef<HTMLElement>(null);
  const [position, setPosition] = useState<ReturnType<typeof popoverLayout>>();
  useLayoutEffect(() => {
    const element = ref.current; if (!floating || !element) return;
    const measure = () => setPosition(popoverLayout(anchor, element.offsetWidth, element.offsetHeight, innerWidth, innerHeight));
    measure(); const observer = new ResizeObserver(measure); observer.observe(element);
    window.addEventListener('resize', measure);
    return () => { observer.disconnect(); window.removeEventListener('resize', measure); };
  }, [floating, anchor]);
  useEffect(() => { const previous = document.activeElement as HTMLElement | null; if (!ref.current?.contains(previous)) ref.current?.querySelector<HTMLElement>('button,input,select,textarea')?.focus(); return () => previous?.focus(); }, []);
  return <div className={`panel-backdrop ${floating ? 'editor-backdrop' : ''}`} onMouseDown={e => { if (e.target === e.currentTarget) close(); }}><section ref={ref} role="dialog" aria-modal="true" aria-label={title} className={`panel ${wide ? 'settings-panel' : 'editor-panel'} ${floating ? 'floating-editor' : ''} ${hideHeader ? 'headerless-panel' : ''}`} data-side={position?.side} style={floating ? { left: position?.left, top: position?.top, '--arrow-top': `${position?.arrow ?? 24}px` } as CSSProperties : undefined} onKeyDown={e => { if (e.key === 'Escape') close(); if (e.key === 'Tab') { const nodes = Array.from(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),summary') ?? []).filter(el => el.getClientRects().length); const first = nodes[0], last = nodes.at(-1); if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last?.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first?.focus(); } } }}>{!hideHeader && <header className="panel-header"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><IconButton label="关闭面板" onClick={close}><X size={20}/></IconButton></header>}{children}</section></div>;
}
export function Busy({ text = '正在处理…' }: { text?: string }) { return <span className="busy"><LoaderCircle size={15} className="spin"/>{text}</span>; }
export function Field({ label, children, hint }: { label: string; children: ReactNode; hint?: string }) { const id = useId(); const child = children as ReactElement<{ id?: string; 'aria-label'?: string; 'aria-describedby'?: string }>; return <label className="field" htmlFor={child.props?.id ?? id}><span>{label}</span>{isValidElement(child) ? cloneElement(child, { id: child.props.id ?? id, 'aria-label': child.props['aria-label'] ?? label, 'aria-describedby': hint ? `${id}-hint` : undefined }) : children}{hint && <small id={`${id}-hint`}>{hint}</small>}</label>; }
