# 第三方软件

本应用使用的版本由 package-lock.json 锁定。未修改第三方库源文件。

| 依赖 | 许可 | 官方资料 |
| --- | --- | --- |
| Electron 45.0.0 | MIT | https://www.electronjs.org/docs/latest/api/safe-storage |
| React / React DOM 19.3.1 | MIT | https://react.dev/ |
| FullCalendar 6.1.20 开源组件 | MIT | https://fullcalendar.io/docs/v6 |
| tsdav 2.5.0 | MIT | https://github.com/natelindev/tsdav |
| ical.js 2.2.1 | MPL-2.0 | https://github.com/kewisch/ical.js |
| Luxon 3.7.2 | MIT | https://moment.github.io/luxon/ |
| fast-xml-parser 5.11.2 | MIT | https://github.com/NaturalIntelligence/fast-xml-parser |
| Zod 4.6.7 | MIT | https://zod.dev/ |
| Lucide React 0.577.0 | ISC | https://lucide.dev/license |
| SQLite（随 Electron/Node 提供） | Public Domain | https://www.sqlite.org/copyright.html |
| lunar-typescript 1.8.6 | MIT | https://github.com/6tail/lunar-typescript |

tsdav 使用实际安装版本的 davRequest、createObject、updateObject 和 deleteObject API。发现与同步实现补充同源凭据限制、流式读取上限、sync-token 与回退策略。ical.js 使用完整组件树修改。VTIMEZONE 的多值 RDATE 适配在本应用自己的解析层实现，不修改该库。

ical.js 的原始源码按 MPL-2.0 提供：https://github.com/kewisch/ical.js/tree/v2.2.1 。相关许可文本随分发依赖保留在 app.asar/node_modules 中。Electron 的 Chromium、Node 和其他组件的许可见安装目录 LICENSE.electron.txt 与 LICENSES.chromium.html。

本项目图标为本地矢量几何绘制，未使用 Apple 专有素材。字体使用 Windows 已安装的系统字体。构建工具为 Vite、TypeScript、esbuild、electron-builder；测试使用 Vitest 与 Playwright，均不作为运行时服务。
