import { _electron } from 'playwright';
import { createServer } from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join, basename } from 'node:path';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const root=resolve('.smoke-data/install-update-test'), installed=resolve('.smoke-data/installed-lab'); await mkdir(root,{recursive:true});
await build({entryPoints:['tests/dav-server.ts'],outfile:join(root,'dav.cjs'),bundle:true,platform:'node',format:'cjs'});
const { davServer,fixtureIcs }=require(join(root,'dav.cjs')); const dav=await davServer(); dav.put('/home/personal/test.ics',fixtureIcs('隔离升级缓存验收'));
const source=resolve('.smoke-data/install-lab-target'), metadata=await readFile(join(source,'latest.yml'),'utf8');
const files=new Set(['latest.yml','Shixu-Setup-1.2.1-x64.exe','Shixu-Setup-1.2.1-x64.exe.blockmap']);
const server=createServer((req,res)=>{const name=basename(new URL(req.url,'http://local').pathname);if(!files.has(name)){res.writeHead(404);res.end();return;}createReadStream(join(source,name)).pipe(res);});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const feed=`http://127.0.0.1:${server.address().port}/`;
await writeFile(join(installed,'resources/app-update.yml'),`provider: generic\nurl: ${feed}\nupdaterCacheDirName: shixu-calendar-install-lab\n`);
const env={...process.env,SHIXU_DATA_DIR:join(root,`profile-${Date.now()}`)};delete env.ELECTRON_RUN_AS_NODE;
const executablePath=join(installed,'时序日历.exe'),results=[];let electronApp;
const check=(ok,name)=>{if(!ok)throw new Error(name);results.push(name);console.log(`PASS: ${name}`);};
async function launch(args=[]) { electronApp=await _electron.launch({executablePath,args,env,timeout:60000});const page=await electronApp.firstWindow();await page.waitForSelector('.fc');return page; }
try {
  let page=await launch(['--hidden']);
  await electronApp.evaluate(async({app},path)=>{const {createRequire}=process.getBuiltinModule('node:module');const r=createRequire(app.getAppPath()+'/package.json');r('electron-updater').autoUpdater.on('error',e=>r('node:fs').appendFileSync(path,e.stack+'\n'));},join(root,'updater-error.log'));
  check((await page.evaluate(()=>window.shixu.desktopState())).mode==='installer','安装版识别正确');
  check(await electronApp.evaluate(({BrowserWindow})=>!BrowserWindow.getAllWindows()[0].isVisible()),'开机参数 --hidden 启动时隐藏到托盘');
  await electronApp.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0].show();});
  const reg=spawnSync('reg',['query','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run','/v','时序日历'],{encoding:'utf8',windowsHide:true});
  if(reg.status===1) {
    const enabled=await page.evaluate(()=>window.shixu.setAutoStart(true));check(enabled.openAtLogin && enabled.startupEnabled,'安装版真实写入并启用 Windows 登录项');
    const actual=spawnSync('reg',['query','HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run','/v','时序日历'],{encoding:'utf8',windowsHide:true}).stdout;
    check(actual.includes(installed) && actual.includes('--hidden'),'登录项指向安装 EXE 且携带隐藏启动参数');
    check(!(await page.evaluate(()=>window.shixu.setAutoStart(false))).openAtLogin,'取消开机自启后移除登录项');
  } else throw new Error('检测到已有用户登录项，测试未覆盖它');
  const id=await page.evaluate(account=>window.shixu.saveAccount(account),{...dav.account,name:'隔离升级验收',allowHttp:true});await page.evaluate(id=>window.shixu.sync(id),id);
  await page.evaluate(async()=>{const s=await window.shixu.snapshot();await window.shixu.settings({...s.settings,autoSync:false,autoUpdateCheck:false,theme:'dark'});await window.shixu.saveEvent({calendarId:s.calendars[0].id,title:'升级后必须保留的离线修改',start:'2026-10-23T10:00:00',end:'2026-10-23T11:00:00',allDay:false,timezone:'Asia/Shanghai',location:'',description:'fixture-only',rrule:'',reminder:-1,scope:'series'});});
  check((await page.evaluate(()=>window.shixu.snapshot())).pending===1,'安装升级前存在真实未同步队列');
  await page.getByRole('button',{name:'设置',exact:true}).click();await page.getByRole('button',{name:'关于与更新',exact:true}).click();
  await page.getByRole('button',{name:'检查更新',exact:true}).click();await page.evaluate(()=>window.shixu.checkForUpdates());
  check((await page.evaluate(()=>window.shixu.updateState())).release.version==='1.2.1','安装版经实际 IPC 检查发现下一版本');
  await page.getByRole('button',{name:'下载更新',exact:true}).click();
  await page.evaluate(()=>window.shixu.downloadUpdate());
  const downloaded=await page.evaluate(()=>window.shixu.updateState());if(downloaded.phase!=='downloaded') console.log(downloaded,await readFile(join(root,'updater-error.log'),'utf8').catch(()=>''));
  check(downloaded.phase==='downloaded','真实 NSIS 安装包下载并校验完成');
  await page.screenshot({path:join(root,'update-ready.png')});
  // Exercise real quitAndInstall but suppress test auto-relaunch: the next launch
  // explicitly keeps SHIXU_DATA_DIR isolated from the user's production profile.
  await electronApp.evaluate(async({app})=>{const {createRequire}=process.getBuiltinModule('node:module');const r=createRequire(app.getAppPath()+'/package.json');const updater=r('electron-updater').autoUpdater;const real=updater.quitAndInstall.bind(updater);updater.quitAndInstall=()=>real(true,false);});
  const closed=electronApp.waitForEvent('close',{timeout:60000});await page.getByRole('button',{name:'重启并安装',exact:true}).click().catch(()=>{});await closed;electronApp=null;
  for(let i=0;i<120;i++) { await new Promise(r=>setTimeout(r,500));const v=spawnSync('powershell',['-NoProfile','-Command',`(Get-Item -LiteralPath '${executablePath}').VersionInfo.FileVersion`],{encoding:'utf8',windowsHide:true}).stdout?.trim();if(v==='1.2.1')break;if(i===119)throw new Error('安装器未完成升级'); }
  // Wait until NSIS has finished writing resources and the new uninstaller.
  await new Promise(r=>setTimeout(r,1500));
  page=await launch(); const s=await page.evaluate(()=>window.shixu.snapshot());
  check((await page.evaluate(()=>window.shixu.updateState())).currentVersion==='1.2.1','真实安装后重新启动为 1.2.1');
  check(s.accounts.length===1 && s.pending===1 && s.settings.theme==='dark','安装升级保留账户、离线队列及偏好');
  await page.evaluate(()=>window.shixu.sync());check((await page.evaluate(()=>window.shixu.snapshot())).pending===0 && dav.resources.size===2,'升级后 DPAPI 凭据可解密，离线队列正常同步');
  await electronApp.close();electronApp=null;
  await writeFile('docs/install-update-smoke-result.json',JSON.stringify({results,errors:[],boundary:'隔离 appId/目录/数据；实际 quitAndInstall，禁用测试自动重启并显式指定测试数据重新启动。'},null,2)+'\n');
} finally {if(electronApp)await electronApp.close();server.closeAllConnections();await new Promise(r=>server.close(r));await dav.close();}
