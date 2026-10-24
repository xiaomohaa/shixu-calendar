export interface PanelAnchor { left: number; right: number; top: number; bottom: number }

export function popoverLayout(anchor: PanelAnchor | undefined, width: number, height: number, viewportWidth: number, viewportHeight: number) {
  const margin = 12, gap = 10;
  const clamp = (value: number, max: number) => Math.max(margin, Math.min(value, max - margin));
  const side = anchor && viewportWidth - anchor.right >= width + gap + margin ? 'right'
    : anchor && anchor.left >= width + gap + margin ? 'left' : 'center';
  const left = clamp(side === 'right' ? anchor!.right + gap : side === 'left' ? anchor!.left - width - gap : (viewportWidth - width) / 2, viewportWidth - width);
  const top = clamp(anchor ? anchor.top - 60 : (viewportHeight - height) / 2, viewportHeight - height);
  return { left, top, side, arrow: anchor ? Math.max(24, Math.min((anchor.top + anchor.bottom) / 2 - top, height - 24)) : 0 };
}
