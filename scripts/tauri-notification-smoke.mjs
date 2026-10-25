import { chromium } from 'playwright';
import { build } from 'esbuild';
import { spawn, execFileSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { mkdir } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url), data = resolve('.smoke-data',`notifications-${Date.now()}`);
await mkdir(data,{ recursive:true });
const executable = resolve(process.env.SHIXU_TAURI_TEST_EXE || 'src-tauri/target/release/shixu-calendar.exe');
const fixturePath = resolve('.smoke-data/notification-dav.cjs');
await build({ entryPoints:['tests/dav-server.ts'],outfile:fixturePath,bundle:true,platform:'node',format:'cjs' });
const { davServer } = require(fixturePath), fixture = await davServer();
const nativeSource = `using System; using System.Collections.Generic; using System.Runtime.InteropServices; using System.Text;
public static class NoticeWin {
 public delegate bool EnumProc(IntPtr h, IntPtr p);
 [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left,Top,Right,Bottom; }
 [StructLayout(LayoutKind.Sequential)] public struct Info { public int Size; public Rect Monitor,Work; public uint Flags; }
 public class Entry { public long Handle; public string Title; public bool Visible; public long Style; public uint Dpi; public Rect Bounds,Work; }
 public class Sample { public long Ms; public int Y; }
 [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
 [DllImport("user32.dll")] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
 [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr h,uint m,IntPtr w,IntPtr l);
 [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback,IntPtr data);
 [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h,out uint pid);
 [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr h,StringBuilder s,int length);
 [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
 [DllImport("user32.dll")] static extern IntPtr GetWindowLongPtr(IntPtr h,int index);
 [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr h);
 [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h,out Rect r);
 [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h,uint flags);
 [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr h,ref Info info);
 public static Entry[] Windows(uint target) {
  SetThreadDpiAwarenessContext(new IntPtr(-4)); var list=new List<Entry>(); EnumWindows((h,p)=>{uint pid; GetWindowThreadProcessId(h,out pid); if(pid!=target)return true;
   var title=new StringBuilder(512); GetWindowText(h,title,512); Rect r;GetWindowRect(h,out r);var info=new Info();info.Size=Marshal.SizeOf(typeof(Info));GetMonitorInfo(MonitorFromWindow(h,2),ref info);
   list.Add(new Entry{Handle=h.ToInt64(),Title=title.ToString(),Visible=IsWindowVisible(h),Style=GetWindowLongPtr(h,-20).ToInt64(),Dpi=GetDpiForWindow(h),Bounds=r,Work=info.Work});return true;},IntPtr.Zero);return list.ToArray();
 }
 public static Sample[] CloseAndTrack(long close,long follow) {
  SetThreadDpiAwarenessContext(new IntPtr(-4)); var samples=new List<Sample>(); var watch=System.Diagnostics.Stopwatch.StartNew();
  Rect r; if(!GetWindowRect(new IntPtr(follow),out r))throw new Exception("Follow window disappeared before motion sampling"); samples.Add(new Sample{Ms=0,Y=r.Top});
  PostMessage(new IntPtr(close),16,IntPtr.Zero,IntPtr.Zero);
  while(watch.ElapsedMilliseconds<700){ GetWindowRect(new IntPtr(follow),out r); samples.Add(new Sample{Ms=watch.ElapsedMilliseconds,Y=r.Top}); System.Threading.Thread.Sleep(10); }
  return samples.ToArray();
 }
}`;
const native = command => execFileSync('powershell.exe',['-NoProfile','-Command',`Add-Type -TypeDefinition @'\n${nativeSource}\n'@\n${command}`],{ encoding:'utf8' }).trim();
let app, browser, main;
const inspect = () => JSON.parse(native(`[pscustomobject]@{ Foreground=[NoticeWin]::GetForegroundWindow().ToInt64(); Windows=@([NoticeWin]::Windows(${app.pid})) } | ConvertTo-Json -Depth 5 -Compress`));
const toastPages = () => browser.contexts().flatMap(context => context.pages()).filter(page => page.url().includes('?notification='));
async function until(check,message,timeout = 15000) {
  const end = Date.now()+timeout;
  while(Date.now()<end) { try { const value=await check(); if(value)return value; } catch {} await new Promise(resolve=>setTimeout(resolve,200)); }
  throw new Error(message);
}
async function launch() {
  app=spawn(executable,[],{ env:{ ...process.env,SHIXU_TAURI_TEST_DATA_DIR:data,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9235' },stdio:'ignore' });
  browser=await until(async()=>{try{return await chromium.connectOverCDP('http://127.0.0.1:9235');}catch{}},'Notification preview did not start');
  main=await until(()=>browser.contexts().flatMap(c=>c.pages()).find(p=>p.url().startsWith('http://tauri.localhost/')&&!p.url().includes('notification=')),'Main page missing');
  await main.locator('.month-grid').waitFor();
  if((await main.evaluate(()=>window.shixu.desktopState())).mode!=='development')throw new Error('Run notification smoke only with the isolated development preview');
}
const ipc=(method,args=[])=>main.evaluate(async({method,args})=>{
  const result=await window.__TAURI_INTERNALS__.invoke('shixu_call',{method,args});if(!result.ok)throw new Error(result.error);return result.value;
},{method,args});
const send=(key,title,event,body='10:00 会议室')=>ipc('notifyReminder',[key,title,body,...(event?[event]:[])]);
async function findToast(title,timeout=15000) {
  return until(async()=>{for(const page of toastPages()){if(await page.locator('.reminder-toast h1').textContent({timeout:400})===title)return page;}},`Toast missing: ${title}`,timeout);
}
async function closeAll() {
  for(const page of toastPages())await page.getByRole('button',{name:'关闭提醒',exact:true}).click().catch(()=>{});
  await until(()=>toastPages().length===0,'Toast windows were not released');
}
async function quit() {
  const exited=new Promise(resolve=>app.once('exit',resolve));
  await main.evaluate(()=>window.shixu.quitApp()).catch(()=>{});await Promise.race([exited,new Promise((_,reject)=>setTimeout(()=>reject(new Error('App did not quit')),6000))]);
  await browser.close().catch(()=>{});browser=undefined;
}
try {
  await launch();
  await main.getByRole('button',{name:'设置',exact:true}).click();
  await main.getByRole('button',{name:'启动与后台',exact:true}).click();
  if(!(await main.getByRole('radio',{name:'系统通知',exact:true}).isChecked()))throw new Error('Legacy default should remain system notifications');
  await main.getByRole('radio',{name:'macOS 风格悬浮通知',exact:true}).click();
  await until(async()=>(await main.evaluate(()=>window.shixu.snapshot())).settings.notificationMode==='floating','Notification mode did not persist');
  const monitors=await main.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:window|available_monitors',{label:'main'}));console.log(`Available monitors: ${monitors.length}`);
  const before=inspect().Foreground;
  await main.getByRole('button',{name:'测试通知',exact:true}).click();
  const first=await findToast('测试日程提醒');
  const focusAfter=inspect(); if(focusAfter.Foreground!==before)throw new Error(`Notification focus mismatch: ${JSON.stringify({before,after:focusAfter.Foreground,windows:focusAfter.Windows})}`);
  const primary=await main.evaluate(()=>window.__TAURI_INTERNALS__.invoke('plugin:window|primary_monitor',{label:'main'}));
  const frame=focusAfter.Windows.find(window=>window.Visible&&window.Title.includes('日程提醒'));
  if(!frame||frame.Bounds.Top!==primary.workArea.position.y||frame.Bounds.Right!==primary.workArea.position.x+primary.workArea.size.width)throw new Error(`Notification not anchored at primary work area edge: ${JSON.stringify({frame,primary})}`);
  const weights=await first.locator('.reminder-toast').evaluate(element=>[element.querySelector('h1'),element.querySelector('p'),element.querySelector('footer button')].map(node=>Number(getComputedStyle(node).fontWeight)));
  if(weights.some(weight=>weight<650))throw new Error(`Reminder typography is not bold: ${weights}`);
  if(await first.evaluate(()=>typeof window.shixu)!=='undefined')throw new Error('Notification booted the main app API/scheduler');
  const denied=await first.evaluate(async()=>{try{await window.__TAURI_INTERNALS__.invoke('shixu_call',{method:'snapshot',args:[{}]});return false;}catch{return true;}});
  if(!denied)throw new Error('Notification window can access main calendar IPC');
  const fit=await first.locator('.reminder-toast').evaluate(el=>({height:el.getBoundingClientRect().height,window:innerHeight}));
  if(Math.abs(fit.window-fit.height-8)>1||fit.window>=166)throw new Error(`Short notification kept blank fixed height: ${JSON.stringify(fit)}`);
  await first.screenshot({path:'.smoke-data/notification-light.png'});
  await main.evaluate(async()=>{const state=await window.shixu.snapshot();await window.shixu.settings({...state.settings,theme:'dark'});});
  await until(async()=>await first.evaluate(()=>document.documentElement.dataset.theme)==='dark','Existing toast did not update theme');
  await main.evaluate(async()=>{const state=await window.shixu.snapshot();await window.shixu.settings({...state.settings,theme:'light'});});
  await until(async()=>await first.evaluate(()=>document.documentElement.dataset.theme)==='light','Toast light theme did not restore');
  await first.getByRole('button',{name:'关闭提醒',exact:true}).click();await until(()=>toastPages().length===0,'Test notification did not release its window');
  await main.getByRole('button',{name:'关闭面板',exact:true}).click();
  const key=`dedupe-${Date.now()}`;if(!(await send(key,'去重检查'))||await send(key,'去重检查'))throw new Error('Existing reminder claim no longer deduplicates');
  await findToast('去重检查');await closeAll();
  await send(`short-${Date.now()}`,'短内容');const short=await findToast('短内容');
  const longTitle='较长的日程标题需要自动换行，并让窗口根据标题和正文调整高度';
  await send(`long-${Date.now()}`,longTitle,undefined,'详细会议地点和日程安排说明。'.repeat(20));const long=await findToast(longTitle);
  const shortHeight=await short.evaluate(()=>innerHeight),longHeight=await long.evaluate(()=>innerHeight);
  if(longHeight<=shortHeight||longHeight>260)throw new Error(`Notification height did not adapt: ${shortHeight}/${longHeight}`);
  const adaptive=inspect().Windows.filter(w=>w.Visible&&w.Title==='时序日历 · 日程提醒').sort((a,b)=>a.Bounds.Top-b.Bounds.Top);
  if(adaptive.length!==2||adaptive[1].Bounds.Top<adaptive[0].Bounds.Bottom)throw new Error('Variable-height notification stack overlaps');
  await long.screenshot({path:'.smoke-data/notification-adaptive.png'});await closeAll();
  for(let i=0;i<4;i++)await send(`stack-${Date.now()}-${i}`,`堆叠提醒 ${i+1}`);
  await until(()=>toastPages().length>=2,'Notifications did not stack');await new Promise(resolve=>setTimeout(resolve,800));
  for(const page of toastPages())await page.evaluate(async()=>{
    const pause=()=>window.__TAURI_INTERNALS__.invoke('notification_call',{method:'hover',paused:true}).catch(()=>{});
    await pause();setInterval(pause,1000);
  });
  const stackState=inspect();
  const visible=stackState.Windows.filter(w=>w.Visible&&w.Title==='时序日历 · 日程提醒').sort((a,b)=>a.Bounds.Top-b.Bounds.Top);
  if(visible.length<2||visible.length>3)throw new Error('Incorrect visible notification stack size');
  if(stackState.Windows.some(w=>w.Handle===stackState.Foreground&&w.Title==='时序日历 · 日程提醒'))throw new Error('Stacked notification took focus');
  for(let i=0;i<visible.length;i++){
    const {Bounds:r,Work:w,Style:style,Dpi:dpi}=visible[i];
    if(r.Left<w.Left||r.Top<w.Top||r.Right>w.Right||r.Bottom>w.Bottom)throw new Error('Notification crossed work area/taskbar boundary');
    if(i&&Math.abs(r.Top-visible[i-1].Bounds.Bottom)>2)throw new Error('Notification stack kept excessive gap or overlaps');
    if(!(style&8)||!(style&0x08000000))throw new Error('Notification is not topmost/non-activating');
    if(Math.abs((r.Right-r.Left)-384*dpi/96)>3)throw new Error('Native notification size does not follow monitor DPI');
  }
  console.log(`Verified native stack: ${visible.length} windows, DPI ${visible.map(w=>w.Dpi).join(',')}`);
  await main.evaluate(async()=>{const state=await window.shixu.snapshot();await window.shixu.settings({...state.settings,closeToTray:false});});
  const samples=JSON.parse(native(`[NoticeWin]::CloseAndTrack(${visible[0].Handle},${visible[1].Handle}) | ConvertTo-Json -Compress`));
  const startY=visible[1].Bounds.Top,targetY=visible[0].Bounds.Top;
  const intermediate=new Set(samples.filter(sample=>sample.Y>targetY&&sample.Y<startY).map(sample=>sample.Y));
  const finished=samples.find(sample=>Math.abs(sample.Y-targetY)<=1);
  if(intermediate.size<4||!finished||finished.Ms>500)throw new Error(`Stack did not promptly/smoothly fill slot: ${JSON.stringify({intermediate:[...intermediate],finished,samples})}`);
  if(samples.some((sample,index)=>index&&sample.Y>samples[index-1].Y+1))throw new Error('Stack refill jittered backwards');
  console.log(`Verified immediate animated refill: ${intermediate.size} intermediate positions, settled ${finished.Ms}ms after close`);
  await until(()=>app.exitCode===null&&toastPages().length<=3,'Closing notification affected application lifecycle');
  await until(async()=>{for(const page of toastPages())if((await page.locator('h1').textContent({timeout:200}))==='堆叠提醒 4')return true;},'Queued notification did not fill released slot');
  await closeAll();
  await main.evaluate(async()=>{const state=await window.shixu.snapshot();await window.shixu.settings({...state.settings,theme:'dark'});});
  await send(`hover-${Date.now()}`,'悬停暂停检查');const hover=await findToast('悬停暂停检查');
  await hover.locator('.reminder-toast').hover();await new Promise(resolve=>setTimeout(resolve,12000));
  if(hover.isClosed()||!(await hover.locator('.reminder-toast').isVisible()))throw new Error('Hovered notification expired');
  if(await hover.evaluate(()=>document.documentElement.dataset.theme)!=='dark')throw new Error('Toast did not follow dark preference');
  await hover.screenshot({path:'.smoke-data/notification-dark.png'});
  await hover.mouse.move(0,0);await until(()=>hover.isClosed(),'Notification did not expire after pointer left',15000);
  const reference=await main.evaluate(async account=>{
    const id=await window.shixu.saveAccount(account);await window.shixu.sync(id);const state=await window.shixu.snapshot();
    await window.shixu.settings({...state.settings,closeToTray:true,silentStartup:true,autoSync:false,autoUpdateCheck:false,theme:'light',notificationMode:'floating'});
    const start=new Date(Date.now()+60000),end=new Date(start.getTime()+3600000),calendar=state.calendars.find(c=>c.accountId===id);
    await window.shixu.saveEvent({calendarId:calendar.id,title:'悬浮提醒业务测试',start:start.toISOString(),end:end.toISOString(),allDay:false,timezone:'Asia/Shanghai',location:'测试会议室',description:'',rrule:'',reminder:1,scope:'series'});
    return (await window.shixu.events(new Date(Date.now()-86400000).toISOString(),new Date(Date.now()+86400000).toISOString())).find(e=>e.title==='悬浮提醒业务测试');
  },fixture.account);
  await main.getByRole('button',{name:'关闭窗口',exact:true}).click();
  const scheduled=await findToast('悬浮提醒业务测试',45000);
  await scheduled.getByRole('button',{name:'稍后提醒',exact:true}).click();await until(()=>toastPages().length===0,'Snoozed window not released');
  const db=new DatabaseSync(join(data,'calendar.db'));
  const snooze=db.prepare("SELECT key,dueAt,deliveredAt FROM reminder_deliveries WHERE key LIKE 'snooze:%'").get();
  if(!snooze||snooze.deliveredAt!==null||snooze.dueAt<Date.now()+590000)throw new Error('Snooze was not durably scheduled for ten minutes');
  db.close();
  const movedDate=await main.evaluate(async reference=>{
    const input=await window.shixu.eventDetail(reference.resourceId,'series');
    const start=new Date(Date.parse(reference.start)+86400000),end=new Date(start.getTime()+3600000);
    await window.shixu.saveEvent({...input,start:start.toISOString(),end:end.toISOString()});
    return new Date(start.getTime()+8*3600000).toISOString().slice(0,10);
  },reference);
  await quit();
  const restoreDb=new DatabaseSync(join(data,'calendar.db'));restoreDb.prepare('UPDATE reminder_deliveries SET dueAt=? WHERE key=?').run(Date.now()-1000,snooze.key);restoreDb.close();
  await launch();const restored=await findToast('悬浮提醒业务测试');
  await restored.getByRole('button',{name:'打开日程',exact:true}).click();
  await main.getByRole('textbox',{name:'日程标题',exact:true}).waitFor();
  if(await main.getByRole('textbox',{name:'日程标题',exact:true}).inputValue()!=='悬浮提醒业务测试')throw new Error('Notification click did not open the corresponding event');
  if(await main.getByRole('button',{name:'开始日期',exact:true}).getAttribute('data-date')!==movedDate)throw new Error('Reminder click did not follow the event after it moved');
  await main.getByRole('textbox',{name:'日程标题',exact:true}).fill('未保存草稿保护');
  const guardTarget=await main.evaluate(async calendarId=>{
    const start=new Date(Date.now()+3600000),end=new Date(start.getTime()+3600000);
    await window.shixu.saveEvent({calendarId,title:'另一个提醒目标',start:start.toISOString(),end:end.toISOString(),allDay:false,timezone:'Asia/Shanghai',location:'',description:'',rrule:'',reminder:-1,scope:'series'});
    return (await window.shixu.events(new Date(Date.now()-86400000).toISOString(),new Date(Date.now()+86400000).toISOString())).find(event=>event.title==='另一个提醒目标');
  },reference.calendarId);
  await send(`guard-${Date.now()}`,'提醒不应覆盖草稿',{resourceId:guardTarget.resourceId,recurrenceId:guardTarget.recurrenceId,start:guardTarget.start,allDay:guardTarget.allDay});
  const guarded=await findToast('提醒不应覆盖草稿');
  main.once('dialog',dialog=>void dialog.dismiss());
  await guarded.getByRole('button',{name:'打开日程',exact:true}).click();
  await new Promise(resolve=>setTimeout(resolve,400));
  if(await main.getByRole('textbox',{name:'日程标题',exact:true}).inputValue()!=='未保存草稿保护')throw new Error('Notification discarded unsaved edits without confirmation');
  main.once('dialog',dialog=>void dialog.accept());
  await main.getByRole('button',{name:'取消',exact:true}).click();
  const finalDb=new DatabaseSync(join(data,'calendar.db'));const saved=JSON.parse(finalDb.prepare('SELECT payload FROM reminder_deliveries WHERE key=?').get(snooze.key).payload);
  if(saved.event.resourceId!==reference.resourceId)throw new Error('Reminder event identity changed across snooze/restart');finalDb.close();
  await main.evaluate(async()=>{const state=await window.shixu.snapshot();await window.shixu.settings({...state.settings,notificationMode:'system'});await window.shixu.testNotification();});
  await new Promise(resolve=>setTimeout(resolve,700));if(toastPages().length)throw new Error('System mode still creates floating windows');
  const systemDb=new DatabaseSync(join(data,'calendar.db'));
  const systemDelivery=systemDb.prepare('SELECT deliveredAt FROM reminder_deliveries ORDER BY rowid DESC LIMIT 1').get();systemDb.close();
  if(!systemDelivery?.deliveredAt)throw new Error('System notification plugin did not accept the test notice');
  console.log('PASS: native no-focus/topmost/DPI/work area, stack queue, IPC isolation, WM_CLOSE, hover pause, timer release, existing background scheduler, durable snooze/restart and exact event opening');
  await quit();
} finally {
  await browser?.close().catch(()=>{});if(app?.exitCode===null)app.kill();await fixture.close();
}
