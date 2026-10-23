# 第一版验证记录

## 1.1.0 日期居中与中国历法更新

2026-10-23：新增农历、黄历和中国大陆放假调休。`npm run typecheck` 与 `npm run build` 通过；`npm test` 的 44 项测试通过；扩展 Electron 冒烟为 26 项，验证 42 个日格的日期水平居中误差均不超过 1px，农历节气、黄历详情联动、休班标识、离线计算和小窗口。继续回归账户安全及 DAV 增删改。数据范围、来源及未收录年份的处理见 [CHINESE_CALENDAR.md](CHINESE_CALENDAR.md)。

`npm run pack` 已生成 1.1.0 的 Windows x64 安装版和便携版。直接运行打包后的生产 EXE 完成全部 26 项检查；确认主进程、Renderer 的 ASAR 内容与最终构建一致，PE Machine 为 x64。

以下保留 1.0.0 的初始验证记录。当前版本的产物信息见 `build-info.json`、`electron-smoke-result.json` 和 `release/SHA256SUMS.txt`。

日期：2026-10-23（Asia/Shanghai）。实际开发机为 Windows x64，Node.js 24.18.0，Electron 45.0.0。所有 DAV 测试均使用独立本机 HTTP 服务器，没有用户真实凭据；测试数据不进入正常应用用户目录。

## 已执行

- `npm install`：依赖成功安装，安装审计为 0 个已知漏洞。
- `npm run typecheck`：严格 TypeScript 全量通过。
- `npm test`：Vitest 33 项通过，覆盖 URL、认证错误、XML propstat、ICS、全天/时区/浮动时间、DST、RRULE/RDATE/EXDATE、单次例外、未知属性/提醒、SQLite 迁移和事务、持久化队列、UID/资源映射、条件写入、412 冲突、增量/回退/失效令牌、并发修改、取消恢复、凭据抽象和脱敏。
- `npm run build`：Vite 静态资源与主进程/preload 构建通过；生产不启动 Vite。Renderer 已按 React、日历和应用分包。
- `npm run smoke`：实际启动 Electron，两次打开独立配置目录，17 项检查通过。账户表单完成真实 DAV 发现；通过界面新建、编辑、确认删除；实际 PUT / DELETE；四视图切换；Windows safeStorage 密文落盘；数据库与 WAL 无明文密码；IPC 无凭据泄露；Renderer 无 Node；主题、日期格式、最小窗口和离线重启通过，Renderer 无未处理异常。
- Windows x64 打包：electron-builder 生成 NSIS 安装版、便携版和 win-unpacked 解压版。最终文件大小及 SHA256 见 `release/SHA256SUMS.txt`。
- 直接运行 `release/win-unpacked/时序日历.exe`，在 app.asar 的生产环境再次执行上述 17 项冒烟，全部通过。通过版本资源核对 ProductName 为“时序日历”、ProductVersion 为 1.0.0.0。测试后关闭所有由脚本创建的窗口。
- 核验生产 EXE 的 PE Machine 为 `0x8664`（x64），并比较 app.asar 中主进程 bundle 与最终构建的 SHA256，完全一致。机器可读记录见 `build-info.json` 和 `electron-smoke-result.json`。

截图和端到端结果位于 `.smoke-data`，其中标题为明确的本机协议验收数据；生产首次启动保持空账户和空日历。测试脚本只操作由它创建的独立数据目录。

## 保留的边界

尚未使用真实 Nextcloud、iCloud、Radicale、Baïkal 账户逐一测试；未验证每一版 Windows 10/11、Windows 通知的物理弹出、SmartScreen 分发体验或自签名 TLS 的系统信任配置。应用没有签名证书。

本地提醒仅在应用运行时轮询，退出后不工作。自动测试验证 DISPLAY 提醒解析与持久化结构，未声称系统一定显示通知。协议不支持 OAuth、完整 scheduling 或 sync-collection 分页。复杂重复的编辑限制和其他边界见 README，不会通过静默删除规则或未知字段规避。
