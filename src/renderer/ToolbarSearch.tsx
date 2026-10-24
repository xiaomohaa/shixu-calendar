import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react';
import { Search, X } from 'lucide-react';

export function ToolbarSearch({ open, value, change, toggle, before, after }: {
  open: boolean; value: string; change(value: string): void; toggle(open: boolean): void; before: ReactNode; after: ReactNode;
}) {
  const root = useRef<HTMLDivElement>(null), input = useRef<HTMLInputElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const previous = useRef(new Map<string, DOMRect>()), initialized = useRef(false);
  const wasOpen = useRef(false);
  useEffect(() => {
    const measure = () => {
      for (const node of root.current?.querySelectorAll<HTMLElement>('[data-search-motion]') ?? []) {
        node.getAnimations().forEach(animation => animation.cancel());
        previous.current.set(node.dataset.searchMotion!, node.getBoundingClientRect());
      }
    };
    window.addEventListener('resize', measure);
    return () => window.removeEventListener('resize', measure);
  }, []);
  useLayoutEffect(() => {
    const element = root.current; if (!element) return;
    const nodes = Array.from(element.querySelectorAll<HTMLElement>('[data-search-motion]'));
    const next = new Map<string, DOMRect>();
    const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;
    for (const node of nodes) {
      const key = node.dataset.searchMotion!, old = previous.current.get(key);
      node.getAnimations().forEach(animation => animation.cancel());
      const rect = node.getBoundingClientRect(); next.set(key, rect);
      if (old && !reduced) node.animate([{ transform: `translateX(${old.left - rect.left}px)` }, { transform: 'translateX(0)' }], { duration: 260, easing: 'cubic-bezier(.16,1,.3,1)' });
    }
    if (initialized.current && !reduced) {
      const shell = element.querySelector<HTMLElement>('.inline-search')!;
      const width = shell.getBoundingClientRect().width;
      shell.animate(open ? [{ clipPath: `inset(0 0 0 ${Math.max(0, width - 26)}px round 999px)` }, { clipPath: 'inset(0 round 999px)' }] : [{ opacity: .7 }, { opacity: 1 }], { duration: 260, easing: 'cubic-bezier(.16,1,.3,1)' });
    }
    previous.current = next;
    if (open) input.current?.focus();
    else if (wasOpen.current) trigger.current?.focus();
    wasOpen.current = open;
    initialized.current = true;
  }, [open]);
  return <div className="toolbar-right" ref={root}>
    <div className="search-neighbor" data-search-motion="before">{before}</div>
    <div className={`inline-search ${open ? 'is-open' : ''}`} role="search">
      <button ref={trigger} className="toolbar-search" data-search-motion="magnifier" aria-label="搜索日程" aria-expanded={open} onClick={() => toggle(!open)}><Search size={14}/></button>
      <input ref={input} aria-label="搜索标题、地点和备注" aria-hidden={!open} disabled={!open} tabIndex={open ? 0 : -1} placeholder="搜索日程…" value={value} onChange={event => change(event.target.value)}/>
      {open && <button className="inline-search-close" aria-label="关闭搜索" onClick={() => toggle(false)}><X size={12}/></button>}
    </div>
    <div className="search-neighbor" data-search-motion="after">{after}</div>
  </div>;
}
