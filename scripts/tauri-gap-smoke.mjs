import { chromium } from 'playwright';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
const data=resolve('.smoke-data',`spans-${Date.now()}`),require=createRequire(import.meta.url);
await mkdir(data,{recursive:true});
const fixturePath=resolve('.smoke-data/spans-dav.cjs');await build({entryPoints:['tests/dav-server.ts'],outfile:fixturePath,bundle:true,platform:'node',format:'cjs'});
const fixture=await require(fixturePath).davServer();
const app=spawn(resolve(process.env.SHIXU_TAURI_TEST_EXE||'src-tauri/target/release/shixu-calendar.exe'),[],{env:{...process.env,SHIXU_TAURI_TEST_DATA_DIR:data,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9236'},stdio:'ignore'});
const until=async(check,message)=>{for(let i=0;i<80;i++){try{const result=await check();if(result)return result;}catch{}await new Promise(resolve=>setTimeout(resolve,150));}throw new Error(message);};
let browser,page;
try{
 browser=await until(()=>chromium.connectOverCDP('http://127.0.0.1:9236'),'Preview missing');page=await until(()=>browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().startsWith('http://tauri.localhost/')),'Main missing');await page.locator('.month-grid').waitFor();
 if((await page.evaluate(()=>window.shixu.desktopState())).mode!=='development')throw new Error('Use isolated preview');
 await page.setViewportSize({width:1380,height:1000});await page.clock.setFixedTime(new Date('2026-11-02T02:00:00Z'));
 await page.evaluate(async account=>{const id=await window.shixu.saveAccount(account);await window.shixu.sync(id);const state=await window.shixu.snapshot();await window.shixu.settings({...state.settings,theme:'light',autoSync:false,autoUpdateCheck:false,firstDay:0,showAlmanac:false});const calendarId=state.calendars.find(calendar=>calendar.accountId===id).id;
 for(const [title,start,end,allDay] of [['跨6天','2026-11-05T09:00','2026-11-10T18:00',false],['跨5天','2026-11-06T09:00','2026-11-11T10:00',false],['跨两天A','2026-11-05T09:00','2026-11-06T18:00',false],['跨两天B','2026-11-05T10:00','2026-11-06T19:00',false],['121','2026-11-05T11:00','2026-11-05T12:00',false],['京东白条还款日','2026-11-11','2026-11-12',true]])await window.shixu.saveEvent({calendarId,title,start,end,allDay,timezone:'Asia/Shanghai',location:'',description:'',rrule:'',reminder:-1,scope:'series'});
 },fixture.account);
 await page.getByRole('button',{name:'今天',exact:true}).click();
 const fifth=page.locator('.month-cell[data-date="2026-11-05"] .month-event-list .month-event').filter({hasText:'121'});await fifth.waitFor();
 const eleventh=page.locator('.month-cell[data-date="2026-11-11"] .month-event-list .month-event').filter({hasText:'京东白条还款日'});await eleventh.waitFor();
 if(await fifth.evaluate(el=>el.style.gridRow)!=='2'||await eleventh.evaluate(el=>el.style.gridRow)!=='1')throw new Error('Single-day events did not fill first free lane');
 for(const date of ['2026-11-05','2026-11-11']){const cell=page.locator(`.month-cell[data-date="${date}"]`);const row=cell.locator('..');const singles=await cell.locator('.month-event-list .month-event').boundingBox();const spans=await row.locator('.month-span').evaluateAll(elements=>elements.map(el=>({left:el.getBoundingClientRect().left,right:el.getBoundingClientRect().right,top:el.getBoundingClientRect().top,bottom:el.getBoundingClientRect().bottom})));if(spans.some(span=>singles.x<span.right&&singles.x+singles.width>span.left&&singles.y<span.bottom&&singles.y+singles.height>span.top))throw new Error('Filled event overlaps capsule');}
 const colors=()=>page.evaluate(()=>{const lunar=document.querySelector('.month-cell[data-date="2026-12-01"] .lunar-date'),solar=document.querySelector('.month-cell[data-date="2026-12-01"] .solar-date'),current=document.querySelector('.month-cell[data-date="2026-11-11"] .lunar-date');return {lunar:getComputedStyle(lunar).color,solar:getComputedStyle(solar).color,current:getComputedStyle(current).color};});
 let c=await colors();if(c.lunar!==c.solar||c.lunar===c.current)throw new Error(`Adjacent lunar not faded: ${JSON.stringify(c)}`);
 await page.screenshot({path:'.smoke-data/gap-layout-light.png'});
 await page.evaluate(async()=>{const state=await window.shixu.snapshot();await window.shixu.settings({...state.settings,theme:'dark'});});await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');await page.waitForFunction(()=>getComputedStyle(document.querySelector('.month-cell[data-date="2026-12-01"] .lunar-date')).color===getComputedStyle(document.querySelector('.month-cell[data-date="2026-12-01"] .solar-date')).color);c=await colors();if(c.lunar===c.current)throw new Error('Dark adjacent lunar not faded');await page.screenshot({path:'.smoke-data/gap-layout-dark.png'});
 await page.setViewportSize({width:480,height:360});await page.waitForFunction(()=>document.querySelector('.month-grid')?.dataset.eventCapacity==='1');
 if(await page.locator('.month-cell').count()!==42)throw new Error('Resize lost dates');await page.locator('.month-cell[data-date="2026-11-05"] .month-more').click();if(await page.locator('.day-agenda .agenda-event').count()!==4)throw new Error('Folded events lost');
 console.log('PASS: Nov 5 lane gap, Nov 11 top gap, no capsule overlap, adjacent solar/lunar fading light/dark, minimum-window overflow');
}finally{await browser?.close().catch(()=>{});if(app.exitCode===null)app.kill();await fixture.close();}
