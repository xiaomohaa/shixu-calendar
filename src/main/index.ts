import { app, BrowserWindow, ipcMain, safeStorage, dialog, Menu, Notification, nativeTheme } from 'electron';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { z } from 'zod';
import { Store } from '../database/store';
import { Vault } from '../security/vault';
import { CalendarService } from './service';
import { AppError, errorMessage } from '../shared/errors';
import { accountInput, eventInput, settingsSchema } from '../shared/contracts';
import { DateTime } from 'luxon';
import { getCACertificates, setDefaultCACertificates } from 'node:tls';

if (process.env.SHIXU_DATA_DIR) { mkdirSync(process.env.SHIXU_DATA_DIR, { recursive: true }); app.setPath('userData', process.env.SHIXU_DATA_DIR); }
app.setName('时序日历');
app.setAppUserModelId('cn.shixu.calendar');
let window: BrowserWindow | null = null;
let store: Store, service: CalendarService;
let shuttingDown = false;
const changed = () => window?.webContents.send('shixu:changed');
const idSchema = z.string().min(1).max(200);

async function main() {
  // Node fetch otherwise uses bundled roots only. Honor the user's Windows
  // certificate trust decisions without disabling TLS verification.
  setDefaultCACertificates([...new Set([...getCACertificates('default'), ...getCACertificates('system')])]);
  store = new Store(join(app.getPath('userData'), 'calendar.db'));
  nativeTheme.themeSource = store.settings().theme;
  const vault = new Vault({ available: () => safeStorage.isAsyncEncryptionAvailable(), encrypt: text => safeStorage.encryptStringAsync(text), decrypt: async data => (await safeStorage.decryptStringAsync(data)).result });
  service = new CalendarService(store, vault, changed);
  window = new BrowserWindow({ width: 1380, height: 900, minWidth: 1000, minHeight: 680, title: '时序日历', backgroundColor: '#f8f7f5', icon: join(__dirname, '../build/icon.ico'),
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true, spellcheck: false } });
  Menu.setApplicationMenu(null);
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.webContents.session.setPermissionRequestHandler((_wc, _permission, callback) => callback(false));
  const devUrl = !app.isPackaged && process.env.VITE_DEV_SERVER_URL === 'http://127.0.0.1:5173' ? process.env.VITE_DEV_SERVER_URL : undefined;
  const trusted = (url: string) => devUrl ? url.startsWith(`${devUrl}/`) || url === devUrl : url === pathToFileURL(join(__dirname, '../dist/index.html')).href;
  ipcMain.handle('shixu:call', async (event, method: unknown, raw: unknown) => {
    try {
      if (event.sender !== window?.webContents || event.senderFrame !== event.sender.mainFrame || !trusted(event.senderFrame.url)) throw new AppError('请求来源不受信任');
      const a = z.array(z.unknown()).max(4).parse(raw);
      let value: unknown;
      switch (method) {
        case 'snapshot': value = service.snapshot(); break;
        case 'events': value = service.events(z.string().parse(a[0]), z.string().parse(a[1])); break;
        case 'eventDetail': value = service.eventDetail(idSchema.parse(a[0]), z.enum(['series', 'instance']).parse(a[1]), z.string().optional().parse(a[2])); break;
        case 'testAccount': value = await service.testAccount(accountInput.parse(a[0])); break;
        case 'saveAccount': value = await service.saveAccount(accountInput.parse(a[0])); break;
        case 'deleteAccount': {
          const id = idSchema.parse(a[0]); const response = await dialog.showMessageBox(window!, { type: 'warning', title: '删除账户', message: '删除此账户及其本地缓存？', detail: '本地未同步修改也将删除。远程服务器上的日历和日程不会被删除。', buttons: ['取消', '删除本地账户'], defaultId: 0, cancelId: 0 });
          if (response.response === 1) await service.deleteAccount(id); break;
        }
        case 'sync': await service.sync(z.string().optional().parse(a[0])); break;
        case 'cancelSync': await service.syncEngine.cancel(); break;
        case 'saveEvent': service.saveEvent(eventInput.parse(a[0])); break;
        case 'deleteEvent': service.deleteEvent(idSchema.parse(a[0]), z.enum(['series', 'instance']).parse(a[1]), z.string().optional().parse(a[2])); break;
        case 'settings': service.setSettings(settingsSchema.parse(a[0])); nativeTheme.themeSource = store.settings().theme === 'system' ? 'system' : store.settings().theme; break;
        case 'setCalendar': store.run('UPDATE calendars SET visible=?,color=? WHERE id=?', +z.boolean().parse(a[1]), z.string().regex(/^#[\da-f]{6}$/i).parse(a[2]), idSchema.parse(a[0])); changed(); break;
        case 'resolveConflict': service.resolveConflict(idSchema.parse(a[0]), z.enum(['local', 'remote', 'both']).parse(a[1])); break;
        case 'clearCache': {
          if (service.syncEngine.active().length) throw new AppError('请等待同步完成或取消后再清除缓存');
          const response = await dialog.showMessageBox(window!, { type: 'question', message: '清除已同步的本地缓存？', detail: '未同步修改和冲突会保留。下次同步将重新下载日程。', buttons: ['取消', '清除缓存'], defaultId: 0, cancelId: 0 });
          if (response.response === 1) { store.clearCache(); changed(); } break;
        }
        case 'backup': {
          const target = await dialog.showSaveDialog(window!, { title: '备份日历偏好', defaultPath: '时序设置.json', filters: [{ name: 'JSON 设置', extensions: ['json'] }] });
          value = !target.canceled; if (target.filePath) writeFileSync(target.filePath, JSON.stringify({ format: 'shixu-settings-v1', settings: store.settings() }, null, 2), { encoding: 'utf8', mode: 0o600 }); break;
        }
        case 'restore': {
          const target = await dialog.showOpenDialog(window!, { title: '恢复日历偏好', filters: [{ name: 'JSON 设置', extensions: ['json'] }], properties: ['openFile'] });
          value = !target.canceled;
          if (target.filePaths[0]) { const data = z.object({ format: z.literal('shixu-settings-v1'), settings: settingsSchema }).parse(JSON.parse(readFileSync(target.filePaths[0], 'utf8'))); service.setSettings({ ...data.settings, defaultCalendar: store.calendars().some(c => c.id === data.settings.defaultCalendar) ? data.settings.defaultCalendar : '' }); } break;
        }
        default: throw new AppError('不支持的操作');
      }
      return { ok: true, value };
    } catch (e) { return { ok: false, error: e instanceof z.ZodError ? e.issues.map(i => i.message).join('；') : errorMessage(e) }; }
  });
  if (devUrl) await window.loadURL(devUrl); else await window.loadFile(join(__dirname, '../dist/index.html'));
  window.on('closed', () => { window = null; });
  let lastAuto = 0;
  const timer = setInterval(() => {
    const settings = store.settings();
    if (settings.autoSync && Date.now() - lastAuto >= settings.interval * 60000) { lastAuto = Date.now(); void service.sync().catch(() => {}); }
    if (Notification.isSupported()) {
      const now = Date.now();
      for (const event of service.events(new Date(now - 86400000).toISOString(), new Date(now + 8 * 86400000).toISOString(), true)) {
        if (event.reminder < 0) continue;
        const time = event.allDay ? DateTime.fromISO(event.start, { zone: settings.timezone }).toMillis() : Date.parse(event.start);
        const due = time - event.reminder * 60000, key = `${event.id}:${event.start}:${event.reminder}`;
        if (due > now || due < now - 60000 || store.one('SELECT key FROM reminders WHERE key=?', key)) continue;
        store.run('INSERT OR IGNORE INTO reminders VALUES(?,?)', key, new Date().toISOString());
        const notification = new Notification({ title: event.title, body: `${event.allDay ? '全天' : DateTime.fromMillis(time).setZone(settings.timezone).toFormat('HH:mm')} ${event.location}`.trim() });
        notification.on('click', () => { window?.show(); window?.focus(); }); notification.show();
      }
      store.run("DELETE FROM reminders WHERE shownAt < datetime('now','-30 days')");
    }
  }, 30000);
  app.on('before-quit', event => {
    if (shuttingDown) return; event.preventDefault(); shuttingDown = true; clearInterval(timer);
    void service.syncEngine.cancel().finally(() => { store.close(); app.quit(); });
  });
}
if (!app.requestSingleInstanceLock()) app.quit();
else { app.on('second-instance', () => { window?.restore(); window?.show(); window?.focus(); }); void app.whenReady().then(main).catch(() => { dialog.showErrorBox('启动失败', '无法打开本地数据库或窗口，请检查数据目录权限和应用版本。'); app.quit(); }); }
app.on('window-all-closed', () => app.quit());
