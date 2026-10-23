# 时序日历：Electron → Tauri 2 迁移与换机接续计划

更新日期：2026-10-23，Asia/Shanghai。

**文档状态：Tauri 2.0.0 迁移进行中。** Electron 1.3.0 保留为稳定基线；隔离的 Tauri `2.0.0-alpha.1` 已能构建并运行部分完整业务流程。下面的阶段验收清单仍是正式 2.0.0 的完成条件。

## 1. 从哪里继续

| 项目 | 已核实状态 |
| --- | --- |
| 公开仓库 | https://github.com/xiaomohaa/shixu-calendar |
| 接续开发分支 | `edit` |
| 计划所依据的代码 | `1c44d58`，标签 `v1.3.0` |
| 现有稳定版 | [Electron 1.3.0](https://github.com/xiaomohaa/shixu-calendar/releases/tag/v1.3.0) |
| 目标平台 | 首先完成 Windows 10/11 x64；本轮不扩展其他平台 |
| 推荐技术方向 | Tauri 2 + 现有 React/Vite/TypeScript 界面 + Rust 原生后台 |
| 本轮目标 | 将全部现有功能移植为 Tauri 2.0.0，显著减小安装包并保留数据完整性 |
| 明确不做 | 天气、新一轮 UI 重设计、会议邀请/OAuth 等原先未支持的功能 |

下一台电脑先完成第 3 节，再按第 7 节的 M0 顺序推进。先证明原生构建、关键依赖和数据兼容可行，再批量迁移。

### 已确认的用户要求

- 不继续以 Electron 的大体积作为长期方案，优先迁移到 Tauri。
- 保留 1.3.0 按 macOS 日历参考实现的界面：灰色侧栏、大号深色年月、日期居中、较深文字、浅色胶囊和紧凑彩色点。
- 保留农历、黄历、中国大陆节假日和调休；假期表目前仅核对到 2024–2026 年，未收录年份不猜测。
- 英文/数字使用 SF Pro（San Francisco），中文使用苹方。`fonts/` 原始素材按用户要求保留在公开仓库；分发许可说明见 `fonts/NOTICE.md`。
- 关闭窗口默认收纳到系统托盘，继续同步和提醒；提供彻底退出与可选开机自启。
- 保留内置检查更新、按需下载、进度/取消、显式安装及稍后处理。
- 天气暂不加入，不显示天气占位入口。

## 2. 当前可用基线与体积

Electron 45.0.0，React、TypeScript、Vite、FullCalendar 6.1.20、SQLite、tsdav、ical.js、Luxon、lunar-typescript。准确版本以 `package-lock.json` 为准，换机使用 `npm ci`，不要无目的升级全部依赖。

1.3.0 已完成 60 项单元/协议/同步测试、34 项正式 EXE 界面检查、26 项密集日程/缩放检查。后者包含 321 个实际本机 DAV 资源、67%–200% 页面缩放、连续 48 次尺寸变化、四视图往返四轮和跨月全天事件拖动。报告见 `docs/build-info.json`、`docs/VALIDATION.md` 和 `docs/resize-smoke-result.json`。这些是 Electron 基线结果，不代表 Tauri 已通过同样验收。

实测体积，注意压缩前后口径不同：

| 内容 | 实测大小与口径 |
| --- | --- |
| 1.3.0 Setup | 142,350,824 字节，约 142.35 MB，安装包 |
| Electron 主 EXE | 249,797,632 字节，约 249.8 MB，解压后 |
| 全语言目录 | 约 51.2 MB，解压后 |
| 应用实际引用的字体 | 约 37.1 MB，解压后，SF Pro + 三个苹方 WOFF2 |
| ASAR 中运行依赖 | 约 55.8 MB，含已经进入 bundle 的部分重复依赖 |
| 其中 lucide-react | 约 26.1 MB，完整包被带入，界面实际只需要所引用图标 |

Tauri 安装包可先把 **30–50 MB 作为验证目标**，这是保留当前字体情况下的工程目标，不是已经测得的结果。最终同时记录安装包、安装目录、运行时前提三种口径。若额外捆绑完整 WebView2 离线安装器，体积会重新显著上升。

## 3. 换电脑后先做什么

### 3.1 拉取接续分支

在新电脑选择自己的工作目录执行，不要求复用旧电脑的绝对路径：

```powershell
git clone --branch edit https://github.com/xiaomohaa/shixu-calendar.git
cd shixu-calendar
git status
git branch --show-current
git log -3 --oneline
```

已有仓库时先检查工作区，保留本地修改，再执行：

```powershell
git fetch origin
git switch edit
git pull --ff-only origin edit
```

不使用 `reset --hard`、强制推送或删除本地目录来解决分支问题。`main` 和 `v1.3.0` 是回退基线；本次计划不修改稳定版发布。

### 3.2 准备 Windows 开发环境

1. Git、Node.js 24 x64 与 npm。旧电脑验证用 Node 24.18.0；首先复现 lockfile 对应环境。
2. Rust stable，目标 `x86_64-pc-windows-msvc`；具体最低版本以选择的 Tauri 2/插件版本为准，初始化时锁定工具链和 Cargo.lock。
3. Microsoft C++ Build Tools，选择“使用 C++ 的桌面开发”、MSVC x64 工具链与 Windows SDK。
4. Microsoft Edge WebView2 Evergreen Runtime。旧电脑检测到 155.0.4283.62；不能据此假设新电脑已安装。
5. GitHub CLI 可选，用于后续推送/发布；新电脑需要自己的授权，旧电脑的 keyring 登录状态不会跟着 Git 仓库复制。

检查命令：

```powershell
node --version
npm --version
git --version
rustc --version
cargo --version
rustup show active-toolchain
```

旧电脑当前终端未发现 `cargo`/`rustc` 命令；Tauri 本机构建尚未验证。新电脑要实际编译一次最小 Rust/Tauri 窗口，不能以安装了软件就当作环境已通过。

### 3.3 先复现现有程序

```powershell
npm ci
npm run typecheck
npm test
npm run build
npm start
```

若 Electron 下载被安装策略跳过，执行 `node node_modules/electron/install.js` 后再启动。上述命令此时仍运行 Electron，目的是建立可比较基线。

`npm run smoke`、`npm run test:resize`、`npm run test:updater` 使用本机网络和隔离测试数据；终端/代理/沙箱必须允许 `127.0.0.1`。网络访问被拒绝不能算作协议回归失败，也不能跳过后声称通过。

### 3.4 仓库与本地文件的边界

- Git 已包含源码、lockfile、图标、字体原始素材、截图和验证报告。
- `node_modules/`、`release/`、`dist/`、`.smoke-data/`、数据库与实际账户数据不在仓库中，新电脑需要重新构建。
- 真实账号密码、GitHub 凭据、更新签名私钥和数据库备份不能提交到公开分支。
- 现有“备份设置”功能只备份偏好，不备份账户、日程或凭据；不能把它当成完整数据迁移。

## 4. 代码迁移地图

| 现有位置 | 当前职责 | 迁移方向 |
| --- | --- | --- |
| `src/renderer/` | React 界面、月网格、编辑、设置 | 尽量复用，不重新设计布局 |
| `src/calendar/` | 农历/假期/日程按日分组 | 保留纯 TypeScript；复用现有边界测试 |
| `src/shared/contracts.ts` | Zod、Api、设置/账户/事件类型 | 作为迁移契约；Rust 端也独立校验输入 |
| `src/shared/updates.ts` | 更新状态与桌面状态类型 | 尽量保留界面语义，替换平台实现 |
| `src/preload/index.ts` | `window.shixu` 的 Electron IPC 适配 | 新增 Tauri 适配层，避免逐个改写所有 UI 调用 |
| `src/main/index.ts`、`desktop.ts` | 窗口、IPC、托盘、自启、通知、退出 | Rust/Tauri 生命周期与窄权限命令 |
| `src/database/store.ts` | 同步 `node:sqlite`、schema v1、事务/队列 | Rust SQLite 存储层；沿用 schema 的语义与约束 |
| `src/main/service.ts`、`src/caldav/` | 账户、网络、同步/冲突和条件写入 | Rust 后台持有凭据、请求和事务；逐项迁移 |
| `src/ical/events.ts` 等 | ICS 完整读改、重复/时区展开 | 优先验证复用纯 JS 引擎的 Worker 方案，见下文 |
| `src/security/vault.ts`、safeStorage 注入 | Windows 加密后的 base64 密文 | 新增版本化的 Rust 凭据格式及迁移适配 |
| `src/main/update-controller.ts` | 更新状态机 | 可复用行为/测试设计；平台驱动必须替换 |
| `src/main/updates.ts` | electron-updater 驱动 | Tauri updater 与更新签名 |
| `scripts/` | Electron 构建、安装、发布与 Playwright 验收 | 保留旧入口用于基线；新增独立 Tauri 命令 |

### 推荐架构边界

- React 继续只访问明确的业务 API。保留现有 Api 的方法及事件语义，新增平台适配入口，不让组件调用任意 SQL、任意路径或任意网络代理。
- Rust 后台负责账号密码、HTTP/TLS、SQLite、队列事务、同步状态、系统托盘和安装流程。Tauri capabilities 按命令开放，不给前端全盘文件/系统 shell 权限。
- `ical.js`、Luxon 的纯 JS 能力已积累较多兼容测试，先在受限 Web Worker 中验证复用。替换 `node:crypto.randomUUID` 为适用的 Web Crypto/注入 UUID；保留原始 ICS 和未知字段。
- Worker 仅负责解析、展开和变换数据，不接收账户密码、不直写数据库。Rust 控制资源版本、ETag、提交时机和取消；变换结果须对应请求 ID/资源版本，失败或过期时不提交。
- 同步中隐藏窗口时仍需保留 WebView/Worker；关闭到托盘不能销毁它们。Worker 崩溃、超时和退出时的待处理任务必须可取消，避免一半写入。
- 如果 Worker 路线在 M0 无法满足后台可靠性，才比较 Rust ICS 库的完整性与许可，记录替代决定后再推进。不能用只支持简单 DTSTART/RRULE 的实现悄悄替换已有能力。
- 正式包不附带 Node/Electron sidecar。开发阶段可保留 Electron 基线，但不能靠隐藏的 Node 运行时宣称已经完成轻量化迁移。

建议新增 `src/platform/`、`src/workers/`、`src-tauri/`。暂时保留旧实现直到对应模块通过验收，再清理 Electron 依赖。首次建立 Tauri 时补充 `.gitignore` 中的 `src-tauri/target/` 等生成目录，提交 Cargo.lock 和确定的工具链版本。

## 5. 数据与密码迁移必须先验证

### 5.1 旧数据库

旧版通常使用 `%APPDATA%\时序日历\calendar.db`；实际路径以旧版的 `app.getPath('userData')` 为准。测试可由 `SHIXU_DATA_DIR` 覆盖。Tauri 的默认目录不会自动与 Electron 相同，要显式定义与记录迁移路径。

当前 SQLite `user_version=1`，表包括 accounts、calendars、event_resources、pending_operations、sync_state、conflicts、settings、reminders。必须保留原始 ICS、UID、URL、ETag、dirty/deleted 标记、操作版本、冲突双方内容和同步令牌。只重下载服务器日程会丢失离线修改，不能作为迁移方法。

默认流程：

1. 确认旧应用已彻底退出。关闭到托盘不等于退出；禁止两套应用同时写同一份数据库。
2. 在私有位置备份完整用户数据目录。应用仍运行时不能只复制主 `.db` 而忽略 WAL；如必须在线备份，使用 SQLite 的一致性备份方式。
3. 首先把副本迁移到独立 Tauri 测试目录。检查 schema、记录数、队列/冲突内容和 ICS 摘要，源数据保留不改。
4. 完成账户重新授权/密码迁移后才允许同步；先处理旧队列，防止首次全量下载覆盖本地版本。
5. 新版数据写入新格式后，回退旧版必须使用迁移前的独立备份，不能让旧版直接打开不兼容的新库。

开发隔离包先使用独立 identifier/名称/安装目录和数据目录，例如 `cn.shixu.calendar.tauri.dev`。不得直接替换正常运行的稳定版来试迁移。

### 5.2 同机升级和换机不是同一件事

现有 Vault 将 Electron 45 异步 safeStorage 返回的密文编码为 base64，存入 accounts.password。不能因为底层涉及 Windows DPAPI，就假设 Rust 的 `CryptUnprotectData` 能直接处理完整 Electron 密文；要检查相应版本的封装、关联状态和测试向量。

- **同一电脑、同一 Windows 用户**：用合成测试账户验证解密兼容。若需旧版协助转换，只采用受控的一次性本机迁移通道，新格式落盘前加密，不写明文密码文件/日志，不经公共仓库或远程服务中转。
- **另一电脑或 Windows 用户**：不保证旧密文可解密。默认保留账户元数据、缓存、离线队列，提示重新输入密码，再恢复同步。开发换机也遵守这一点。
- 新凭据存储默认先验证 Windows 原生用户级 DPAPI 方案，格式带版本标识；可采用单独凭据表/记录引用，避免把新密文伪装成旧 safeStorage 字段。
- 解密失败不能删除账号、离线队列或冲突，不能降级到明文存储，也不能显示虚假的同步成功。

## 6. 更新与安装兼容路线

### 两套更新协议分别处理

当前 Electron 使用 electron-updater、`latest.yml`、Setup EXE 和 blockmap。Tauri updater 使用自己的 JSON 清单、公钥与更新签名；需要生成对应更新产物/`.sig`。更新签名与 Windows Authenticode 代码签名不是同一件事。Tauri 更新签名不可关闭，现有“未签名 Windows EXE”不能替代这项签名。

后续实现时：

- 配置 `createUpdaterArtifacts`，在客户端嵌入更新公钥，私钥/密码仅进入私有构建环境或 GitHub Secrets，并在换机前后妥善备份。
- 使用固定 HTTPS 源、校验版本与签名；维持用户主动下载/安装、进度、失败重试、稍后处理，普通退出不自动安装。
- 安装前禁止新写入、停止同步/Worker 任务、关闭数据库，然后启动安装器。
- 重新写 Tauri 发布脚本，先上传 draft 的完整 EXE/签名/清单，再公开。现有 `npm run release:publish` 只适用于 Electron，不能直接复用。

### 第一版跨框架迁移的默认策略

先提供 **手动安装与数据迁移**；Tauri → Tauri 的应用内更新要在正式发布前验证。Electron → Tauri 的无缝自动升级不作为第一阶段已承诺能力。

开发/预发布期间保留 Electron 1.3.0 的稳定更新源。新架构候选版建议使用 `2.0.0-alpha.*` 预发布，暂不改当前 package.json 版本，直到真正进入候选版构建。

推荐先为 Tauri 使用独立固定清单，例如后续提交到 `main` 的 `updates/tauri-windows-x86_64.json`，客户端读取对应固定 HTTPS 地址，清单的下载 URL 指向不可变的 Release 标签资源。该清单现在不存在，需要在发布阶段实现和验证。

第一版 Tauri 即使成为正式版，也先不标为 GitHub `latest`，让旧 Electron 客户端仍能读取有效的 1.3.0 更新元数据；README 以明确版本链接引导原生版安装。若以后切换仓库的 latest，先提供并测试旧客户端兼容策略，否则旧 updater 会找不到 `latest.yml`。不能把 Tauri 安装包直接填进旧清单就假设兼容。

最终产品可继续使用 `cn.shixu.calendar`，但相同 identifier 不等于两套 NSIS 的卸载 GUID、安装参数或升级关系相同。需验证现有安装路径、自定义路径、快捷方式、卸载键、自启项及同名进程处理。旧版安装测试曾表明同名程序处理需要小心；隔离测试应用应使用不同可执行文件名，避免安装器结束用户正式进程。

## 7. 分阶段任务与完成条件

每阶段提交小而可回退的变更，完成后在本文第 10 节更新状态与证据路径。仅创建目录或出现窗口不算迁移完成。

| 阶段 | 要做的修改 | 完成条件 |
| --- | --- | --- |
| M0：环境与可行性 | 新电脑复现 Electron 基线；最小 Tauri Windows 构建；验证 SQLite、凭据格式、Worker ICS 和更新签名 | 实际可执行文件运行；依赖/版本锁定；记录空壳/含字体体积、原凭据可否迁移及 ICS 路线选择；不写真实数据 |
| M1：外壳与接口 | 建立 `src-tauri/` 与平台 Api 适配，复用 React；原生窗口、单实例、主题/导航限制 | 真实 Tauri 窗口加载现有 UI；无 Electron/Node runtime；IPC 来源/参数/权限验证通过；未连接时保持诚实空状态 |
| M2：存储与迁移 | Rust SQLite/事务、旧库副本导入、新凭据格式、偏好与备份 | 缓存/队列/冲突/ETag 完整；同机及换机密码失败路径清晰；事务失败回滚；源库不变 |
| M3：DAV 与 ICS | 真实 Rust HTTP/TLS、发现、增量/回退、条件 PUT/DELETE、取消；接入 Worker/ICS 引擎 | 原有协议/ICS corpus 在新后台验证；离线队列重启恢复、412 冲突、未知字段和重复例外保留；无裸写覆盖 |
| M4：桌面行为 | 托盘、关闭/退出、通知、自启、`--hidden`、唤起、并发退出 | 关闭后继续运行，退出安全；自启默认关闭、可取消、系统禁用状态可见；通知和单实例实际验证 |
| M5：打包与更新 | WebView2 检测、原生安装器、Tauri 签名更新、发布清单/脚本、体积清理 | 两个隔离版本真实下载/签名校验/安装/重启/数据保留通过；网络失败、取消、签名错误被正确处理 |
| M6：回归与交接 | 新 UI 自动化、迁移/安装矩阵、大小/性能报告、README/许可整理 | 满足第 8 节全部适用项；实际新电脑从源码构建成功；发布候选验收后才讨论稳定切换 |

M0 先验证困难点，避免只把 UI 搬到空壳就宣布完成。正式网络和数据能力未实现的按钮要明确禁用/说明，不用假成功或演示账户替代。

## 8. 验收清单

### 数据与协议

- [ ] 不依赖 Electron/Node sidecar 启动和同步，包内没有 node_modules 全量目录或额外浏览器内核。
- [ ] Basic 认证发现、principal/home-set/具体日历地址、同源凭据限制、TLS 系统信任有效；不提供忽略证书选项。
- [ ] sync-collection 增量、无支持/失效令牌回退、multiget、远程删除、取消与重试保持一致。
- [ ] 新建 If-None-Match、修改/删除 If-Match、ETag/UID/URL 稳定；无 ETag 不无条件覆盖；412 保留双方。
- [ ] RRULE/RDATE/EXDATE/RECURRENCE-ID、全天排除结束、DST/浮动时间、VTIMEZONE、未知 ICS 属性保留；原有复杂例外限制不悄悄取消。
- [ ] 带未同步 put/delete 和冲突的旧库副本迁移后内容可比对；崩溃/退出/离线重启不丢队列。
- [ ] 换机后密码解密失败仅要求重新授权，缓存/离线修改仍可访问，日志和 IPC 无密码或密钥。

### 界面与桌面

- [ ] 四视图、编辑器、搜索、颜色/可见性、时区、偏好、主题、设置备份/恢复实际工作。
- [ ] 321 日程、67%–200% 缩放、48 次尺寸变化、四视图四轮往返；日程不越界，日期居中，缩放不重复查询缓存。
- [ ] 不重新调用 FullCalendar 的旧月视图再切到新网格；保持 `MonthGrid` 的固定行列和独立尺寸观察。
- [ ] 圆点/胶囊/+N、完整列表、长标题、200% 下详情滚动、键盘焦点、跨月拖动/跨日拖选可用。
- [ ] 农历黄历/休班/未知年份提示离线可用，SF Pro/苹方真正加载；没有天气占位或外部天气请求。
- [ ] 托盘收纳/恢复/彻底退出，第二实例唤起，自启开/关及隐藏启动通过；写入/同步中退出不损坏库。

### 打包与更新

- [ ] 有 WebView2 的电脑可安装运行；没有运行时的干净 Windows 环境能检测并按设计补装，安装前说明其联网需求。
- [ ] 默认使用系统 Evergreen 与小型引导方式，不为追求“离线单包”重新捆绑完整固定版 WebView2；离线包另列体积。
- [ ] 两个 Tauri 测试版本完成真实升级、签名拒绝、取消重试和数据保留；更新私钥不在仓库/客户端/日志中。
- [ ] Electron 与 Tauri 更新清单互不误投；同名快捷方式/安装路径/自启/卸载关系已实测。
- [ ] 输出安装包与安装目录体积表；保留现有字体目标 30–50 MB，若未达到，说明分项原因，不伪造指标。
- [ ] 安装测试使用不同 appId、可执行文件名、目录与数据；记录未验证的 Windows/DPI/通知边界。

现有 Playwright `_electron` 脚本不能直接证明 Tauri 可用。复用 DAV fixture 和业务断言，补充 Tauri/WebView2 对应驱动（如 tauri-driver + 匹配的 Edge WebDriver）及原生窗口测试，区分渲染测试、真实后台测试与真正安装升级。

## 9. 体积优化顺序

1. 去掉 Electron、完整 Chromium、Node runtime 和重复运行依赖，而不只调整压缩等级。
2. 前端继续 tree-shaking，Lucide 只进入实际使用图标；库源码、类型、测试文件、source map 不进入正式包。
3. Rust 采用 release 构建，评估 LTO、strip、合理 features；以真实功能回归验证裁剪，不能删掉 TLS/时区/同步能力来制造小包。
4. `fonts/` 全部原始文件继续留在公开源码中；安装包只带界面实际使用的字体，避免 TTF/WOFF2 和同字重重复打入。
5. 字体子集化是后续可选项，中文日程可含任意姓名/地名，不能只保留当前截图字形；需保证回退与缺字测试。不得通过删除中文覆盖来宣称功能不变。
6. 先报告实测，再决定是否进一步精简字体。压缩包大小、展开大小、共享 WebView2 的系统占用分开统计。

## 10. 接续任务记录

- [x] 迁移方案与换机文档编写。
- [ ] M0 环境/可行性：已复现 Electron 基线、最小 Tauri 构建、SQLite、同机凭据格式及真实 WebView2 Worker ICS；更新签名验证待完成。见下方记录。
- [ ] M1 外壳与 Api：真实 React 界面和部分只读/偏好 API 已在隔离 Tauri 预览中运行；完整业务 API、安全及桌面生命周期待完成。
- [ ] M2 存储/凭据迁移：旧库副本、原生快照、设置、DPAPI 与账户保存已开始；正式迁移流程及全量事务回归待完成。
- [ ] M3 同步/ICS：CalDAV 拉取、条件写入、离线队列、412 冲突及事件编辑已接通，并通过本机集成测试；更广泛的服务器兼容、取消和复杂 ICS 回归仍待完成。
- [ ] M4 桌面行为：尚未开始。
- [ ] M5 打包/更新：尚未开始。
- [ ] M6 全量回归与稳定候选：尚未开始。

每阶段补充：提交 SHA、环境版本、执行命令、成功/失败结果、证据文件、体积、下一步。测试产生的真实数据和密钥仍留在忽略目录/私有位置，不随记录上传。

### 2026-10-23 M3 本机进度

- Rust CalDAV 客户端已实现同步令牌增量拉取、全量回退、`calendar-multiget`、条件 `PUT`/`DELETE` 和远端 `GET`。SQLite 事务处理脏资源、远端删除与冲突；同步令牌仅在同一缓存事务成功后更新。
- 原有 `ical.js` 编辑逻辑在 Web Worker 中运行，已接入事件新建、详情、编辑、单次例外删除与整系列删除；Rust 对资源版本和可写日历做提交前校验。
- 本机 WebView2 + CalDAV 测试服务器通过账户发现、Windows DPAPI 密文、首次/增量拉取、远端删除、条件写入、412 冲突保留、保留双方、事件新建/详情/编辑/删除、清缓存和删账户。
- `npm run typecheck`、`cargo test --lib --quiet`、`npm run test:tauri-account` 均通过。测试使用隔离数据目录和合成账户，不包含真实凭据。
- `2.0.0-alpha.1` 开发预览 NSIS 安装包为 **29,264,239 字节（27.91 MiB）**，含当前实际引用的 SF Pro 与三份苹方字体。正式 2.0.0 的体积仍需在全部桌面及更新功能接入后重新测量。

### 2026-10-23 接续电脑 M0 进度

- 分支 `edit`，接续点 `bb7897b`；工作区从公开仓库克隆，未接触真实用户数据库。
- Node.js `v24.11.1`、npm `11.6.2`；检测到 WebView2 `155.0.4283.62`。通过 winget 安装 Rustup，已核对 `rustc 1.99.1`、`cargo 1.99.1`、`stable-x86_64-pc-windows-msvc`。
- Visual Studio C++ Build Tools 安装器返回退出码 1。`vswhere -all` 显示已有 BuildTools 实例处于不完整、不可启动状态（`state=13`、`isComplete=false`），未找到 `cl.exe`；Windows SDK 库目录也未找到。需先修复本机安装，再进行 Tauri 原生编译；目前未声称 Tauri 构建成功。
- 随后用户完成 C++ Build Tools 安装；本机识别到 MSVC `14.44.35207` 和 Windows SDK `10.0.26100.0`。新增隔离 identifier `cn.shixu.calendar.tauri.dev` 的最小 Tauri 2 测试项目，Cargo 锁定 412 个依赖包；使用 `npx tauri build` 完成 release 构建。原生测试 EXE `8,877,056` 字节，NSIS 安装包 `1,920,848` 字节。实际启动后窗口标题为“时序日历 Tauri 可行性测试”。它使用独立的测试页面，没有携带现有字体或业务功能，只证明工具链、WebView2 和打包链路可用，不能作为日历迁移完成或 30–50 MB 目标的实测值。
- 用户明确要求完整功能作为新的 **2.0.0** 版本。Tauri 开发包版本先标记 `2.0.0-alpha.1`，沿用隔离 identifier；旧 Electron 1.3.0 的根 `package.json` 版本和稳定发布不动。正式功能验收后再改为 2.0.0。
- Rust SQLite 存储层已按旧 schema v1 建表，并用 SQLite backup API 从只读旧库复制到隔离目录。合成测试确认原始 ICS、密码密文、待同步操作和冲突记录完整，源库不变。这是 M2 的起点，尚未接入完整业务 API，也未试真实用户数据。
- 新增 `src/platform/tauri.ts`，在 Tauri WebView 中将既有 `window.shixu` 方法映射为同名原生命令，并复用变更/更新事件语义；Electron preload 仍保留用于旧版回归。
- 原生命令端已开始接线：独立 Tauri 数据目录中的 Rust SQLite 提供账户、日历、冲突、队列数量和偏好快照（不回传密码字段）；偏好写入校验所有字段、IANA 时区和默认日历，日历显隐/颜色写入校验参数。其他业务方法仍明确返回“尚未开放”，正式 UI 仍不装入测试包。隔离 Rust 测试验证原有数据复制、快照无密文、无效设置不覆盖数据、日历显示设置持久化；`cargo check` 与 `npm run typecheck` 通过。
- 使用 `.smoke-data/` 内合成账户验证旧凭据封装：`accounts.password` 的 base64 解码结果以 `v10` 开头，Electron `Local State` 的 `os_crypt.encrypted_key` 解码后以 `DPAPI` 开头。当前 Windows 用户用 DPAPI 解出 32 字节密钥，再以 AES-256-GCM 解开 `v10` 的 12 字节 nonce、密文和 16 字节 tag，结果与仅用于冒烟测试的合成密码匹配；测试只输出布尔结果，不打印明文或密钥。这证明同机兼容路线可行，真实数据迁移仍未完成。异机仍需重新输入密码。
- Rust `vault.rs` 已实现 `dpapi:v1:` 新凭据格式和旧 Electron `v10` 同机读取。DPAPI 输出缓冲复制后擦除，Rust 临时密钥/明文使用 `Zeroizing`；无效新密文被拒绝。独立 Rust 测试用合成凭据验证新格式往返，并用实际 Electron 45 冒烟目录在当前 Windows 用户下验证旧密文解密；测试输出只有通过/失败，不输出密码或密钥。尚未将它接到账户保存和正式迁移流程，异机旧密文继续走重新授权路径。
- ICS 引擎已去除 `node:crypto` 运行依赖，改用 Web Crypto UUID。Tauri 前端将 Rust 提供的可见资源及冲突标记交给模块 Worker 解析，Worker 沿用现有 `ical.js` 重复逻辑，遇到单个损坏资源时保留其他事件并给出诊断。`npm run test:ics-worker` 在本机 Edge Chromium 实际运行模块 Worker，验证两次重复实例、待同步标记及无诊断；`npm test` 60 项、`npm run build`、Rust 测试与 `cargo check` 通过。Edge 结果尚不能代替 Tauri WebView2 验证，且账户/同步写入尚未接通。
- 隔离 `tauri.ui-preview.conf.json` 将原有 React UI 与全部实际引用字体装入 Tauri WebView2；与最小测试包使用不同 identifier，测试数据通过 `SHIXU_TAURI_TEST_DATA_DIR` 指向 `.smoke-data/tauri-ui-run`，没有读取正常用户目录。首次 `npm run tauri:ui-preview` 成功，NSIS 安装包 `28,600,221` 字节（27.28 MiB）；这是有 UI/字体但未含全部业务功能的预览大小，不是最终 2.0.0 大小。通过 WebView2 调试协议检查真实窗口、空账户引导和 Worker 目标；写入隔离合成账户与两次重复的 ICS 后，真实 Tauri 页面返回 1 个账户、2 个事件，快照不含合成密码，月网格实际显示两个日程胶囊。截图留在忽略目录 `.smoke-data/tauri-ui.png`。该次预览尚无账户/DAV 写入、托盘、自启、更新和安装升级，不能将安装包作为完整日历交付。
- Rust `dav.rs` 已开始取代 `tsdav` 运行时：本机 DAV 测试验证 Basic 认证的 PROPFIND、成功 `propstat`、直接日历发现和 URL 限制。真实隔离 Tauri WebView2 使用现有 DAV fixture 验证 principal/home-set 发现、账户保存事务、`dpapi:v1` 密文落盘、快照不泄漏密码、错误密码 401 和无密码重命名保留原凭据。`npm run test:tauri-account` 通过。加入 HTTP/XML 后预览 NSIS 为 `29,162,977` 字节（约 29.16 MB）；仍非完整功能体积。同步拉取/写入及旧账户正式迁移尚未实现。
- `npm ci` 成功；`npm run typecheck` 成功；`npm run build` 成功。构建输出的四个字体文件约 37.1 MB，后续 Tauri 包体积统计仍需单独实测。
- `npm test` 首次在受限沙箱内有 12 项因 `connect EACCES 127.0.0.1` 失败；允许本机回环连接后重跑，60/60 通过。这是测试环境网络权限所致，未修改协议代码。
- `npm run smoke` 在允许窗口与本机回环连接的环境中通过 34 项，包括实际 DAV 请求、加密凭据、托盘收纳、字体和四视图。报告由脚本生成在既有验证位置；结果仅代表 Electron 基线。
- 尚未完成：更新签名验证。M0 不能标为完成；后续业务接入继续使用隔离数据目录。

## 11. 可以直接发给下一台电脑上的 Codex

> 在 xiaomohaa/shixu-calendar 的 edit 分支继续时序日历开发。先读取 docs/TAURI_MIGRATION_PLAN.md、docs/VALIDATION.md、PRODUCT.md、DESIGN.md 和 package-lock.json。当前代码仍是 Electron 1.3.0，Tauri 迁移尚未实现。目标是 Tauri 2 + 现有 React UI + Rust 原生后台，减少安装体积；保留同步、离线队列、凭据保护、托盘、自启、更新、农历黄历和现有缩放修复，不加入天气。先完成计划 M0：核对新电脑工具链、复现旧版、实际构建最小 Tauri、验证 SQLite/凭据/ICS 方案并记录结果，再按 M1–M6 推进。不要把出窗口当作完成迁移，不引入 Node sidecar，不覆盖真实用户数据库，不假设换机后旧密码能解密。先在隔离安装/数据目录测试；保持 main 和 v1.3.0 可回退。

## 12. 参考与已知验证边界

官方资料于 2026-10-23 核对，实施时按选定版本再次确认：

- [Tauri Windows prerequisites](https://v2.tauri.app/start/prerequisites/)：Rust/MSVC、C++ Build Tools、WebView2。
- [Tauri Windows installer](https://v2.tauri.app/distribute/windows-installer/)：系统 WebView2 与各分发模式的体积取舍。
- [Tauri updater](https://v2.tauri.app/plugin/updater/)：独立更新清单、必须的更新签名、产物和密钥管理。
- [Tauri SQL](https://v2.tauri.app/plugin/sql/)：可选数据库基础能力；本计划仍要求 Rust 业务边界，不向 UI 暴露任意 SQL。
- [Tauri system tray](https://v2.tauri.app/learn/system-tray/) 与 [autostart](https://v2.tauri.app/plugin/autostart/)：桌面行为接入。
- [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)：需按当前项目 Electron 45 的实际接口/数据格式核对，不能盲用更新版本文档改变旧密文处理。

源代码入口：`src/main/index.ts`、`src/database/store.ts`、`src/security/vault.ts`、`src/caldav/`、`src/ical/`。界面/缩放背景见 `docs/MONTH_UI_DESIGN.md`；旧更新/退出语义见 `docs/UPDATE_DESIGN.md`。
