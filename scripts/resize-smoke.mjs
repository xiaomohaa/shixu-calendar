import { _electron } from 'playwright';
import { build } from 'esbuild';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url), root=resolve(`.smoke-data/resize-${Date.now()}`);await mkdir(root,{recursive:true});
await build({entryPoints:['tests/dav-server.ts'],outfile:join(root,'dav.cjs'),bundle:true,platform:'node',format:'cjs'});
const {davServer,fixtureIcs}=require(join(root,'dav.cjs')), fixture=await davServer();
for(let i=0;i<320;i++){const day=String(1+i%28).padStart(2,'0');fixture.put(`/home/personal/resize-${i}.ics`,fixtureIcs(`缩放验收 ${i}：很长的项目会议与个人安排文字，不应越过日格边界`,`resize-${i}`).replaceAll('20261023',`202610${day}`));}
fixture.put('/home/personal/multi.ics',fixtureIcs('跨月全天验收','resize-multi').replace('DTSTART:20261023T020000Z','DTSTART;VALUE=DATE:20261030').replace('DTEND:20261023T030000Z','DTEND;VALUE=DATE:20261103'));
let app;const results=[],errors=[],samples=[];
const check=(ok,label)=>{if(!ok)throw new Error(label);results.push(label);console.log(`PASS: ${label}`);};
const env={...process.env,SHIXU_DATA_DIR:join(root,'profile')};delete env.ELECTRON_RUN_AS_NODE;
async function settle(page){await new Promise(r=>setTimeout(r,180));await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));}
async function geometry(page){return page.evaluate(()=>{
  const grid=document.querySelector('.month-grid'),area=document.querySelector('.month-scroll'),g=grid.getBoundingClientRect(),a=area.getBoundingClientRect();
  const overflow=[...document.querySelectorAll('.month-cell')].some(cell=>{const c=cell.getBoundingClientRect();return [...cell.querySelectorAll('.month-event,.month-more')].some(el=>{const b=el.getBoundingClientRect();return b.bottom>c.bottom+1||b.right>c.right+1||b.left<c.left-1;});});
  const dates=[...document.querySelectorAll('.month-cell')].map(c=>{const cell=c.getBoundingClientRect(),n=c.querySelector('.solar-date').getBoundingClientRect();return Math.abs(n.x+n.width/2-cell.x-cell.width/2);});
  return {viewport:[innerWidth,innerHeight],width:g.width,height:g.height,areaWidth:area.clientWidth,mode:grid.dataset.eventMode,overflow,centering:Math.max(...dates),horizontalPageOverflow:document.documentElement.scrollWidth>innerWidth,cells:grid.querySelectorAll('.month-cell').length};
});}
try {
  app=await _electron.launch({...process.env.SHIXU_EXECUTABLE?{executablePath:resolve(process.env.SHIXU_EXECUTABLE),args:[]}:{args:['.']},env,timeout:60000});const page=await app.firstWindow();page.on('pageerror',e=>errors.push(e.message));
  await page.waitForSelector('.month-grid');
  const id=await page.evaluate(c=>window.shixu.saveAccount(c),{...fixture.account,name:'缩放压力验收账户',allowHttp:true});await page.evaluate(id=>window.shixu.sync(id),id);
  await page.evaluate(async()=>{const s=await window.shixu.snapshot();await window.shixu.settings({...s.settings,autoSync:false,autoUpdateCheck:false});await window.shixu.setCalendar(s.calendars[0].id,true,'#9b51d6');});
  await settle(page);await page.evaluate(()=>document.fonts.ready);
  check((await page.evaluate(()=>window.shixu.snapshot())).resources===321,'321 个真实 DAV 日程完成加载，包含跨月全天与长标题');
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setSize(1600,1000);w.webContents.setZoomFactor(1);});await settle(page);
  check((await geometry(page)).mode==='capsules' && await page.locator('.event-capsule').count()>0,'大窗口以浅色胶囊显示日程文字');
  const tint=await page.locator('.event-capsule').first().evaluate(el=>{const canvas=document.createElement('canvas'),context=canvas.getContext('2d');context.fillStyle=getComputedStyle(el).backgroundColor;context.fillRect(0,0,1,1);return [...context.getImageData(0,0,1,1).data];});
  check(tint[2]>tint[0] && tint[0]>tint[1],'紫色日历胶囊保持紫色浅底，不偏移为其他色相');
  check(await page.locator('.month-cell[data-date="2026-11-01"] .month-event').count()>0,'跨月全天事件在下一月日格保持可见');
  await page.locator('.month-cell[data-date="2026-10-30"] .event-capsule').filter({hasText:'跨月全天验收'}).dragTo(page.locator('.month-cell[data-date="2026-10-29"]'),{targetPosition:{x:60,y:55}});
  let moved;for(let i=0;i<100;i++){moved=(await page.evaluate(()=>window.shixu.events('2026-10-01','2026-12-01'))).find(e=>e.title==='跨月全天验收');if(moved.start==='2026-10-29')break;await new Promise(r=>setTimeout(r,50));}
  check(moved.start==='2026-10-29' && moved.end==='2026-11-02','真实拖动跨月全天事件按历日平移并保持四天时长');
  await page.screenshot({path:join(root,'desktop-capsules.png')});
  const more=page.locator('.month-cell[data-date="2026-10-23"] .month-more');await more.click();
  check(await page.locator('.day-agenda .agenda-event').count()===11,'折叠入口展开当天全部 11 项，日程无丢失');
  const title=(await page.locator('.agenda-event strong').first().innerText());await page.locator('.agenda-event').first().click();
  check(await page.getByLabel('日程标题',{exact:true}).inputValue()===title,'折叠列表可打开完整日程编辑器');await page.getByRole('button',{name:'关闭面板'}).click();
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setSize(1000,680);w.webContents.setZoomFactor(1);});await settle(page);
  check((await geometry(page)).mode==='dots' && await page.locator('.event-dot').count()>0,'小窗口自动显示彩色点，保留更多入口');
  const dot=page.locator('.month-cell[data-date="2026-10-23"] .event-dot').first(),dotLabel=await dot.getAttribute('aria-label');await dot.click();
  check(dotLabel.includes(await page.getByLabel('日程标题',{exact:true}).inputValue()),'彩色点可点击并打开对应日程详情');await page.getByRole('button',{name:'关闭面板'}).click();
  await page.locator('.month-cell[data-date="2026-10-23"]').focus();await page.keyboard.press('ArrowRight');
  check(await page.evaluate(()=>document.activeElement?.getAttribute('data-date'))==='2026-10-24','方向键在日期网格中移动焦点与选择');
  await page.keyboard.press('Enter');await page.locator('.day-agenda').waitFor();await page.keyboard.press('Escape');
  check(await page.locator('.day-agenda').count()===0 && await page.evaluate(()=>document.activeElement?.getAttribute('data-date'))==='2026-10-24','键盘展开/关闭完整日程后恢复日期焦点');
  await page.screenshot({path:join(root,'small-dots.png')});
  // Test instrumentation only. Count actual read IPC while resizing; no renderer
  // stubs or production APIs are introduced to obtain this observation.
  await app.evaluate(({ipcMain})=>{const handlers=ipcMain._invokeHandlers,original=handlers.get('shixu:call');globalThis.__resizeReads=0;ipcMain.removeHandler('shixu:call');ipcMain.handle('shixu:call',(event,method,args)=>{if(method==='events'||method==='snapshot')globalThis.__resizeReads++;return original(event,method,args);});});
  const requests=fixture.requests.length;
  for(const [width,height,zoom] of [[1380,900,.67],[1000,680,.8],[1600,1000,1],[1000,680,1.25],[1380,900,1.5],[1000,680,1.75],[1000,680,2],[1920,1080,1]]){
    const start=Date.now();await app.evaluate(({BrowserWindow},v)=>{const w=BrowserWindow.getAllWindows()[0];w.setSize(v[0],v[1]);w.webContents.setZoomFactor(v[2]);},[width,height,zoom]);await settle(page);
    const sample={windowWidth:width,windowHeight:height,zoom,elapsedMs:Date.now()-start,...await geometry(page)};samples.push(sample);
    check(sample.cells===42 && Math.abs(sample.width-sample.areaWidth)<2 && !sample.overflow && !sample.horizontalPageOverflow && sample.centering<=1 && sample.elapsedMs<2500,`${width}×${height} / ${Math.round(zoom*100)}%：网格铺满，无日程越界、日期居中且响应正常`);
    if(zoom===2){await page.locator('.month-cell[data-date="2026-10-23"] .month-more').click();check(await page.locator('.day-agenda-list').evaluate(el=>el.clientHeight>50)&&await page.locator('.agenda-event').first().isVisible(),'200% 缩放下当天完整列表仍有可滚动阅读空间');await page.getByRole('button',{name:'关闭当天日程'}).click();}
  }
  for(let i=0;i<48;i++)await app.evaluate(({BrowserWindow},i)=>{const w=BrowserWindow.getAllWindows()[0];w.setSize(i%2?1000:1600,i%2?680:1000);if(i%6===0)w.webContents.setZoomFactor(i%12===0?1.25:1);},i);
  await settle(page);const stress=await geometry(page);check(stress.cells===42&&!stress.overflow&&Math.abs(stress.width-stress.areaWidth)<2,'连续 48 次窗口/缩放变化后仍可交互，无尺寸残留');
  check(await app.evaluate(()=>globalThis.__resizeReads)===0 && fixture.requests.length===requests,'纯缩放期间没有重复数据库读取或 DAV 网络请求');
  await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.setSize(1600,1000);w.webContents.setZoomFactor(1);});await settle(page);
  await page.getByRole('button',{name:'展开侧边栏',exact:true}).click();await settle(page);
  check(Math.abs((await geometry(page)).width-(await geometry(page)).areaWidth)<2,'重新展开侧栏后网格跟随容器铺满');
  await page.evaluate(()=>window.shixu.snapshot().then(s=>window.shixu.settings({...s.settings,theme:'dark'})));await settle(page);
  check(!((await geometry(page)).overflow),'深色模式仍无文字或胶囊越界');await page.screenshot({path:join(root,'dark-capsules.png')});
  await page.evaluate(()=>{window.__legacyMonthMounted=false;new MutationObserver(()=>{if(document.querySelector('.fc-dayGridMonth-view'))window.__legacyMonthMounted=true;}).observe(document.body,{childList:true,subtree:true});});
  for(let cycle=0;cycle<4;cycle++)for(const name of ['周','日','列表','月']){await page.getByRole('button',{name,exact:true}).click({timeout:5000});await settle(page);}
  check(await page.locator('.month-grid').count()===1 && !(await page.evaluate(()=>window.__legacyMonthMounted)),'四视图连续往返四轮，未挂载旧月视图且保持可交互');
  check(errors.length===0,'缩放和密集日程期间 Renderer 无未处理异常');
  const report={version:(await page.evaluate(()=>window.shixu.updateState())).currentVersion,results,errors,samples,rapidResizeCount:48,eventResources:321};await writeFile('docs/resize-smoke-result.json',JSON.stringify(report,null,2)+'\n');
  await writeFile(join(root,'result.json'),JSON.stringify(report,null,2));console.log(`Screenshots: ${root}`);
}finally{if(app)await app.close();await fixture.close();}
