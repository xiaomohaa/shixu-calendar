import { randomUUID } from 'node:crypto';
import { Store, type Resource } from '../database/store';
import { Vault } from '../security/vault';
import { AppError, errorMessage } from '../shared/errors';
import { DavClient } from './client';

export class SyncEngine {
  private jobs = new Map<string, { promise: Promise<void>; controller: AbortController }>();
  constructor(private store: Store, private vault: Vault, private changed: () => void, private factory = (account: ConstructorParameters<typeof DavClient>[0], signal: AbortSignal) => new DavClient(account, signal)) {}
  active() { return [...this.jobs.keys()]; }
  async cancel() { const jobs = [...this.jobs.values()]; jobs.forEach(j => j.controller.abort()); await Promise.allSettled(jobs.map(j => j.promise)); }
  sync(id: string): Promise<void> {
    const prior = this.jobs.get(id); if (prior) return prior.promise;
    const controller = new AbortController();
    const promise = Promise.resolve().then(() => this.perform(id, controller.signal)).finally(() => { this.jobs.delete(id); this.changed(); });
    this.jobs.set(id, { promise, controller }); this.changed(); return promise;
  }
  private async perform(id: string, signal: AbortSignal) {
    const account = this.store.account(id); if (!account || account.paused) return;
    try {
      const client = this.factory({ ...account, allowHttp: !!account.allowHttp, paused: !!account.paused, password: await this.vault.open(account.password) }, signal);
      const discovered = await client.discover(id);
      this.store.transaction(() => { for (const c of discovered) this.store.upsertCalendar(c); });
      const urls = new Set(discovered.map(c => c.url));
      if (this.store.calendars().some(c => c.accountId === id && !urls.has(c.url) && this.store.operations(c.id).length)) throw new AppError('部分日历已无法在服务器发现，其待同步修改仍保留在本地，请检查日历权限或地址');
      // Missing calendars are kept for offline access. Never purge unsent edits.
      for (const calendar of this.store.calendars().filter(c => c.accountId === id && urls.has(c.url))) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        for (const op of this.store.operations(calendar.id)) {
          const resource = this.store.resource(op.resourceId); if (!resource) continue;
          if (calendar.readOnly) throw new AppError('日历当前为只读，本地修改已保留');
          try {
            let nextEtag: string | null = null;
            if (op.kind === 'delete') {
              if (op.baseEtag) await client.delete(resource.url, op.baseEtag);
              else { const remote = await client.get(resource.url); if (remote) { this.store.conflict(resource, remote.ics, remote.etag); continue; } }
            } else {
              nextEtag = await client.put(resource.url, resource.ics, op.baseEtag);
              if (!nextEtag) nextEtag = (await client.get(resource.url))?.etag ?? null;
              // No safe validator means a future write must be a conflict, never
              // an unconditional update. A missing ETag isn't treated as a version.
            }
            this.store.transaction(() => {
              const current = this.store.one<{ version: number }>('SELECT version FROM pending_operations WHERE id=?', op.id);
              if (current?.version === op.version) {
                this.store.run('DELETE FROM pending_operations WHERE id=?', op.id);
                if (op.kind === 'delete') this.store.run('DELETE FROM event_resources WHERE id=?', resource.id);
                else this.store.run('UPDATE event_resources SET etag=?,dirty=0 WHERE id=?', nextEtag, resource.id);
              } else if (current) {
                this.store.run('UPDATE pending_operations SET baseEtag=? WHERE id=?', nextEtag, op.id);
                this.store.run('UPDATE event_resources SET etag=? WHERE id=?', nextEtag, resource.id);
              }
            });
          } catch (e) {
            if (e instanceof AppError && e.status === 412) { const remote = await client.get(resource.url); this.store.conflict(this.store.resource(resource.id)!, remote?.ics ?? null, remote?.etag ?? null); }
            else { this.store.run('UPDATE pending_operations SET attempts=attempts+1,error=? WHERE id=?', errorMessage(e), op.id); throw e; }
          }
        }
        const token = this.store.one<{ token: string | null }>('SELECT token FROM sync_state WHERE calendarId=?', calendar.id)?.token ?? null;
        const pull = await client.pull(calendar, token);
        this.store.transaction(() => {
          const seen = new Set(pull.objects.filter(o => !o.deleted).map(o => o.url));
          for (const remote of pull.objects) {
            const local = this.store.one<Resource>('SELECT * FROM event_resources WHERE calendarId=? AND url=?', calendar.id, remote.url);
            if (local?.dirty) {
              // A write during REPORT must remain dirty. Compare against its base
              // version, not merely against the snapshot from the start of sync.
              if (local.etag !== remote.etag) this.store.conflict(local, remote.ics, remote.etag);
              continue;
            }
            if (remote.deleted) { if (local) this.store.run('DELETE FROM event_resources WHERE id=?', local.id); continue; }
            if (!remote.ics) throw new AppError('远程日程数据为空，已取消缓存事务');
            this.store.run('INSERT INTO event_resources VALUES(?,?,?,?,?,0,0) ON CONFLICT(calendarId,url) DO UPDATE SET etag=excluded.etag,ics=excluded.ics,dirty=0,deleted=0', local?.id ?? randomUUID(), calendar.id, remote.url, remote.etag, remote.ics);
          }
          if (pull.full) for (const local of this.store.resources(calendar.id)) {
            if (!seen.has(local.url)) {
              if (!local.dirty) this.store.run('DELETE FROM event_resources WHERE id=?', local.id);
              else if (local.etag) this.store.conflict(local, null, null);
            }
          }
          this.store.run('INSERT INTO sync_state VALUES(?,?,?) ON CONFLICT(calendarId) DO UPDATE SET token=excluded.token,lastSync=excluded.lastSync', calendar.id, pull.token, new Date().toISOString());
        });
        this.changed();
      }
      this.store.run('UPDATE accounts SET lastSync=?,error=NULL WHERE id=?', new Date().toISOString(), id);
    } catch (e) { this.store.run('UPDATE accounts SET error=? WHERE id=?', errorMessage(e), id); throw e; }
  }
}
