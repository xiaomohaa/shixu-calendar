import { createServer, type IncomingMessage } from 'node:http';
import { once } from 'node:events';
import type { AccountInput } from '../src/shared/contracts';
const esc = (v: string) => v.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export const fixtureIcs = (title = '协议测试', uid = 'fixture-event') => `BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//Fixture//CN\r\nBEGIN:VEVENT\r\nUID:${uid}\r\nDTSTAMP:20261001T000000Z\r\nDTSTART:20261023T020000Z\r\nDTEND:20261023T030000Z\r\nSUMMARY:${title}\r\nX-PRESERVE:original-data\r\nEND:VEVENT\r\nEND:VCALENDAR`;
export async function davServer() {
  const resources = new Map<string, { ics: string; etag: string; revision: number }>();
  const deleted = new Map<string, number>();
  const requests: { method: string; url: string; ifMatch?: string; ifNoneMatch?: string }[] = [];
  let revision = 0, incremental = true, status = 0;
  let beforePut: (() => Promise<void>) | undefined;
  const put = (path: string, ics: string) => { revision++; const item = { ics, etag: `"v${revision}"`, revision }; resources.set(path, item); deleted.delete(path); return item; };
  const remove = (path: string) => { revision++; resources.delete(path); deleted.set(path, revision); };
  const prop = (href: string, props: string) => `<D:response><D:href>${esc(href)}</D:href><D:propstat><D:prop>${props}</D:prop><D:status>HTTP/1.1 200 OK</D:status></D:propstat></D:response>`;
  const resourceEntry = (path: string, data: boolean) => { const r = resources.get(path); return r ? prop(path, `<D:getetag>${esc(r.etag)}</D:getetag>${data ? `<C:calendar-data>${esc(r.ics)}</C:calendar-data>` : ''}`) : `<D:response><D:href>${esc(path)}</D:href><D:status>HTTP/1.1 404 Not Found</D:status></D:response>`; };
  const server = createServer(async (req, res) => {
    const path = new URL(req.url!, 'http://localhost').pathname, method = req.method!;
    requests.push({ method, url: path, ifMatch: req.headers['if-match'] as string | undefined, ifNoneMatch: req.headers['if-none-match'] as string | undefined });
    if (req.headers.authorization !== `Basic ${Buffer.from('alice:fixture-only-secret').toString('base64')}`) { res.writeHead(401); res.end(); return; }
    if (status) { res.writeHead(status); res.end(); return; }
    const chunks: Buffer[] = []; for await (const c of req) chunks.push(Buffer.from(c)); const body = Buffer.concat(chunks).toString();
    const xml = (content: string, token = '') => { res.writeHead(207, { 'Content-Type': 'application/xml; charset=utf-8' }); res.end(`<?xml version="1.0"?><D:multistatus xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav" xmlns:A="http://apple.com/ns/ical/">${content}${token ? `<D:sync-token>${token}</D:sync-token>` : ''}</D:multistatus>`); };
    if (method === 'PROPFIND') {
      if (path === '/.well-known/caldav') { res.writeHead(301, { Location: '/dav/' }); res.end(); }
      else if (path === '/dav/') xml(prop(path, '<D:current-user-principal><D:href>/principal/</D:href></D:current-user-principal><D:resourcetype><D:collection/></D:resourcetype>'));
      else if (path === '/principal/') xml(prop(path, '<C:calendar-home-set><D:href>/home/</D:href></C:calendar-home-set>'));
      else if (path === '/home/' || path === '/home/personal/') xml(prop('/home/personal/', '<D:displayname>个人日历</D:displayname><D:resourcetype><D:collection/><C:calendar/></D:resourcetype><C:supported-calendar-component-set><C:comp name="VEVENT"/></C:supported-calendar-component-set><A:calendar-color>#497bbaFF</A:calendar-color><D:current-user-privilege-set><D:privilege><D:write/></D:privilege></D:current-user-privilege-set>'));
      else { res.writeHead(404); res.end(); } return;
    }
    if (method === 'REPORT') {
      if (/sync-collection/.test(body)) {
        if (!incremental) { res.writeHead(405); res.end(); return; }
        const token = body.match(/<d:sync-token>(.*?)<\/d:sync-token>/)?.[1] || '';
        if (token && !/^token-\d+$/.test(token)) { res.writeHead(403); res.end(); return; }
        const since = token ? Number(token.slice(6)) : 0;
        xml([...resources].filter(([,v]) => v.revision > since).map(([p]) => resourceEntry(p, false)).join('') + [...deleted].filter(([,v]) => v > since).map(([p]) => resourceEntry(p, false)).join(''), `token-${revision}`);
      } else if (/calendar-multiget/.test(body)) {
        const paths = [...body.matchAll(/<d:href>(.*?)<\/d:href>/g)].map(m => m[1].replace(/&amp;/g, '&')); xml(paths.map(p => resourceEntry(p, true)).join(''));
      } else if (/calendar-query/.test(body)) xml([...resources.keys()].map(p => resourceEntry(p, true)).join(''));
      else { res.writeHead(400); res.end(); } return;
    }
    if (method === 'GET') { const r = resources.get(path); res.writeHead(r ? 200 : 404, r ? { 'Content-Type': 'text/calendar', ETag: r.etag } : {}); res.end(r?.ics); return; }
    if (method === 'PUT') {
      if (beforePut) await beforePut();
      const previous = resources.get(path);
      if ((req.headers['if-none-match'] === '*' && previous) || (req.headers['if-match'] && req.headers['if-match'] !== previous?.etag)) { res.writeHead(412); res.end(); return; }
      const r = put(path, body); res.writeHead(previous ? 204 : 201, { ETag: r.etag }); res.end(); return;
    }
    if (method === 'DELETE') {
      const previous = resources.get(path);
      if (!previous) { res.writeHead(404); res.end(); return; }
      if (req.headers['if-match'] !== previous.etag) { res.writeHead(412); res.end(); return; }
      remove(path); res.writeHead(204); res.end(); return;
    }
    res.writeHead(404); res.end();
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const address = server.address(); if (!address || typeof address === 'string') throw new Error();
  const url = `http://127.0.0.1:${address.port}`;
  const account: AccountInput = { name: '测试账户', url: `${url}/dav/`, username: 'alice', password: 'fixture-only-secret', allowHttp: true, paused: false };
  return { server, url, account, resources, requests, put, remove, set incremental(v: boolean) { incremental = v; }, set status(v: number) { status = v; }, set beforePut(v: (() => Promise<void>) | undefined) { beforePut = v; }, close: async () => { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); } };
}
