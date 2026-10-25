import { chromium } from 'playwright';
import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';

const data=resolve('.smoke-data',`compact-editor-${Date.now()}`), require=createRequire(import.meta.url);
await mkdir(data,{recursive:true});
const fixturePath=resolve('.smoke-data/editor-dav.cjs');
await build({entryPoints:['tests/dav-server.ts'],outfile:fixturePath,bundle:true,platform:'node',format:'cjs'});
const fixture=await require(fixturePath).davServer();
const app=spawn(resolve(process.env.SHIXU_TAURI_TEST_EXE||'src-tauri/target/release/shixu-calendar.exe'),[],{env:{...process.env,SHIXU_TAURI_TEST_DATA_DIR:data,WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS:'--remote-debugging-port=9236'},stdio:'ignore'});
let browser,page;
const until=async(check,message)=>{for(let i=0;i<80;i++){try{const result=await check();if(result)return result;}catch{}await new Promise(resolve=>setTimeout(resolve,200));}throw new Error(message);};
const events=()=>page.evaluate(()=>window.shixu.events('2026-10-01','2026-11-01'));
const open=async(title,day)=>{const cell=page.locator(`.month-cell[data-date="2026-10-${day}"]`);await cell.locator('.month-event').filter({hasText:title}).click();await page.getByRole('dialog',{name:'编辑日程',exact:true}).waitFor();};
const remove=async(scope)=>{
  await page.getByRole('button',{name:'删除',exact:true}).click();
  if(scope){if(await page.getByRole('combobox',{name:'删除范围',exact:true}).inputValue()!=='instance')throw new Error('Recurring delete did not default to current occurrence');await page.getByRole('combobox',{name:'删除范围',exact:true}).selectOption(scope);}
  else if(await page.getByRole('combobox',{name:'删除范围',exact:true}).count()||(await page.locator('.event-delete-confirm').textContent()).includes('系列'))throw new Error('Ordinary deletion was described as a series');
  await page.getByRole('button',{name:'确认删除',exact:true}).click();await page.locator('.editor-panel').waitFor({state:'detached'});
};
try {
  browser=await until(()=>chromium.connectOverCDP('http://127.0.0.1:9236'),'Preview did not start');
  page=await until(()=>browser.contexts().flatMap(context=>context.pages()).find(page=>page.url().startsWith('http://tauri.localhost/')),'Missing main page');
  await page.locator('.month-grid').waitFor();
  if((await page.evaluate(()=>window.shixu.desktopState())).mode!=='development')throw new Error('Use isolated development build only');
  await page.clock.setFixedTime(new Date('2026-10-24T03:35:00Z'));
  await page.setViewportSize({width:1200,height:820});
  const account=await page.evaluate(async account=>{
    const id=await window.shixu.saveAccount(account);await window.shixu.sync(id);const state=await window.shixu.snapshot();
    await window.shixu.settings({...state.settings,autoSync:false,theme:'light',showAlmanac:false});
    const calendarId=state.calendars.find(calendar=>calendar.accountId===id).id;
    for(const [title,start,rrule] of [['紧凑日程','25',''],['未来删除测试','19','FREQ=DAILY;COUNT=8'],['单次删除测试','23','FREQ=DAILY;COUNT=4'],['首次删除测试','27','FREQ=DAILY;COUNT=3']])
      await window.shixu.saveEvent({calendarId,title,start:`2026-10-${start}T10:00:00`,end:`2026-10-${start}T11:00:00`,allDay:false,timezone:'Asia/Shanghai',location:'',description:'',rrule,reminder:-1,scope:'series'});
    return id;
  },fixture.account);
  await open('紧凑日程','25');
  const metrics=()=>page.locator('.reference-event-editor').evaluate(element=>({
    title:element.querySelector('.event-title-input').getBoundingClientRect().height,
    titleOverflow:element.querySelector('.event-title-input').scrollHeight>element.querySelector('.event-title-input').clientHeight,
    notes:element.querySelector('.event-notes-box').getBoundingClientRect().height,
    rows:[...element.querySelectorAll('.event-option-row')].map(row=>row.getBoundingClientRect().height),
    fields:[...element.querySelectorAll('.event-location-box,.event-calendar-box')].map(row=>row.getBoundingClientRect().height),
    panel:element.closest('.floating-editor').getBoundingClientRect().height,
    blur:getComputedStyle(element.closest('.floating-editor')).backdropFilter,
  }));
  const short=await metrics();
  if(short.titleOverflow||short.title>40||short.notes>40||short.rows.some(height=>height>24)||short.fields.some(height=>height>36)||short.panel>390||!short.blur.includes('blur(36px)'))throw new Error(`Editor not compact/glass: ${JSON.stringify(short)}`);
  const title=page.getByRole('textbox',{name:'日程标题',exact:true}),notes=page.getByRole('textbox',{name:'备注',exact:true});
  await title.fill('这是需要自动换行显示的长日程标题。'.repeat(5));await notes.fill('较长备注需要自动伸展。'.repeat(20));
  const long=await metrics();if(long.title<=short.title||long.notes<=short.notes)throw new Error('Textareas did not grow');
  await title.fill('紧凑日程');await notes.fill('');
  if((await metrics()).title!==short.title||(await metrics()).notes!==short.notes)throw new Error('Textareas did not shrink after clearing');
  await page.locator('.floating-editor').screenshot({path:'.smoke-data/compact-editor-light.png'});
  await page.evaluate(async()=>{const state=await window.shixu.snapshot();await window.shixu.settings({...state.settings,theme:'dark'});});
  await page.waitForFunction(()=>document.documentElement.dataset.theme==='dark');
  await page.locator('.floating-editor').screenshot({path:'.smoke-data/compact-editor-dark.png'});
  await page.evaluate(async()=>{const state=await window.shixu.snapshot();await window.shixu.settings({...state.settings,theme:'light'});});
  await remove();
  if((await events()).some(event=>event.title==='紧凑日程'))throw new Error('Ordinary event remained');
  await open('未来删除测试','22');
  await page.getByRole('button',{name:'删除',exact:true}).click();
  await page.getByRole('combobox',{name:'删除范围',exact:true}).selectOption('future');
  await page.locator('.floating-editor').screenshot({path:'.smoke-data/delete-future.png'});
  await page.getByRole('button',{name:'确认删除',exact:true}).click();await page.locator('.editor-panel').waitFor({state:'detached'});
  let remaining=(await events()).filter(event=>event.title==='未来删除测试');
  if(remaining.length!==3||remaining.some(event=>event.start>='2026-10-22'))throw new Error('Future deletion lost history or left future events');
  await page.evaluate(id=>window.shixu.sync(id),account);
  remaining=(await events()).filter(event=>event.title==='未来删除测试');
  if(remaining.length!==3)throw new Error('CalDAV roundtrip changed truncated recurrence');
  await open('单次删除测试','24');await remove('instance');
  remaining=(await events()).filter(event=>event.title==='单次删除测试');
  if(remaining.length!==3||remaining.some(event=>event.recurrenceId==='2026-10-24T10:00:00'))throw new Error('Single deletion affected other dates');
  await open('单次删除测试','25');await remove('series');
  if((await events()).some(event=>event.title==='单次删除测试'))throw new Error('Whole series remained');
  await open('首次删除测试','27');await remove('future');
  if((await events()).some(event=>event.title==='首次删除测试'))throw new Error('First-and-future failed to delete resource');
  await page.evaluate(id=>window.shixu.sync(id),account);
  if((await page.evaluate(()=>window.shixu.snapshot())).conflicts.length)throw new Error('Deletes introduced sync conflicts');
  await open('未来删除测试','20');
  await page.setViewportSize({width:480,height:360});
  const box=await page.locator('.floating-editor').boundingBox();
  if(box.x<0||box.y<0||box.x+box.width>480||box.y+box.height>360)throw new Error('Small editor out of bounds');
  await page.getByRole('button',{name:'取消',exact:true}).click();
  console.log(`PASS: adaptive glass editor ${short.panel}px, one-line title ${short.title}px, compact rows ${short.rows.join('/')}, dark theme, ordinary/instance/future/series deletion and real CalDAV roundtrip, minimum window`);
}finally{await browser?.close().catch(()=>{});if(app.exitCode===null)app.kill();await fixture.close();}
