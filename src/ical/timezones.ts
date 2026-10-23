import ICAL from 'ical.js';
import { DateTime, IANAZone } from 'luxon';
import { AppError } from '../shared/errors';
const cache = new Map<string, string>();
const stamp = (ms: number) => DateTime.fromMillis(ms, { zone: 'UTC' }).toFormat("yyyyMMdd'T'HHmmss");
const offsetText = (n: number) => `${n < 0 ? '-' : '+'}${String(Math.floor(Math.abs(n) / 60)).padStart(2, '0')}${String(Math.round(Math.abs(n) % 60)).padStart(2, '0')}`;

/** Embedded observances keep recurring local times portable, without depending on
 * a provider's TZID database. IANA transition data is supplied by Electron's ICU.
 * Definitions cover 1900–2100; retain original server definitions when present. */
export function timezoneComponent(tzid: string): ICAL.Component {
  if (!IANAZone.isValidZone(tzid)) throw new AppError('时区无效，请使用 IANA 时区名称');
  if (!cache.has(tzid)) {
    const zone = IANAZone.create(tzid);
    const begin = Date.UTC(1900, 0, 1), end = Date.UTC(2101, 0, 1), step = 7 * 86400000;
    let prev = begin, from = zone.offset(begin);
    const groups = new Map<string, { from: number; to: number; times: string[] }>();
    for (let t = begin + step; t <= end; t += step) {
      const to = zone.offset(t);
      if (to !== from) {
        let lo = prev, hi = t;
        while (hi - lo > 60000) { const mid = Math.floor((lo + hi) / 120000) * 60000; if (zone.offset(mid) === from) lo = mid; else hi = mid; }
        const transition = Math.ceil(hi / 60000) * 60000;
        const key = `${from}/${to}`, group = groups.get(key) ?? { from, to, times: [] };
        group.times.push(stamp(transition + from * 60000)); groups.set(key, group); from = to;
      }
      prev = t;
    }
    const initial = zone.offset(begin);
    const lines = ['BEGIN:VTIMEZONE', `TZID:${tzid}`, 'BEGIN:STANDARD', 'DTSTART:19000101T000000', `TZOFFSETFROM:${offsetText(initial)}`, `TZOFFSETTO:${offsetText(initial)}`, 'END:STANDARD'];
    for (const g of groups.values()) { const kind = g.to > g.from ? 'DAYLIGHT' : 'STANDARD'; lines.push(`BEGIN:${kind}`, `DTSTART:${g.times[0]}`, `TZOFFSETFROM:${offsetText(g.from)}`, `TZOFFSETTO:${offsetText(g.to)}`); if (g.times.length > 1) for (const time of g.times) lines.push(`RDATE:${time}`); lines.push(`END:${kind}`); }
    lines.push('END:VTIMEZONE'); cache.set(tzid, lines.join('\r\n'));
  }
  return new ICAL.Component(ICAL.parse(cache.get(tzid)!));
}
