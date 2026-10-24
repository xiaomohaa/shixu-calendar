/** Keep selected time blocks legible for both pale and saturated calendar colors. */
export function onEventColor(color: string) {
  const rgb = /^#([0-9a-f]{6})$/i.exec(color)?.[1] ?? '497bba';
  const channels = [0, 2, 4].map(index => {
    const value = parseInt(rgb.slice(index, index + 2), 16) / 255;
    return value <= .04045 ? value / 12.92 : ((value + .055) / 1.055) ** 2.4;
  });
  const luminance = channels[0] * .2126 + channels[1] * .7152 + channels[2] * .0722;
  return luminance > .18 ? '#171717' : '#fdfcfb';
}
