# 验证记录

## 1.2.0 托盘、自启、字体与更新

2026-10-23：54 项单元、协议、同步和更新状态测试通过。正式 EXE 的 34 项 Electron 检查通过，新增真实字体加载与 Chromium 自定义字体字形验证、关闭隐藏且 IPC/数据库仍可用、启动设置和真实版本显示，同时回归农历黄历、休班、日期居中和原有 DAV 全流程。

独立 Electron 中使用真实 electron-updater 完成 6 项 HTTP 验证：发现下一版本、下载与 SHA512、进度事件、篡改拒绝、取消、取消后重试成功。再使用独立 appId、安装目录和数据执行真实 NSIS 1.2.0 → 1.2.1 升级，11 项检查通过，包括实际写入/移除 Windows 登录项、--hidden 隐藏到托盘、IPC 检查下载、真实 quitAndInstall、版本变化和账户/偏好/离线队列保留，升级后 DPAPI 解密与队列同步通过。为保证测试不接触正常数据，安装测试仅禁止安装器自动重启，改为显式携带测试数据目录重新启动；不声称已用测试数据自动重启到正常用户目录。

自启测试发现 Electron 45 对带参数登录项的 openAtLogin 查询返回 false，但 launchItems 与实际注册表正确；当前通过匹配应用自己的用户级启动项读取开启和系统启用状态。未重启 Windows 做真实登录验证。系统通知是否物理弹出仍受系统设置限制。

验证报告：electron-smoke-result.json、updater-smoke-result.json、install-update-smoke-result.json 与 build-info.json。打包校验比较全部 ASAR Renderer 资源、字体、main/preload 和本地最终构建，核验 x64、字体说明、更新源及 latest.yml 的安装包 SHA512。

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
