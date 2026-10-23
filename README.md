# 时序日历

运行于 **Windows 10/11 x64** 的个人 CalDAV 客户端。Electron + React + TypeScript + Vite；中文界面，支持浅色、深色与系统主题。首次运行没有示例账户或演示日程。

![首次启动的真实空日历](docs/screenshots/first-run.png)

## 安装和启动

[下载最新 Windows x64 安装包或便携版](https://github.com/xiaomohaa/shixu-calendar/releases/latest)。

在 `release` 中选择：

- `Shixu-Setup-1.1.0-x64.exe`：安装程序，可选择安装路径并创建桌面快捷方式。
- `Shixu-Portable-1.1.0-x64.exe`：免安装启动器。**便携版的数据仍存于当前 Windows 用户的应用数据目录，不随 EXE 移动**。
- `win-unpacked/时序日历.exe`：解压版入口，需要保留同目录全部文件。

安装后无需 Node.js 或 Vite。应用尚未签名，Windows 可能显示 SmartScreen 提示。程序采用用户级安装，不需要管理员权限。当前未对每个 Windows 10/11 版本分别测试。

## 配置自己的 CalDAV

1. 打开“设置 → 账户与同步 → 添加账户”。
2. 输入账户名称、完整 HTTPS 服务地址、用户名和密码。地址可为服务根目录、calendar-home 或具体日历地址，无服务商绑定。
3. 点击“测试连接与自动发现”。成功时显示真实发现的日历；认证或 HTTP 错误会显示中文说明和状态码。
4. 点击“保存账户”。保存后启动首次同步。默认每 10 分钟自动同步，也可使用工具栏同步按钮；同步中再次点击可取消。
5. 在侧栏选择要显示的日历；设置中可改变颜色和默认日历，暂停账户或删除本地账户。

iCloud 等服务通常需要应用专用密码。若根地址发现失败，请使用服务商提供的具体 CalDAV 地址。发现会读取 current-user-principal、calendar-home-set、resourcetype、组件类型和可用权限，并尝试 `/.well-known/caldav`。跨站点重定向不会自动携带密码；若服务器将账户重定向到另一个域名，请使用该目标站点的具体服务地址重新配置。

支持 HTTP Basic。HTTP 明文传输必须在高级选项中主动勾选。TLS 始终验证；自签名服务器应先将证书安装到受信任证书链，应用不提供忽略证书选项。暂不支持 OAuth 登录窗口、交互式 Digest 或代理单独认证。

## 使用

- 月、周、日、列表视图可切换；周/日视图支持拖选新建、拖动和拉伸调整时间，重叠事件由 FullCalendar 排列。
- 点击日期在侧栏查看当天安排；双击空白日期或按 `N` 新建。`T` 跳到今天，`Ctrl+F` 搜索当前显示日期范围的标题、地点和备注。
- 编辑器支持标题、日期时间、全天、日历、地点、备注、重复规则及提醒。全天事件的结束日期为**不包含的日期**，例如 23 日的全天日程应填写结束于 24 日。
- 支持每日/周/月/年和自定义 RRULE；重复日程明确区分“仅此一次”和“整个系列”。单次修改使用 RECURRENCE-ID，单次删除使用 EXDATE。
- 本地保存立即持久化；标记为待同步并在下一次自动或手动同步时提交。离线修改、删除和冲突可在退出后保留。
- 冲突在“设置 → 同步冲突”查看，支持采用服务器、本地版本或另存副本保留双方。选择本地版本仍通过最新 ETag 条件写入。
- 设置中的同步间隔、默认视图、每周首日、默认时长、提醒、时区、日期/时间格式、主题等均持久化生效。
- 月视图日期与农历信息居中显示，包含闰月、节气和传统节日。点击日期在侧栏查看农历、生肖干支、黄历宜忌，展开可看冲煞、值神、财神喜神方位及彭祖百忌。
- 中国大陆节假日以“休”标注，调休补班以“班”标注，点击可看假期及补班日期。目前离线核对收录 2024–2026 年官方安排；未收录年份不猜测放假和补班日期。农历、黄历和节假日显示均不依赖账户和网络，也不会创建远程日程。数据来源见[历法说明](docs/CHINESE_CALENDAR.md)。

## 数据完整性与限制

- 使用 `PROPFIND`、`REPORT`、`sync-collection`、`calendar-query`、`calendar-multiget`、`PUT` 和 `DELETE`。有效 sync-token 优先；服务器不支持或令牌过期时回退全量查询。每账户只有一个同步任务，请求超时 25 秒，取消后保留队列，下次同步重试。
- 原始 ICS、远程资源 URL 和 ETag 保存在 SQLite。新建使用固定资源 URL 与 `If-None-Match: *`，更新和删除使用 `If-Match`，412 保留双方版本。服务器没有 ETag 时不进行无条件覆盖，交由冲突处理。
- 编辑使用 ical.js 完整组件树，保留未知属性、VTIMEZONE、参与者和未主动更改的提醒。支持 RRULE、RDATE、EXDATE、RECURRENCE-ID、DURATION、UTC 和浮动时间。
- 含复杂重复例外时，不允许改变规则或平移整个系列的 DTSTART；含 RANGE=THISANDFUTURE 的系列不在本应用修改/删除单次实例；多个独立 VEVENT 共用资源或孤立例外需要在原服务编辑。这些限制会明确报错并保留数据。
- 新建事件支持 1901–2099 年。新写入的 IANA 时区定义由 Electron ICU 生成，覆盖 1900–2100 年；远程定义优先保留。密集重复的展开限制为 100000 次迭代，超过时提示且不改写原数据。单次 DAV 响应上限 32MB；尚未实现 sync-collection 分页。
- 读取常见 DISPLAY 提前提醒，并通过 Windows 通知提醒，**仅在应用运行时生效**。关闭窗口即退出，不在后台提醒；系统通知权限、专注助手可能影响显示。复杂、绝对时间、EMAIL/AUDIO、多重或 RELATED=END 提醒会保留，但当前不在本机触发。
- 未实现会议邀请、参与者回复、共享日历权限编辑、远程新建/删除日历或 CalDAV scheduling。
- 当前已用真实本机 HTTP DAV 服务进行协议和 Electron 端到端测试。**未使用真实 Nextcloud、iCloud、Radicale、Baïkal 账户逐一验证**；不能将此测试视为所有服务商兼容性认证。

## 隐私

网络、数据库和凭据只在主进程处理。渲染进程开启 contextIsolation 与 sandbox，禁用 Node.js，IPC 校验来源、方法及参数。CSP 禁止远程脚本、对象和任意导航，无遥测。

密码由 Electron 45 的异步 safeStorage 使用 Windows DPAPI 保护；普通数据库只保存密文，不回传渲染进程。日程缓存本身是普通 SQLite，建议保护 Windows 账户并启用磁盘加密。删除账户需要确认，只删除本地关联数据，包含未同步操作，不删除远程资源。清缓存保护未同步变更及冲突。

默认数据目录可通过 Electron 的 `app.getPath('userData')` 确定，通常位于 `%APPDATA%/时序日历`。测试通过 `SHIXU_DATA_DIR` 使用独立目录。设置备份只包含偏好，不包含密码、账户或日程；更换电脑后需重新添加账户。

## 开发环境与命令

建议 Node.js 24 x64、npm 11 或更新版本。依赖版本锁在 package-lock.json，无需本机 C++ 编译器。SQLite 使用 Electron 携带的 `node:sqlite`。

```powershell
npm ci
# 若安装策略跳过 Electron 下载，则执行：
node node_modules/electron/install.js

npm run dev         # 构建主进程，启动 Vite 和 Electron；改主进程后需重新启动
npm run typecheck   # 严格 TypeScript
npm test            # Vitest 协议、ICS、SQLite、同步集成
npm run build       # 静态渲染资源 + 主进程 / preload bundle
npm start           # 启动本地生产构建
npm run smoke       # 真实 Electron + 独立本机 DAV 服务；会打开测试窗口
npm run pack        # 生产构建并生成 Windows x64 安装版、便携版
npm run pack:dir    # 仅生成可运行解压目录
```

首次下载需要访问 npm、Electron 发布源和 electron-builder 工具下载源。生产启动不需要开发服务器。图标已随源码提供；需要重绘时可用 Pillow 执行 `python scripts/make-icon.py`。

## 目录

```text
src/
  main/        窗口、安全 IPC、应用服务、本地提醒
  preload/     只暴露白名单 API
  renderer/    React 主窗口、编辑器、设置和主题
  calendar/    离线农历黄历、节气节日、官方放假与调休表
  caldav/      受控网络、发现、DAV XML 和同步引擎
  ical/        完整 ICS 修改、重复实例、时区定义
  database/    SQLite 实体、迁移、事务、操作队列
  security/    凭据加解密抽象
  shared/      类型契约、Zod 校验、错误和脱敏
tests/         可控 DAV 服务器、单元与集成测试
scripts/       开发/构建、图标生成、Electron 冒烟
docs/          设计和验证记录
build/         应用图标
release/       安装包、便携版和解压版
```

详见 [验证记录](docs/VALIDATION.md) 与 [第三方许可](THIRD_PARTY_NOTICES.md)。
