import { randomUUID } from 'node:crypto';
import { DateTime } from 'luxon';
import { Store, type Resource } from '../database/store';
import { Vault } from '../security/vault';
import { SyncEngine } from '../caldav/sync';
import { DavClient, normalizeUrl } from '../caldav/client';
import { copyWithNewUid, editCalendar, editorInput, excludeInstance, expandResource } from '../ical/events';
import { accountInput, eventInput, settingsSchema, type AccountInput, type CalendarEvent, type EventInput, type Settings, type Snapshot } from '../shared/contracts';
import { AppError } from '../shared/errors';

export class CalendarService {
  readonly syncEngine: SyncEngine;
  private diagnostics = new Set<string>();
  constructor(readonly store: Store, private vault: Vault, readonly changed: () => void) { this.syncEngine = new SyncEngine(store, vault, changed); }
  snapshot(): Snapshot {
    return { accounts: this.store.accounts(), calendars: this.store.calendars(), settings: this.store.settings(), pending: this.store.pending(), conflicts: this.store.conflicts(), syncing: this.syncEngine.active(), bytes: this.store.one<{ bytes: number }>('SELECT COALESCE(SUM(length(ics)),0) bytes FROM event_resources')!.bytes, resources: this.store.resources().length, diagnostics: [...this.diagnostics] };
  }
  events(start: string, end: string, includeHidden = false): CalendarEvent[] {
    if (!Number.isFinite(Date.parse(start)) || !Number.isFinite(Date.parse(end)) || Date.parse(end) <= Date.parse(start) || Date.parse(end) - Date.parse(start) > 370 * 86400000) throw new AppError('查询日期范围无效，单次最多一年');
    const calendars = new Set(this.store.calendars().filter(c => includeHidden || c.visible).map(c => c.id));
    const conflicts = new Set(this.store.conflicts().map(c => c.resourceId)), items: CalendarEvent[] = [];
    this.diagnostics.clear();
    for (const r of this.store.resources().filter(r => calendars.has(r.calendarId))) {
      try { items.push(...expandResource(r, start, end, this.store.settings().timezone, conflicts.has(r.id))); }
      catch (e) { this.diagnostics.add(e instanceof AppError ? e.message : '部分远程 ICS 事件无法解析；完整原始资源已保留在本地'); }
    }
    return items.sort((a, b) => a.start.localeCompare(b.start));
  }
  private async connection(input: AccountInput) {
    const parsed = accountInput.parse(input), url = normalizeUrl(parsed.url, parsed.allowHttp);
    const existing = parsed.id ? this.store.account(parsed.id) : undefined;
    const password = parsed.password || (existing ? await this.vault.open(existing.password) : '');
    if (!password) throw new AppError('请输入密码或应用专用密码');
    return { ...parsed, url, password };
  }
  async testAccount(input: AccountInput) { return new DavClient(await this.connection(input)).discover(input.id); }
  async saveAccount(raw: AccountInput) {
    const input = await this.connection(raw), id = input.id ?? randomUUID(), existing = this.store.account(id);
    if (existing && (existing.url !== input.url || existing.username !== input.username)) throw new AppError('服务器地址或用户名变更请添加新账户，防止混淆现有日程与离线修改');
    if (this.syncEngine.active().includes(id)) throw new AppError('账户正在同步，请完成或取消同步后修改');
    const calendars = existing ? [] : await new DavClient(input).discover(id);
    const encrypted = await this.vault.seal(input.password);
    this.store.transaction(() => {
      this.store.run('INSERT INTO accounts(id,name,url,username,password,allowHttp,paused) VALUES(?,?,?,?,?,?,?) ON CONFLICT(id) DO UPDATE SET name=excluded.name,password=excluded.password,allowHttp=excluded.allowHttp,paused=excluded.paused,error=NULL', id, input.name, input.url, input.username, encrypted, +input.allowHttp, +input.paused);
      for (const c of calendars) this.store.upsertCalendar(c);
    });
    this.changed(); return id;
  }
  async deleteAccount(id: string) { await this.syncEngine.cancel(); this.store.transaction(() => { this.store.run('DELETE FROM accounts WHERE id=?', id); const settings = this.store.settings(); if (settings.defaultCalendar && !this.store.calendars().some(c => c.id === settings.defaultCalendar)) this.store.setSettings({ ...settings, defaultCalendar: '' }); }); this.changed(); }
  async sync(id?: string) { let error: unknown; for (const a of this.store.accounts().filter(a => !a.paused && (!id || a.id === id))) { try { await this.syncEngine.sync(a.id); } catch (e) { error ??= e; } } if (error) throw error; }
  private writable(calendarId: string) {
    const calendar = this.store.calendars().find(c => c.id === calendarId);
    if (!calendar) throw new AppError('请选择有效日历');
    if (calendar.readOnly) throw new AppError('此日历为只读，无法修改');
    return calendar;
  }
  eventDetail(resourceId: string, scope: 'series' | 'instance', recurrenceId?: string) {
    const r = this.store.resource(resourceId); if (!r) throw new AppError('日程已移除，请刷新');
    return editorInput(r, scope, recurrenceId, this.store.settings().timezone);
  }
  saveEvent(raw: EventInput) {
    const input = eventInput.parse(raw), calendar = this.writable(input.calendarId);
    const existing = input.resourceId ? this.store.resource(input.resourceId) : undefined;
    if (input.resourceId && !existing) throw new AppError('日程已移除，请刷新');
    if (existing && existing.calendarId !== input.calendarId) throw new AppError('现有日程暂不支持跨日历移动，请新建副本');
    if (existing?.deleted) throw new AppError('此日程已标记删除，请先同步或处理冲突');
    const ics = editCalendar(input, existing?.ics), id = existing?.id ?? randomUUID();
    const resource: Resource = existing ?? { id, calendarId: calendar.id, url: `${calendar.url.replace(/\/?$/, '/')}${id}.ics`, etag: null, ics, dirty: 1, deleted: 0 };
    this.store.queue({ ...resource, ics }, 'put'); this.changed();
  }
  deleteEvent(resourceId: string, scope: 'series' | 'instance', recurrenceId?: string) {
    const r = this.store.resource(resourceId); if (!r) throw new AppError('找不到此日程'); this.writable(r.calendarId);
    if (scope === 'instance') { if (!recurrenceId) throw new AppError('请选择重复实例'); this.store.queue({ ...r, ics: excludeInstance(r.ics, recurrenceId) }, 'put'); }
    else this.store.queue(r, 'delete');
    this.changed();
  }
  setSettings(raw: Settings) {
    const s = settingsSchema.parse(raw);
    if (!DateTime.now().setZone(s.timezone).isValid) throw new AppError('时区无效，请使用 Asia/Shanghai 等 IANA 时区名称');
    if (s.defaultCalendar && !this.store.calendars().some(c => c.id === s.defaultCalendar && !c.readOnly)) throw new AppError('默认日历不存在或为只读');
    this.store.setSettings(s); this.changed();
  }
  resolveConflict(id: string, choice: 'local' | 'remote' | 'both') {
    const c = this.store.conflicts().find(c => c.id === id); if (!c) throw new AppError('冲突已处理');
    const r = this.store.resource(c.resourceId); if (!r) throw new AppError('冲突资源不存在');
    if (this.syncEngine.active().length) throw new AppError('请等待同步完成后处理冲突');
    const operation = this.store.one<{ kind: string }>('SELECT kind FROM pending_operations WHERE resourceId=?', r.id);
    this.store.transaction(() => {
      if (choice === 'both') {
        const uuid = randomUUID(), calendar = this.writable(r.calendarId);
        const copy: Resource = { ...r, id: uuid, url: `${calendar.url.replace(/\/?$/, '/')}${uuid}.ics`, etag: null, ics: copyWithNewUid(c.localIcs), dirty: 1, deleted: 0 };
        this.store.run('INSERT INTO event_resources VALUES(?,?,?,?,?,1,0)', copy.id, copy.calendarId, copy.url, null, copy.ics);
        this.store.run('INSERT INTO pending_operations(id,resourceId,kind,baseEtag) VALUES(?,?,?,NULL)', randomUUID(), copy.id, 'put');
      }
      this.store.run('DELETE FROM conflicts WHERE id=?', id);
      this.store.run('DELETE FROM pending_operations WHERE resourceId=?', r.id);
      if (choice === 'local') {
        if (c.remoteIcs && !c.remoteEtag) throw new AppError('服务器未提供 ETag，无法安全覆盖；请选择保留双方或使用服务器版本');
        this.store.run('UPDATE event_resources SET etag=?,dirty=1,ics=? WHERE id=?', c.remoteEtag, c.localIcs, r.id);
        if (operation?.kind === 'delete' && !c.remoteIcs) this.store.run('DELETE FROM event_resources WHERE id=?', r.id);
        else this.store.run('INSERT INTO pending_operations(id,resourceId,kind,baseEtag) VALUES(?,?,?,?)', randomUUID(), r.id, operation?.kind ?? 'put', c.remoteEtag);
      } else if (!c.remoteIcs) this.store.run('DELETE FROM event_resources WHERE id=?', r.id);
      else this.store.run('UPDATE event_resources SET ics=?,etag=?,dirty=0,deleted=0 WHERE id=?', c.remoteIcs, c.remoteEtag, r.id);
    });
    this.changed();
  }
}
