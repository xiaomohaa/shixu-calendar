import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { normalize } from 'node:path';
const require=createRequire(import.meta.url), asar=require('@electron/asar'), yaml=require('js-yaml');
const digest=data=>createHash('sha256').update(data).digest('hex');
const pkg=JSON.parse(readFileSync('package.json','utf8')), archive='release/win-unpacked/resources/app.asar';
for(const file of ['dist-main/main.cjs','dist-main/preload.cjs','dist/index.html',...readdirSync('dist/assets').map(name=>`dist/assets/${name}`)]) {
  if(digest(asar.extractFile(archive,normalize(file)))!==digest(readFileSync(file)))throw new Error(`ASAR 与构建不一致: ${file}`);
}
if(JSON.parse(asar.extractFile(archive,'package.json')).version!==pkg.version)throw new Error('ASAR 版本不匹配');
if(!asar.extractFile(archive,'fonts/NOTICE.md').length)throw new Error('缺少字体权利说明');
const exe=readFileSync('release/win-unpacked/时序日历.exe'), pe=exe.readUInt32LE(0x3c);
if(exe.readUInt16LE(pe+4)!==0x8664)throw new Error('EXE 不是 x64');
const config=yaml.load(readFileSync('release/win-unpacked/resources/app-update.yml','utf8'));
if(config.provider!=='github'||config.owner!=='xiaomohaa'||config.repo!=='shixu-calendar')throw new Error('发布源不匹配');
const metadata=yaml.load(readFileSync('release/latest.yml','utf8')), name=`Shixu-Setup-${pkg.version}-x64.exe`;
if(metadata.version!==pkg.version||metadata.path!==name||metadata.sha512!==createHash('sha512').update(readFileSync(`release/${name}`)).digest('base64'))throw new Error('更新元数据与安装包不匹配');
const smoke=JSON.parse(readFileSync('.smoke-data/result.json','utf8'));
writeFileSync('docs/electron-smoke-result.json',JSON.stringify(smoke,null,2)+'\n');
const unit=JSON.parse(readFileSync('.smoke-data/unit-result.json','utf8')), resize=JSON.parse(readFileSync('docs/resize-smoke-result.json','utf8'));
if(unit.numFailedTests || !unit.success || resize.errors.length || smoke.errors.length || resize.version!==pkg.version || smoke.version!==pkg.version)throw new Error('测试未通过或测试版本与安装包不一致');
const result={date:'2026-10-23',timezone:'Asia/Shanghai',version:pkg.version,electron:pkg.devDependencies.electron,architecture:'x64',mainSha256:digest(readFileSync('dist-main/main.cjs')),unitAndProtocolTests:unit.numPassedTests,packagedElectronSmokeChecks:smoke.results.length,resizeChecks:resize.results.length,resizeEvents:resize.eventResources,rapidResizeCount:resize.rapidResizeCount,updaterInstallBaseline:'1.2.0 to 1.2.1 (previous release)',asarVerified:true,chineseHolidayYears:[2024,2025,2026],codeSigned:false};
writeFileSync('docs/build-info.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
