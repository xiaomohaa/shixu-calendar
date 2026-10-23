import { davRequest, createObject, updateObject, deleteObject } from 'tsdav';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { randomUUID } from 'node:crypto';
import type { AccountInput, Calendar } from '../shared/contracts';
import { AppError, httpError } from '../shared/errors';

type Node = Record<string, unknown>;
const object = (v: unknown): Node => v && typeof v === 'object' ? v as Node : {};
const list = (v: unknown): unknown[] => v === undefined ? [] : Array.isArray(v) ? v : [v];
export const text = (v: unknown): string => typeof v === 'string' ? v : typeof v === 'number' ? String(v) : text(object(v)['#text'] ?? '');
const statusCode = (v: unknown) => Number(text(v).match(/\b(\d{3})\b/)?.[1] ?? 0);
export interface DavEntry { href: string; status: number; props: Node }
export interface DavResult { entries: DavEntry[]; token: string | null }
const parser = new XMLParser({ ignoreAttributes: false, removeNSPrefix: true, parseTagValue: false, trimValues: false, processEntities: true });
export function parseDav(xml: string): DavResult {
  if (xml.length > 32 * 1024 * 1024 || /<!DOCTYPE|<!ENTITY/i.test(xml) || XMLValidator.validate(xml) !== true) throw new AppError('服务器返回的 DAV XML 无效');
  const document = object(parser.parse(xml)), root = object(document.multistatus);
  if (!Object.hasOwn(document, 'multistatus')) throw new AppError('服务器未返回 DAV multistatus，请检查服务地址');
  return { token: text(root['sync-token']) || null, entries: list(root.response).map(value => {
    const row = object(value), props: Node = {};
    for (const stat of list(row.propstat)) { const s = object(stat); if (statusCode(s.status) >= 200 && statusCode(s.status) < 300) Object.assign(props, object(s.prop)); }
    return { href: text(row.href).trim(), status: statusCode(row.status) || 200, props };
  }) };
}
export function normalizeUrl(value: string, allowHttp = false): string {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'https:' && !(url.protocol === 'http:' && allowHttp)) throw new Error();
    if (url.username || url.password || url.search || url.hash) throw new Error();
    return url.href;
  } catch { throw new AppError('请输入完整 HTTPS 地址，不含密码、查询参数或片段；HTTP 需要明确勾选允许'); }
}
const escapeXml = (s: string) => s.replace(/[<>&"']/g, ch => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&apos;' })[ch]!);
const namespaces = 'xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav" xmlns:a="http://apple.com/ns/ical/"';
const properties = '<d:displayname/><d:resourcetype/><d:current-user-principal/><c:calendar-home-set/><c:supported-calendar-component-set/><a:calendar-color/><d:current-user-privilege-set/><d:supported-report-set/><d:sync-token/>';
export interface RemoteObject { url: string; etag: string | null; ics: string | null; deleted: boolean }
export interface Pull { objects: RemoteObject[]; token: string | null; full: boolean }

export class DavClient {
  readonly origin: string;
  readonly base: string;
  private lastUrl = '';
  private signal: AbortSignal;
  constructor(private account: AccountInput & { password: string }, signal?: AbortSignal) {
    this.base = normalizeUrl(account.url, account.allowHttp); this.origin = new URL(this.base).origin; this.signal = signal ?? new AbortController().signal;
  }
  resolve(href: string, base: string) {
    const url = new URL(href, base);
    if (url.origin !== this.origin || url.username || url.password || url.hash) throw new AppError('服务器指向另一个站点。为保护凭据，请使用该站点的具体 CalDAV 地址添加账户');
    return url.href;
  }
  /** Credentials never follow cross-origin redirects. TLS stays verified. */
  fetch: typeof fetch = async (input, init) => {
    let url = this.resolve(String(input), this.base);
    const headers = new Headers(init?.headers);
    headers.set('Authorization', `Basic ${Buffer.from(`${this.account.username}:${this.account.password}`, 'utf8').toString('base64')}`);
    for (let redirects = 0; redirects < 6; redirects++) {
      const response = await fetch(url, { ...init, headers, redirect: 'manual', signal: AbortSignal.any([this.signal, AbortSignal.timeout(25000)]) });
      if ([301, 302, 307, 308].includes(response.status) && response.headers.get('location')) { const next = this.resolve(response.headers.get('location')!, url); await response.body?.cancel(); url = next; continue; }
      this.lastUrl = url;
      // Bound both declared and chunked responses; never log untrusted response bodies.
      if (Number(response.headers.get('content-length') ?? 0) > 32 * 1024 * 1024) { await response.body?.cancel(); throw new AppError('服务器单次响应超过 32MB，请减少日历资源大小'); }
      const reader = response.body?.getReader(), chunks: Uint8Array[] = []; let size = 0;
      if (reader) { while (true) { const p = await reader.read(); if (p.done) break; size += p.value.length; if (size > 32 * 1024 * 1024) { await reader.cancel(); throw new AppError('服务器响应过大，已停止读取'); } chunks.push(p.value); } }
      return new Response(size ? Buffer.concat(chunks) : null, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    throw new AppError('服务器重定向次数过多，请填写最终服务地址');
  };
  private async xml(url: string, method: 'PROPFIND' | 'REPORT', body: string, depth = '0') {
    const rows = await davRequest({ url, init: { method, headers: { Depth: depth }, body }, convertIncoming: false, parseOutgoing: false, fetch: this.fetch });
    if (!rows[0]?.ok) throw httpError(rows[0]?.status ?? 500);
    return { result: parseDav(String(rows[0].raw)), url: this.lastUrl };
  }
  private propfind(url: string, depth = '0') { return this.xml(url, 'PROPFIND', `<d:propfind ${namespaces}><d:prop>${properties}</d:prop></d:propfind>`, depth); }
  private calendar(entry: DavEntry, base: string, accountId: string): Calendar | undefined {
    const p = entry.props;
    if (!('calendar' in object(p.resourcetype))) return;
    const comps = list(object(p['supported-calendar-component-set']).comp).map(c => text(object(c)['@_name']).toUpperCase());
    if (comps.length && !comps.includes('VEVENT')) return;
    const privileges = list(object(p['current-user-privilege-set']).privilege).flatMap(v => Object.keys(object(v)));
    const color = text(p['calendar-color']).slice(0, 7);
    return { id: randomUUID(), accountId, url: this.resolve(entry.href, base), name: text(p.displayname).trim() || '未命名日历', color: /^#[\da-f]{6}$/i.test(color) ? color : '#d65c4f', visible: true, readOnly: privileges.length > 0 && !privileges.some(v => ['all', 'write', 'write-content'].includes(v)) };
  }
  async discover(accountId = ''): Promise<Calendar[]> {
    const candidates = [this.base, `${this.origin}/.well-known/caldav`];
    let last: unknown = new AppError('未发现日历，请填写更具体的服务或日历地址');
    for (const candidate of [...new Set(candidates)]) {
      try {
        const first = await this.propfind(candidate);
        const direct = first.result.entries.map(e => this.calendar(e, first.url, accountId)).filter((c): c is Calendar => !!c);
        if (direct.length) return direct;
        let home = first.result.entries.map(e => text(object(e.props['calendar-home-set']).href)).find(Boolean);
        let homeBase = first.url;
        if (!home) {
          const principal = first.result.entries.map(e => text(object(e.props['current-user-principal']).href)).find(Boolean);
          if (principal) { const found = await this.propfind(this.resolve(principal, first.url)); home = found.result.entries.map(e => text(object(e.props['calendar-home-set']).href)).find(Boolean); homeBase = found.url; }
        }
        const listing = await this.propfind(home ? this.resolve(home, homeBase) : first.url, '1');
        const calendars = listing.result.entries.map(e => this.calendar(e, listing.url, accountId)).filter((c): c is Calendar => !!c);
        if (calendars.length) return [...new Map(calendars.map(c => [c.url, c])).values()];
      } catch (e) { if (e instanceof AppError && [401, 403, 429].includes(e.status ?? 0)) throw e; last = e; }
    }
    throw last;
  }
  async pull(calendar: Calendar, token: string | null): Promise<Pull> {
    // An initial empty token requests a complete collection and a new token.
    // Unsupported REPORT / invalid tokens fall back to a complete calendar-query.
    try {
      const { result } = await this.xml(calendar.url, 'REPORT', `<d:sync-collection ${namespaces}><d:sync-token>${escapeXml(token ?? '')}</d:sync-token><d:sync-level>1</d:sync-level><d:prop><d:getetag/></d:prop></d:sync-collection>`, '1');
      if (!result.token) throw new AppError('服务器未返回有效同步令牌');
      return { objects: await this.materialize(result.entries, calendar.url), token: result.token, full: !token };
    } catch (e) {
      if (this.signal.aborted || (e instanceof AppError && ![400, 403, 404, 405, 409, 410, 501, 507].includes(e.status ?? 0) && e.status !== undefined)) throw e;
    }
    const { result } = await this.xml(calendar.url, 'REPORT', `<c:calendar-query ${namespaces}><d:prop><d:getetag/><c:calendar-data/></d:prop><c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VEVENT"/></c:comp-filter></c:filter></c:calendar-query>`, '1');
    return { objects: await this.materialize(result.entries, calendar.url), token: null, full: true };
  }
  private async materialize(entries: DavEntry[], base: string): Promise<RemoteObject[]> {
    const output: RemoteObject[] = [], missing: string[] = [];
    for (const e of entries) {
      if (!e.href || this.resolve(e.href, base).replace(/\/$/, '') === base.replace(/\/$/, '')) continue;
      if ([404, 410].includes(e.status)) { output.push({ url: this.resolve(e.href, base), etag: null, ics: null, deleted: true }); continue; }
      if (e.status < 200 || e.status >= 300) throw httpError(e.status);
      const ics = text(e.props['calendar-data']);
      if (ics) output.push({ url: this.resolve(e.href, base), etag: text(e.props.getetag) || null, ics, deleted: false });
      else missing.push(this.resolve(e.href, base));
    }
    for (let i = 0; i < missing.length; i += 80) {
      const urls = missing.slice(i, i + 80);
      const { result } = await this.xml(base, 'REPORT', `<c:calendar-multiget ${namespaces}><d:prop><d:getetag/><c:calendar-data/></d:prop>${urls.map(u => `<d:href>${escapeXml(new URL(u).pathname)}</d:href>`).join('')}</c:calendar-multiget>`, '1');
      const mapped = new Map(result.entries.map(e => [this.resolve(e.href, base), e]));
      for (const url of urls) {
        const e = mapped.get(url); if (!e) throw new AppError('服务器遗漏 calendar-multiget 资源，已保留原缓存和同步令牌');
        if ([404, 410].includes(e.status)) output.push({ url, etag: null, ics: null, deleted: true });
        else if (e.status >= 200 && e.status < 300 && text(e.props['calendar-data'])) output.push({ url, etag: text(e.props.getetag) || null, ics: text(e.props['calendar-data']), deleted: false });
        else throw new AppError('服务器返回不完整日程数据，已停止本轮同步');
      }
    }
    return output;
  }
  async get(url: string) {
    const response = await this.fetch(url, { method: 'GET' });
    if (response.status === 404) return null;
    if (!response.ok) throw httpError(response.status);
    return { ics: await response.text(), etag: response.headers.get('etag') };
  }
  async put(url: string, ics: string, etag: string | null) {
    const response = etag ? await updateObject({ url, data: ics, etag, headers: { 'Content-Type': 'text/calendar; charset=utf-8' }, fetch: this.fetch }) : await createObject({ url, data: ics, headers: { 'If-None-Match': '*', 'Content-Type': 'text/calendar; charset=utf-8' }, fetch: this.fetch });
    if (!response.ok) throw httpError(response.status);
    return response.headers.get('etag');
  }
  async delete(url: string, etag: string) {
    const response = await deleteObject({ url, etag, fetch: this.fetch });
    if (!response.ok && response.status !== 404) throw httpError(response.status);
  }
}
