import { createServer } from 'node:http';
import { createHash, randomBytes } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { build } from 'esbuild';
import electron from 'electron';
const root = resolve(`.smoke-data/updater-${Date.now()}`); await mkdir(root, {recursive:true});
const body = randomBytes(4*1024*1024), corrupt = Buffer.from(body); corrupt[0] ^= 0xff;
const sha512 = createHash('sha512').update(body).digest('base64');
const server = createServer((req,res) => {
  if(req.url?.includes('latest.yml')) { res.writeHead(200,{'content-type':'text/yaml'});res.end(`version: 1.2.1\nfiles:\n  - url: fixture.exe\n    sha512: ${sha512}\n    size: ${body.length}\npath: fixture.exe\nsha512: ${sha512}\nreleaseDate: '2026-10-23T00:00:00Z'\n`);return; }
  if(req.url?.includes('fixture.exe')) {
    res.writeHead(200,{'content-type':'application/octet-stream','content-length':body.length});
    const data=req.url.includes('/broken/')?corrupt:body; let offset=0;
    const timer=setInterval(()=>{res.write(data.subarray(offset,offset+65536));offset+=65536;if(offset>=data.length){clearInterval(timer);res.end();}},20);
    res.on('close',()=>clearInterval(timer));return;
  } res.writeHead(404);res.end();
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
try {
  const runner=join(root,'runner.cjs'), config=join(root,'config.json');
  await build({entryPoints:['tests/updater-electron.ts'],outfile:runner,bundle:true,platform:'node',format:'cjs',external:['electron','electron-updater','electron-updater/*']});
  await writeFile(config,JSON.stringify({root,url:`http://127.0.0.1:${server.address().port}`,sha512}));
  const env={...process.env}; delete env.ELECTRON_RUN_AS_NODE;
  const child=spawn(electron,[runner,config],{env,stdio:['ignore','pipe','pipe'],windowsHide:true});
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  const timeout=setTimeout(()=>child.kill(),60000);
  const code=await new Promise((resolve,reject)=>{child.on('exit',resolve);child.on('error',reject);});clearTimeout(timeout);
  const result=JSON.parse(await readFile(join(root,'result.json'),'utf8').catch(()=>JSON.stringify({results:[],errors:[output]})));
  console.log(JSON.stringify(result,null,2)); await writeFile(resolve('docs/updater-smoke-result.json'),JSON.stringify(result,null,2)+'\n');
  if(code!==0) throw new Error('真实更新器测试失败');
} finally {server.closeAllConnections();await new Promise(r=>server.close(r));}
