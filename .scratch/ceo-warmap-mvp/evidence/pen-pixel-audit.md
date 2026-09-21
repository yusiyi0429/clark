# CEO WarMap · UpgradeDesign.pen 像素级一致性验收审计

**结论：验收未通过（FAILED）。**

以 `UpgradeDesign.pen`（v2.18，纯 JSON）为唯一视觉基线，当前 `apps/web` 在 **2560×1440**（pen 画布原生尺寸）下的**页面级栅格、面板材质、组件几何、字号层级**四类均存在系统性偏差。P0/P1 未清零前，任何整页截图都无法判定为与 pen 一致。

**计数：P0 = 6 · P1 = 30 · P2 = 29**（P1 中 3 项为待验证状态：I-07 / M-07 / P-06；P2 仅记录，不阻塞）。

审计对象：工作区当前未提交状态（`git status --short` = 69 个改动文件，分支 `main`，HEAD `f902c24`）。本报告只描述**当前状态**，不建议回退任何他人改动。

---

## 1. 方法与限制（先读）

| 项 | 说明 |
| --- | --- |
| 视觉基线 | `UpgradeDesign.pen`，Python 只读解析，未编辑 |
| 设计令牌 | `bg #F5F5F7`、`surface #FFFFFF`、`ink #1D1D1F`、`ink2 #5A5A60`、`ink3 #6E6E73`、`line #E6E9ED`、`accent #007AFF`、`red #E34B43`、Inter |
| 实测环境 | `https://localhost/`（Caddy 本地 CA；`http://localhost` 会自动升级），口令 `202609`，真实 API + 真实 Postgres，无 mock |
| 实测手段 | Chrome DevTools MCP：`evaluate_script` 取 DOM 直接文本 + `getBoundingClientRect()` + `getComputedStyle()`，与 pen JSON 的 `x/y/width/height/fill/stroke/cornerRadius/padding/gap/fontSize/fontWeight` 逐项对齐；DB 仅只读 `SELECT` |
| **限制 1：无法看图** | 本模型不支持图像输入，`take_screenshot` 结果被丢弃；MCP 也禁止写 `/tmp`（"not within any of the configured workspace roots"）。**所有差异均由 DOM/计算样式/文本与 pen 数值推导**，非人眼比对。人工复核命令见 §6 |
| **限制 2：验收视口未裁决** | pen 画布 2560×1440；`docs/technical/ceo-warmap/06-Web像素级重构.md` 写 1440×900 / 1600×1000。本报告以 2560×1440 为主（此时 rail 宽 430 与 pen 完全一致），条目中标注"视口相关"。**两套口径必须二选一**，否则 R-01 等条目无法判定 |
| **限制 3：状态不可达** | Issue `decided`、Meeting `held/review`、Monthly `negotiating`、Radar 空态、通知栏空、Access 错误态在现有数据下不可达 → 标记**未验证**（§5）。造这些状态需写库，本次禁止 |
| **限制 4：笔面色板** | 首轮提取脚本只输出纯色 `fill`，漏过渐变填充（已修正重跑关键帧）。若后续看到"pen 无填充"结论，先按渐变复核 |
| 未做的事 | 未改 `apps/web`、`apps/api`、`packages/contracts`、`UpgradeDesign.pen`、数据库、Docker；未 commit/push；未删 legacy `frontend/` |

---

## 2. 差异矩阵

编号首字母：**G** 全局 · **A** Access · **H** Home · **R** Radar · **S** Signal · **I** Issue · **M** Meeting · **P** Plan · **D** 对话 Dock。

### 2.1 全局令牌与栅格

| 编号 / pen 帧 → 路由 | 证据（pen → live 实测） | 级别 | 首个文件 | 最小修复边界 & 验收 |
| --- | --- | --- | --- | --- |
| **G-01** 所有页面帧 `pad=14 gap=14` → `HomeShell` | 2560 下 `@media(min-width:1800px)` 生效：`shell padding=16px gap=16px` | P2 | `styles/app-shell.module.css` | 仅改该断点的 `padding/gap` 为 14；不动 `--notice-width` clamp（430 上限与 pen 一致 ✓）。验收：`mainArea.x=14`、`rail.x=14` |
| **G-02** pen 圆角体系 `面板=20 / 卡片=20 / 按钮输入=10~12 / 圆形=50%` → 全部卡片 | live：`mainArea r=24`、面板 `r=22`、rail `r=29`、story `r=23`、dock `r=26`、Issue workspace `r=22`、按钮 `r=9` | **P1** | `styles/app-shell.module.css`（`--radius-*`）+ 各模块 | 统一四档圆角；不动任何尺寸/间距。验收：关键元素计算 `border-radius` 为 20/20/10/50% |
| **G-03** pen 标题层级：面板 `20/600`、页面 `24~26/600`、章节 `15/600` → 全部标题 | live：面板 h2 `22/600`；Issue h1 `22/600`、章节标题 `22/600`；Monthly h1 `20/600`、章节标题 `16/600`（"公司结果"仅 `11/400`）；Meeting h1 `19px` | **P1** | `styles/app-shell.module.css`（`h2` 的 `clamp(17px,1.3vw,28px)`）→ 逐模块 | 建立 `--type-panel:20/600`、`--type-page:24~26/600`、`--type-section:15/600` 并替换硬编码。验收：三档字号与 pen 一致，同页同层级唯一 |
| **G-04** pen 正文 `14`（判断/长文）、`18`（Signal lead） → 阅读区 | live 判断正文 `19px`、`.reading 16px`、Signal lead `19px` | P2 | `styles/issue-workspace.module.css`、`radar-reader.module.css` | 判断 → 14，lead → 18；不动行高比例。验收：计算 `font-size` 一致 |
| **G-05** pen 页面底 `grad(#F9F8FA→#F7F6F9→#F4F3F7)` → `HomeShell` | live `shell bg=#F5F5F7` + `radial-gradient(…rgba(226,202,238,.28)…)` | P2 | `styles/app-shell.module.css` | 换回三段线性渐变；紫色的 radial 若为品牌动效需产品确认后再删。验收：截图无紫晕 |
| **G-06** pen `Primary Button fill=$accent r=10` → 各主行动按钮 | live Issue「直接决定」`bg=#FFFFFF bd=1px #D9DDE7`（次要按钮样式），按钮 `r=9` | **P1** | `styles/issue-workspace.module.css` + 组件类名 | 主行动按钮恢复 `$accent` 底/白字 + `r=10`；不动 disabled 态。验收：「直接决定」`bg=rgb(0,122,255)`、`r=10` |

### 2.2 Access 登录（`/access`）

pen 帧：`Access 登录`、`Access 登录 · 密码错误`

| 编号 / pen 帧 → 路由 | 证据（pen → live） | 级别 | 首个文件 | 最小修复边界 & 验收 |
| --- | --- | --- | --- | --- |
| **A-01** `Access 登录` → `/access` | pen Lockscreen 仅 `Lock Glyph 30` + `Clock` + `Date` + 表单，无标题；live 有 `region "进入 CEO WarMap"` + `h1 "进入 CEO WarMap"` | P2 | `app/access/AccessScreen.tsx` | 把该 h1 改 `sr-only`（保留 `getByRole('heading')`），不删语义。验收：视觉无大标题 |
| **A-02** 同上 | pen `Brand at 72,56`、`Lockscreen 460 at 1050,400`、`Footer at 1070,1370`；live **未验证**（登录态下 `/access` 重定向，无法复测） | P2 | `app/access/access.module.css` | 待复测后按 pen 数值校正。验收：见 §5 复现 |
| **A-03** `Access 登录 · 密码错误` → `/access` | pen `Password Field stroke=#E34B43` + `Error Text '口令不正确' fill=#E34B43`；live `AccessScreen.tsx:43` 已把 `INVALID_CREDENTIALS` 映射为「口令不正确」 | P2 | `app/access/access.module.css` | **文案已由代码核对通过**；字段描边/提示色未在真实浏览器验证。验收：见 §5 复现 |

### 2.3 首页 Home（`/`）

pen 帧：`首页 Home`、`· 战场进展模式`、`· 通知浮卡打开`、`· 通知栏空`、`· 全局对话展开`

| 编号 / pen 帧 → 路由 | 证据（pen → live 实测，2560×1440） | 级别 | 首个文件 | 最小修复边界 & 验收 |
| --- | --- | --- | --- | --- |
| **H-01** `首页 Home` 通知栏 | pen `Notification Rail grad(#E8EEF8→#E3EAF4) stroke=#FFFFFFCF r=20`；live `bg=rgb(83,100,127)` + 2 层渐变 + `url('/brand/tianshu-notification-wallpaper-v1.webp')`，`r=29` | **P0** | `styles/notifications.module.css` | 代码注释（`:209` "Lock-screen continuity: a wallpaper-backed rail…"）表明是**刻意设计**但与 pen 冲突。二选一：(a) 按 pen 恢复浅色渐变 + `#FFFFFFCF` + `r=20`，删壁纸；(b) 同步更新 pen。**不允许都不动**。验收：截图通知栏为浅色（或 pen 已签字更新） |
| **H-02** 同上 | pen `Rail Lock 30×30 r=15` + `Home Capsule fill=#FFFFFFE6 stroke=#FFFFFF r=12 pad=[8,14] gap=10`（含 `Capsule Mark 18` + 日期/时间两行）；live `homeCapsule 160×42 r=999`、渐变白、无 Mark、单行 | **P1** | `styles/notifications.module.css` + `components/NotificationRail.tsx` | 恢复 `r=12`、`#FFFFFFE6`/`#FFFFFF`、补 `Capsule Mark`；保留现有 DOM 与 a11y。验收：胶囊 `r=12`，截图含品牌标记 |
| **H-03** 同上 | live `railClock` 显示 `"918"` + `"星期五"`；pen `9月17日 星期三`。根因：`NotificationRail.tsx` `clock()` 的 `day: \`${get("month")}${get("day")}\`` 丢掉"月/日" | **P1** | `components/NotificationRail.tsx` | 只改 `day` 拼接为 `9月18日`（与 `AccessScreen` 的 formatter 对齐）。验收：显示 `9月18日` |
| **H-04** 同上 | pen 面板 `fill=$surface #FFFFFF stroke=#FFFFFFED`（平色）；live `bg=transparent` + `linear-gradient(165deg,#FFFFFF 65%,#F7F9FC)`，`border:1px solid #FFFFFF`，`r=22` | **P1** | `styles/home-board.module.css` | `.panel` 改 `background:#fff` + `1px solid #FFFFFFED` + `r=20`。验收：`background-color=rgb(255,255,255)` |
| **H-05** 同上 雷达面板 | pen `fill=#F0F4FA stroke=#FFFFFFD9 r=20 pad=[20,20,16,20]`；live `radarPanel 435×324 r=22`，`linear-gradient(145deg,#DEEDFF,#F5FAFF,#E8E8FC)` | **P1** | `styles/home-board.module.css` | 平色 `#F0F4FA` + pen 描边/圆角。验收：`bg=rgb(240,244,250)` |
| **H-06** 同上 | pen `Scan Stage` 内含 `ref(Scope) 170×170` 扫描盘；live `.stage h=2px`，`h2 雷达信号 at y=162`（面板内垂直居中） | **P1** | `components/HomeBoard.tsx` + `styles/home-board.module.css` | 标题顶对齐 + Stage 占满剩余高度，并把 170×170 Scope 放回 Stage。验收：截图可见扫描盘，标题在顶部 |
| **H-07** 同上 | pen `公司战略议题 Panel`、`公司能力 Panel` 标题下均有 `rectangle Divider h=1 #E6E9ED`；live 两处均无 | **P1** | `components/HomeBoard.tsx` | 两处 h2 后加 `h=1 #E6E9ED`。验收：出现 1px 分隔线 |
| **H-08** 同上 能力面板 | pen `lay=vertical`，标题在上、`Capability Groups gap=36` 横排；live `grid-template-columns:150px 1850px`（标题占左栏） | **P1** | `styles/home-board.module.css` | 移除该面板 grid 两栏改纵向；不动分组内部。验收：标题横跨整行 |
| **H-09** 同上 战略议题行 | pen 行 = `Dot 6×6`（红/黄/灰）+ `Title 15` + `Due 12 #A1443C` + `Arrow 14` + 行间 `Divider h=1 #E6E9ED`，`pad=[10,2] gap=10`；live `.issue` 仅 `Title 16`，无点/箭头/分隔线 | **P1** | `components/HomeBoard.tsx` + `styles/home-board.module.css` | 补 Dot（按 urgency 取色）+ Arrow + 行分隔线，`Title→15`。Due 无数据属数据驱动，不补。验收：截图含色点与箭头 |
| **H-10** 同上 | pen `Top Row h=316`、`Battlefields h=380`；live `.top 324`、`.battlefields 363`、`.rotor/.face 361` | P2 | `styles/home-board.module.css` | 三处高度对齐。验收：316 / 380 |
| **H-11** 同上 工具栏 | pen `Toolbar pad=[0,4]`、`Mode Switch #E9EBEF r=10 pad=3`、`Mode Active #FFFFFF r=6 pad=[6,18]`；live toolbar `pad=0 3px` ✓、switch `r=10 pad=3` ✓、active `r=7 pad=5px 12px` | P2 | `styles/home-board.module.css` | active `r=6 pad=[6,18]`、toolbar `pad=[0,4]`。验收：计算值一致 |
| **H-12** 同上 | pen `HomeBoard gap=14` 无底部内边距；live `.board pad=0 0 88px gap=16` | P2 | `styles/home-board.module.css` | 若 88px 是为 Dock 让位则豁免并记录；否则对齐 pen。验收：需产品确认 |
| **H-13** 同上 通知卡 | pen 卡宽 = rail 内宽 `430−2×17 = 396`，列表内边距 17 均匀；live `.card 386`，`noticeList pad=78px 27px 52px 16px`（左右不对称） | P2 | `styles/notifications.module.css` | 对齐 pen 的均匀 17。验收：卡宽 396、四边 17 |
| **H-14** `· 通知浮卡打开` | pen `Notice Overlay 430×1412 at 14,14 fill=#152A424D r=20 pad=[40,20]` + `Floating Notice Card grad(#FFE5E4→#FFF9F7→#F8E4F0→#F4DDF1) r=20` + `CTA 查看判断与依据 h=48` + `稍后处理 h=48`；live 已实现 `noticeOverlay/floatingCard/floatingHeader/floatingScroll` 且含同文案（`NotificationRail.tsx:80,255,268`） | P2 | `styles/notifications.module.css` | **结构+文案已通过代码核对**；实际尺寸/配色未在浏览器触发（每秒重渲染打断点击）。触发后按 pen 校 `max-width`/圆角/CTA 高度。验收：见 §5 |
| **H-15** `· 通知栏空` | pen 页面帧 `暂无待处理提请`+说明句；pen `规范/交互状态` 组件空态 `本周没有待处理通知。`+`Radar 会按锚点定时扫描，有变化会落到这里。`；live 仅 `本周没有待处理通知。`（无第二行） | P2 | `components/NotificationRail.tsx` | **pen 自身冲突**（两处文案不同）。先由设计裁定；建议采用组件版并补说明句。验收：两行文案与裁定一致 |

### 2.4 Radar（`/radar`）

pen 帧：`Radar 信号流`、`Radar 空状态`、`Radar 监测范围弹窗 · 发布方媒体`

| 编号 / pen 帧 → 路由 | 证据（pen → live 实测） | 级别 | 首个文件 | 最小修复边界 & 验收 |
| --- | --- | --- | --- | --- |
| **R-01** `Radar 信号流` → `/radar` | pen `Radar Feed w=1940 at 310,0`、`Story Row gap=20`、卡 `fill_container`（≈960/张）；live `.feed{max-width:1150px}`（实测 `x=705 w=1150`）、`.stories grid-template-columns:562px 562px; gap:18` | **P0**（视口相关） | `styles/radar-feed.module.css` | 把硬编码 `max-width:1150px` 改为 pen 的 1940 口径（或按主区自适应），`gap=20`。**先裁决验收视口**。验收：2560 下 `.feed` 宽 1940、x=310 |
| **R-02** 同上 状态行 | pen `'扫描中 · 已检索 2 / 4 个锚点 · 定时扫描 2025-09-17 · 上次完成 06:00'`；live `'1 条未读 · 定时扫描 2026-09-18 · 最近一次手动补扫：completed · 上次启动 …'` | P2 | `cards/RadarCard.tsx` | 数据驱动，仅统一字段顺序与措辞。验收：字段集与 pen 一致 |
| **R-03** 同上 工具栏 | pen 两组独立分段控件 `fill=#EEF0F4 r=12 pad=3`、段项 `r=10 pad=[6,13]`、激活 `#FFFFFF`；live 文案齐全（返回首页 / 全部 / 未读 / 最新采集 / 影响优先 / 监测范围 / 手动补扫） | **P1**（几何未验证） | `styles/radar-feed.module.css` | 按 pen 的 `#EEF0F4 r=12 pad=3` + 激活白底 `r=10` 校正。验收：见 §5 复现 |
| **R-04** `监测范围弹窗 · 发布方媒体` → `/radar` 弹窗 | pen `980×1040 fill=#FFFFFF stroke=#E6E9EF r=20`；锚点为纯行列表（Index+Loc/Title/Query `gap=14`）；来源行 `fill=#F7F8FA r=12 pad=[16,18]` + 徽章 `启用 #E8F6EC/#2F7A44`、`未配置 #F1F3F6/#6E6E73`；footer `pad=[20,30]` + `关闭 #F1F3F6 r=12 pad=[10,22]`。live `780×1376 r=28`、`bg=rgba(247,247,248,.973)`、锚点包在白色卡 `r=18` 的两列网格、来源行 `#FFFFFF r=14` 且徽章为**纯文本**（无 pill）、footer `rgba(244,244,245,.95)`、关闭按钮 `r=50%` | **P1** | `styles/radar-config.module.css` | 尺寸 980×1040 / `r=20` / 白底；锚点恢复单列纯行；来源行 `#F7F8FA r=12` + 彩色徽章 pill；footer 与关闭按钮按 pen。**文案与"只读"提示不动**。验收：尺寸与配色逐项一致 |
| **R-05** 同上 文案 | pen `'4 条 · 时区 Asia/Shanghai · 回溯 48h'`、锚点 `Loc='公司'`；live `'7 条 · … · 回溯 48 h'`（数字属数据）、锚点 `'公司 · manual'` | P2 | `cards/RadarCard.tsx` | 修 `48h`；`source==='manual'` 时不拼后缀。验收：无 `manual`、为 `48h` |
| **R-06** 同上 **基线 #1 通过** | live 三源为 `Web 搜索 / 微信公众号 / 发布方级媒体来源`；outlets 行 `'BBC、彭博、路透社、金融时报、CNBC、经济学人 · 只读'`，**未**显示为"微信公众号"。`未配置 Web 来源` 与 DB `radar_config.sources.sites[0].enabled=false` 一致，属真实配置 | — | — | 无差异，作为回归基线保留。验收：outlets 永不出现在"微信公众号"标签 |

### 2.5 Signal 阅读（`/radar/signals/[id]`）

pen 帧：`Signal 阅读`

| 编号 / pen 帧 → 路由 | 证据（pen → live 实测） | 级别 | 首个文件 | 最小修复边界 & 验收 |
| --- | --- | --- | --- | --- |
| **S-01** `Signal 阅读` → `/radar/signals/40a9a919-…` | pen 有独立右栏 `对话 · 本条信号 400×1324 fill=$surface stroke=#ECEEF2 r=20 pad=[18,16]`（Mark 22 + 标题 + 3 条消息 + `Conv Input h=44 fill=#F5F7FA stroke=#E1E4E9 r=22 placeholder='问天枢：本条信号…'`）；live 无该栏，仅全局 Dock | **P1** | `app/radar/signals/[id]/page.tsx` + `styles/radar-reader.module.css` | 加 400px 右栏并把 Dock scope 设为该信号。**需先确认与全局 Dock 规范（`06-Web像素级重构.md §8`）是"替换"还是"并存"**。验收：截图存在 400px 右栏与「问天枢：本条信号…」输入 |
| **S-02** 同上 | pen `Signal Article w=920 at 600,36`；live `920×754 at x=820,y=16` | P2 | 同 S-01 | 宽度 ✓；位置因缺右栏而居中。随 S-01 一并调整。验收：x=600 |
| **S-03** 同上 meta | pen `'Web · TechCrunch · 采集于 … · 未读'`；live `'CNBC · 采集于 … · 未读'` | P2 | `cards/SignalCard.tsx` | 复用 Phase 1 的 `radarSourceLabel` 补来源类型前缀。验收：文本含来源类型 |
| **S-04** 同上 | pen `Headline 28/600 ls=-0.5`、`Lead 18 lh=1.8`；live `29px` / `19px` | P2 | `styles/radar-reader.module.css` | 改 28 / 18。验收：计算值一致 |
| **S-05** 同上 | pen `Clarify Box fill=#F5F7FA r=20`；live `.clarify bg=rgb(245,247,250) r=0px` | **P1** | `styles/radar-reader.module.css` | 仅加 `border-radius:20px`。验收：`r=20` |
| **S-06** 同上 | pen 文章区透明（页面 `$bg`）；live `.article bg=rgba(255,255,255,.565)`，外层 `.feedSurface bg=#F7F8FA r=22` | P2 | `styles/radar-reader.module.css` | 去掉 `feedSurface`/`article` 底色与圆角。验收：与页面底色一致 |
| **S-07** 同上 状态按钮 | pen `已读 fill=#E8F1FF stroke=#007AFF66 r=10 pad=[9,14]`、`收藏/隐藏` 白底 `#D9DDE5`；live `标记已读 78×37 bg=#FFFFFF r=10` | P2 | `styles/radar-reader.module.css` | 待设计确认**未读态**（pen 只给已读态）；已读态用 `#E8F1FF`/`#007AFF66`。验收：切换后底色 `#E8F1FF` |
| **S-08** 同上 已读 Toast | pen `Read Toast fill=#1D1D1FF2 r=12` + `'已标记为已读'` + `'撤销' #6FB2FF` | P2（待验证） | `styles/radar-reader.module.css` | 需执行"标记已读"（状态写入）才能看到。验收：见 §5 |

### 2.6 Issue 决策（`/issues/[id]`）

pen 帧：`Issue 决策 · pending`、`· decided`、`· dismissed`

| 编号 / pen 帧 → 路由 | 证据（pen → live 实测，2560×1440） | 级别 | 首个文件 | 最小修复边界 & 验收 |
| --- | --- | --- | --- | --- |
| **I-01** `Issue 决策 · pending` → `/issues/d3a00ec3-…` | pen `Issue Workspace w=1680 at 440,40`、`Columns gap=28`：`Materials fill` + `路径 560`；live `.workspace{position:absolute;inset:0}`（实测 `2528×1408`）、`.columns{display:block}` 单栏（`materials 2526`） | **P0** | `styles/issue-workspace.module.css` | 改居中容器 `max-width:1680` + `grid-template-columns:minmax(0,1fr) 560px; gap:28`；`position:absolute` 若为过渡动效所需可留但须约束宽度。验收：`workspace` 宽 1680、x=440，右栏 560 |
| **I-02** 同上 | pen 每个 Section 为白卡 `fill=$surface stroke=#ECEEF2 r=20 pad=[22,24]`（当前判断 / 决定 / 决策路径 / 移出决策面）；live `.materials{background:#fff}` 整块白、各 section 无底色无圆角 | **P0** | `styles/issue-workspace.module.css` | 页面底改 `$bg`，每个 section 加 `#fff / 1px #ECEEF2 / r=20 / pad 22px 24px`；不动内容。验收：浅灰底 + 多张白卡 |
| **I-03** 同上 Tabs | pen `Tabs fill=#EEF0F4 r=12 gap=2 pad=3`、`Tab Active #FFFFFF r=10 pad=[7,16]`；live `.tabs button` 为下划线式（`border-bottom:2px solid #007AFF` + 蓝字），整条 2526 宽 | **P1** | `styles/issue-workspace.module.css` | 改为分段 pill。验收：计算样式为分段控件 |
| **I-04** 同上 Header Meta | pen `'Radar 升级 · 战场 · growth · 需要尽快决策 · 决定期限 2025-09-30'`（13px）；live `'Radar 升级 · 公司（kw:context、kw:llm-agent） · 待决策'`（12px） | **P1** | `cards/IssueCard.tsx` | 把 `relatedBattlefieldIds` 映射为可读名称（**不显示 `kw:*`**）；状态文案对齐 pen；字号 13。决定期限无数据属数据驱动。不新增 API。验收：文本不含 `kw:` |
| **I-05** 同上 | pen 章节标题 `15/600`、判断正文 `14`；live 章节标题 `22/600`、正文 `19` | **P1** | `styles/issue-workspace.module.css` | 标题 → 15/600，正文 → 14。验收：计算字号一致 |
| **I-06** 同上 Options | pen 选中 `#E8F1FF stroke=#007AFF66 r=12 pad=[11,14]`、未选 `#FFFFFF stroke=#D9DDE5 r=12`；live 4 个选项全为 `rgb(250,250,251) r=10`，**无选中态高亮** | **P1** | `styles/issue-workspace.module.css` | 补选中/未选两态底色描边 + `r=12`。验收：截图可看出当前选中项 |
| **I-07** `Issue 决策 · decided` → 未验证 | live 无法进入（DB 无 decided issue）。pen：Header Meta `'… · 已生效决定 · 决定于 2025-09-19'`、`已生效决定 Section` 内含 `Receipt fill=#EDF3FB r=12 pad=[16,18]`（决定文本 `#2B4C74` + `决定时预研：… · 日期 #7186A0`）+ `Revoke Button 撤回决定 白底 #D9DDE5 r=10` | P1（待验证） | `cards/IssueCard.tsx` | 用一条 decided 数据驱动核对上述三元素。验收：见 §5 |
| **I-08** `Issue 决策 · dismissed` → `/issues/3d119c0a-…` | pen Meta `'… · 已移出决策面 · 移出于 2025-09-18'`；live 该页头部仍显示 `· 待决策` | **P1** | `cards/IssueCard.tsx` | dismissed 时 Meta 改为 `已移出决策面 · 移出于 {日期}`；**不得**出现 restore/重新纳入。验收：`rg "待决策"` 不命中 dismissed 分支 |
| **I-09** 同上 | pen `已移出 Section` 内含 `Restore Button` 形态的 chip（icon 13 + `已移出决策面`，`#FFFFFF stroke=#D9DDE5 r=10 pad=[10,18]`）；live 仅纯文本 `已移出决策面` + 移出时间 | P2 | `cards/IssueCard.tsx` + `styles/issue-workspace.module.css` | 渲染为**只读 chip**（非按钮、不可点击），保持"终态不可恢复"语义。验收：chip 无 onClick、无 restore |
| **I-10** 同上 | pen `Close 40×40 fill=#FFFFFF stroke=#E1E4E9 r=20`、`Header Divider h=1 #E6E9ED`、`Textarea Box r=12 stroke=#D9DDE5`、按钮 `r=10`；live 关闭 `32×32 r=50% bg=#E9E9ED`、header `border-bottom rgba(29,29,31,.043)`、textarea `r=9 stroke=#D7DBE2`、按钮 `r=9` | P2 | `styles/issue-workspace.module.css` | 逐项对齐（圆角/描边/尺寸）。验收：计算值一致 |

### 2.7 Meeting 会议材料（`/meetings/[id]`）

pen 帧：`Meeting 会前预审`、`Meeting 会议材料 · Ongoing`、`Meeting 会议材料 · Outcome 复核`

| 编号 / pen 帧 → 路由 | 证据（pen → live 实测） | 级别 | 首个文件 | 最小修复边界 & 验收 |
| --- | --- | --- | --- | --- |
| **M-01** `Meeting 会前预审` → `/meetings/87074f7c-…` | pen 三栏 `Priority Sidebar 380` + `Advisor fill` + `Conversation 400`（2560 下满宽铺开）；live `.advisorShell x=377 w=1807 grid 300px 1455px 52px`。`06-Web像素级重构.md §8` 记录的 `--measure` 体系是**已文档化的有意偏差** | **P1** | `styles/advisor-shell.module.css`（或等价文件）+ `app/globals.css` 的 `--measure*` | 需产品签字二选一：(a) 按 pen 恢复 380/fill/400 满宽三栏，移除 `--measure` 上限；(b) 在文档中把该偏差升级为正式基线并同步 pen。验收：签字 + 截图栏宽一致 |
| **M-02** 同上 | pen `Conversation 400×fill fill=$surface stroke=#ECEEF2 r=20` 展开可见消息+输入；live 对话栏塌缩为 52px 竖轨 | **P1** | 同上 | 默认展开为 400px；保留折叠能力。验收：截图对话栏 400px 且可见输入框 |
| **M-03** 同上 | pen `一号位点评要点参考 fill=#FFF9EF stroke=#F0E3C8 r=16`，标题 `12/600 #8A6220`，4 条（方向对不对 / 节奏稳不稳 / 依据够不够 / 兜底在哪）；live 无该 amber 盒子，内容以普通 outline 项呈现 | **P1** | `cards/MeetingCard.tsx` + 对应 CSS module | 增加该 amber 参考盒（4 个固定要点）；**不新增 API**（要点为固定文案）。验收：截图存在 `#FFF9EF`/`#F0E3C8` 盒子 |
| **M-04** 同上 Header | pen `Title 24/600`、右侧 `主责 DRI · 林晓` / `4 人参会`（两行 13px `$ink2` 右对齐）、`Close 38×38 r=19`；live 标题 `19px`、DRI/参会为 chip（`bg=#ECECF0 r=999`） | P2 | `styles/meeting-*.module.css` | 标题 24/600；右侧改纯文本两行右对齐；关闭按钮对齐 pen。验收：计算值一致 |
| **M-05** 同上 | pen 各 Section `fill=$surface stroke=#ECEEF2 r=20`；live review 卡 `r=14` | P2 | 同上 | `r=20` + pen 描边。验收：`r=20` |
| **M-06** 同上 | pen `预审结论` 文案 `可提交`；live `修改后提交` | P2 | `cards/MeetingCard.tsx` | 数据驱动（readiness），仅统一措辞映射。验收：与 pen 词表一致 |
| **M-07** `Meeting 会议材料 · Outcome 复核` → 未验证 | live 无法进入（DB 无 held 会议）。pen：`Header pad=[28,40,20,40]` + `Review Body pad=[20,40,80,40] gap=20`，`逐项处理 Column 1260` + `摘要 Column 780` + `会议材料对话 400`；条目卡带 Kind Badge（`决定 #E8F1FF/#0A5DC2`、`普通待办 #E8F6EC/#2F7A44`、`CEO 判断 #F3EEFB/#6B4E9E`、`复议条件 #F1F3F6/#6E6E73`）+ 引文 + 说话人 + 状态色（`已确认 #2F7A44`、`待处理 #B6342C`）+ 操作（撤回 / 确认 / 忽略 / 触发复议） | P1（待验证） | `cards/MeetingCard.tsx` | 用一条 held 会议数据驱动核对三栏宽度、Badge 四色、状态色与操作按钮。验收：见 §5 |

### 2.8 月度计划（`/plans/[month]`）

pen 帧：`月度计划 · 协商中`、`月度计划 · 已签发`

| 编号 / pen 帧 → 路由 | 证据（pen → live 实测） | 级别 | 首个文件 | 最小修复边界 & 验收 |
| --- | --- | --- | --- | --- |
| **P-01** `月度计划 · 已签发` → `/plans/2026-09` | pen `Plan Body gap=24 pad=[20,40,90,40]`：`结果 Column fill` + `待办反馈 Column 600`；live `.body{display:block}` + `.materials{padding:28px max(28px,calc((100% - 980px)/2)) 128px}` → 单栏 980 居中，右栏完全缺失 | **P0** | `styles/monthly-workspace.module.css` | 改 `grid-template-columns:minmax(0,1fr) 600px; gap:24` + pen 内边距。验收：截图存在 600px 待办反馈栏 |
| **P-02** 同上 | pen 每 Section 白卡 `fill=$surface stroke=#ECEEF2 r=20 pad=[20,22]`，内部 `Textarea Box fill=#FFFFFF stroke=#D9DDE5 r=12 pad=[12,14]`、`Checkbox 14×14 r=3 $accent`；live section 无卡（`reviewList`/`notes` 裸在 `.materials` 白底上），textarea `r=9` | **P1** | `styles/monthly-workspace.module.css` | 加白卡 + textarea `r=12`；`已核对` checkbox 对齐 pen。验收：`r=20`/`r=12` |
| **P-03** 同上 章节标题 | pen 章节标题统一 `15/600`（公司结果 / 增长战场结果 / 交付战场结果 / 普通待办 / DRI 反馈 / 备注）；live `公司结果` 为 `11/400`，`普通待办`/`DRI 反馈`/`备注` 为 `16/600`（同页三种层级并存） | **P1** | `styles/monthly-workspace.module.css` | 统一 15/600。验收：同页所有章节标题 `15px/600` |
| **P-04** 同上 Header | pen `Eyebrow 12 $ink2 '已签发 · 2025-09-20'`、`Title 24/600`、`Close 38×38 r=19`；live `eyebrow 11/500 '已签发 · 草案已就绪 · 2026-09-16'`（3 段，混入 generation 状态）、`h1 20/600` | P2 | `cards/MonthlyPlanCard.tsx` + `styles/monthly-workspace.module.css` | eyebrow 收敛为 2 段（计划状态 · 日期），generation 状态移到正文；`12px`；`h1 24/600`。验收：文本不含"草案已就绪" |
| **P-05** 同上 签发回执 | pen `Receipt` 为 tinted 卡（`r=12`，决定/签发文本 + `签发于 · 参与人` meta 两行）；live `.receipt` 为普通 12px `#426c50` 纯文本一行 | P2 | `styles/monthly-workspace.module.css` | 恢复 tinted 卡 + meta 行；文案保持现有语义。验收：截图为卡片而非纯文本 |
| **P-06** `月度计划 · 协商中` → 未验证 | live 无法进入（DB 只有 confirmed 计划）。pen：`Eyebrow '协商中 · 草案已就绪'`、`结果 Column` 含三个结果 section（公司结果 / 增长战场结果 / 交付战场结果）+ `待办反馈 Column 600`（`Todo · 输出东南…` 卡含 `待办/负责人（personId）/可选截止` 三字段 + `BF Badge`）、`DRI 反馈 Section`、`备注 Section` | P1（待验证） | `styles/monthly-workspace.module.css` + `cards/MonthlyPlanCard.tsx` | 用一条 negotiating 计划核对：三结果 section 标题与字段、Todo 卡三字段与 BF Badge、提交/签发按钮为 accent 主按钮。验收：见 §5 |
| **P-07** 同上 | 已确认状态下 live **无**「保存计划 / 签发计划」按钮 ✓（正确）；pen `协商中` 帧才有 Commit Area | — | — | 无差异，作为回归基线。验收：confirmed 时 `rg "签发计划"` 在 DOM 中不出现 |

### 2.9 全局对话 Dock（所有页面）

pen 帧：`Dock`、`Dock · 展开`、`首页 · 全局对话展开`

| 编号 / pen 帧 → 路由 | 证据（pen → live 实测） | 级别 | 首个文件 | 最小修复边界 & 验收 |
| --- | --- | --- | --- | --- |
| **D-01** `Dock · 展开` → 各页 `historySheet` | pen `720×560 at 920,824 fill=#FFFFFFF7 stroke=#FFFFFFE0 r=20 pad=[22,22,18,22]`；头部 Mark 28 + `天枢`/`独立对话 · {scope}` + `Close 30×30 r=15` + `New Thread #F1F3F6 r=10`；messages `gap=14`；input `Conversation Bar fill=#F5F7FA stroke=#E1E4E9 r=22 h=48`。live `<dialog class=historySheet>` 实测 `min(960px,…)×~1288`、`bg=#252527`（深色）、`r=28`、居中模态 + 暗色 backdrop | **P0** | `styles/conversation.module.css` | 改为 pen 的浅色浮层：`max-width:720px; max-height:560px; background:rgba(255,255,255,.97); r=20`，底部居中（`bottom:104px; left:50%`），backdrop `#10151F4D`，input `r=22 h=48`。验收：计算尺寸/底色一致 |
| **D-02** `Dock` → 各页 Dock | pen `340×52 fill=rgba(255,255,255,.93) r=26 pad=[0,6]`：`Mic 38×38` + `'按住说话 · 公司全局'` + `Send 30×30 accent`；live `.layer 620×48`、Dock 含 `History 按钮` + `textarea 输入` + `send 28` + 附件 picker（键盘输入模式） | **P1** | `styles/conversation.module.css` + `conversation/ConversationDock.tsx` | 两种模式需产品裁决：pen 为按住说话；live 为键盘输入（CSS 中已有 `.voiceButton` 但未渲染）。若采用键盘模式，至少对齐 `340~420×52 r=26`、Send 30 accent、去掉多余 picker。验收：签字 + 截图 Dock 尺寸/形态一致 |
| **D-03** 同上 | pen Dock 位于 `at 1110,1352`（主内容区居中）；live `.layer{width:620px; left:calc(35% + 6px)}` | P2 | `styles/conversation.module.css` | 改为相对主内容区居中（`left:50%; transform:translateX(-50%)`）。验收：Dock 中心与 `mainArea` 中心一致 |
| **D-04** 同上 加载/禁用/错误态 | pen `规范/交互状态`：按钮 loading `'提交中…'`、disabled `fill=#F1F3F6 text=#8E9099`、input error `#FFF8F7`/`#E34B43`、错误态 `重试`；live 现状符合基线 #7（显式 loading/disabled 文案、无骨架屏） | **P1**（配色未验证） | `styles/app-shell.module.css` + 各按钮模块 | 逐项核对禁用/加载/错误配色。验收：见 §5 |
| **D-05** 同上 | pen `规范/交互状态` 备注句 `列表加载用骨架而非转圈` 与同一组件另一单元 `首屏服务端直接展示 · 非骨架` **互相矛盾**，且与已确认基线 #7（不做骨架屏）冲突 | P2 | —（设计文件） | **pen 自身冲突，建议按基线 #7 修订 pen 文案**，代码不动。验收：设计确认 |

---

## 3. 实施批次（按依赖排序）

每批结束都必须产出**同视口整页截图**并与对应 pen 帧并排比对；截图验收未过不算完成。批次内先做令牌，再做结构，最后做细节。

### 批次 0 · 裁决与前置（非代码，必须先做）
1. **裁决验收视口**：2560×1440（pen 原生）还是 1440×900 / 1600×1000（文档）。影响 R-01、G-01、H-10、I-01、P-01、M-01 全部栅格条目。
2. **裁决 H-01 通知栏材质**：浅色（pen）还是深色壁纸玻璃（实现）。
3. **裁决 M-01/M-02 `--measure` 偏差**：恢复满宽三栏，还是把偏差升级为正式基线并同步 pen。
4. **裁决 S-01/D-02**：Signal 页是否需要 per-signal 对话栏；Dock 是按住说话还是键盘输入。
5. **修订 pen 自身缺陷**：§4 的 3 处。
> 验收：上述 5 项各有书面结论，写入 `docs/technical/ceo-warmap/06-Web像素级重构.md`。

### 批次 1 · 共享令牌与栅格（影响全部页面）
- 文件：`apps/web/src/styles/app-shell.module.css`（圆角/标题/页面底色/边距）、各模块 CSS 的硬编码圆角字号。
- 内容：G-01、G-02、G-03、G-04、G-05、G-06。
- 截图验收：首页 + Issue + Monthly 三张整页截图，面板/卡片圆角 20、按钮 10、页面标题 24~26、章节标题 15、主按钮 accent。
> 状态（实现记录，不改结论）：G-01~G-06 代码完成（4 文件：`app-shell.module.css`、`issue-workspace.module.css`、`cards/IssueCard.tsx`、新增 `issueDecidePrimary.test.tsx`）；`test` 7 文件/20 用例、`typecheck` 0、`build` 通过；已用 Chrome 注入 built CSS 逐项核对，整页截图验收因 live 镜像陈旧未执行（见 §5）。

### 批次 2 · Access 与 Home
- 文件：`app/access/AccessScreen.tsx`、`app/access/access.module.css`、`components/NotificationRail.tsx`、`components/HomeBoard.tsx`、`styles/home-board.module.css`、`styles/notifications.module.css`。
- 内容：A-01~A-03、H-01~H-15。
- 截图验收：`Access 登录`（正常 + 密码错误）、`首页 Home`、`首页 · 通知栏空`、`首页 · 通知浮卡打开`、`首页 · 全局对话展开` 五张；通知栏日期为 `9月18日`、通知栏材质与裁决一致、雷达面板含 170×170 扫描盘、战略议题行含色点与箭头、能力面板标题横跨整行。
> 状态（实现记录，不改结论）：A-01~A-03、H-01~H-15 代码完成（7 文件：`styles/notifications.module.css`、`components/NotificationRail.tsx`、新增 `components/notificationClock.test.ts`、`styles/home-board.module.css`、`components/HomeBoard.tsx`、`styles/radar.module.css`、`styles/access.module.css`）；`test` 7 文件/20 用例、`typecheck` 0、`build` 通过；Access 与 Home 已在 Chrome（built CSS 注入）逐项核对。H-03 渲染文案、H-07 分隔线需重建 web 镜像后复测；H-09 行分隔线需 ≥2 条 pending 议题、H-15 需空态数据；整页截图验收未执行（镜像陈旧）。

### 批次 3 · Radar 与 Signal
- 文件：`styles/radar-feed.module.css`、`styles/radar-config.module.css`、`cards/RadarCard.tsx`、`styles/radar-reader.module.css`、`cards/SignalCard.tsx`、`app/radar/signals/[id]/page.tsx`。
- 内容：R-01~R-05、S-01~S-07。
- 截图验收：`Radar 信号流`、`Radar 监测范围弹窗`（三源行 + 徽章 pill，且 outlets 不显示为微信公众号）、`Signal 阅读`（含右栏）、`Radar 空状态`（§5 复现后）四张。
- **文件更正**：本批不存在 `styles/radar-reader.module.css`（原表为命名假设）。Signal 阅读与 Radar 流共用 `styles/radar-feed.module.css`，外层底色在 `styles/app-shell.module.css`（`.feedSurface`，仅 `/radar` 与 `/radar/signals/[id]` 的 `layout="feed"` 使用）。
- 状态（实现记录，不改结论）：R-01~R-05、S-01~S-07 代码完成（11 文件：`styles/radar-feed.module.css`、`styles/radar-config.module.css`、`styles/app-shell.module.css`、`styles/conversation-dock.module.css`、`styles/conversation-transcript.module.css`、`cards/RadarCard.tsx`、`cards/SignalCard.tsx`、`conversation/ConversationDock.tsx`、`components/CardPage.tsx`、`app/radar/signals/[id]/page.tsx`、新增 `cards/signalReader.test.tsx`）；`test` 8 文件/22 用例、`typecheck` 0、`build` 通过。
- **实测方式**：Chrome 于 2560×1440 CSS 视口（`innerWidth/Height=2560/1440`、DPR 1）注入本批 built CSS 子集。因 live 镜像仍是旧版本，注入无法"取消声明"，仅对两条"只删声明"的规则补写等价移除值（`.feedSurface`、`.reader .article` 的 `background:transparent`/`border-radius:0`）。以下为**计算值实测，非整页截图验收**：
  - R-01 ✓ `.feed` `x=310 w=1940`（`max-width:1940px`）；`.stories` `960px 960px`、column-gap 20 / row-gap 18；`.story` r=20、h2 21/600/-0.3
  - R-03 ✓ `.filters/.sorts` `#EEF0F4` r=12 pad 3；段项 r=10 pad 6/13、激活 `#FFFFFF`/`#20242C`
  - R-04 ✓ 弹窗 980×1040 r=20 `#FFFFFF` stroke `#E6E9EF`、header/scroll pad 26/30、锚点单列无边框、来源行 `#F7F8FA` r=12 pad 16/18 `align-items:center`、footer pad 20/30、关闭 34×34 `#F1F3F6`/`#626873`、动作按钮 pad 10/22 r=12 `#F1F3F6`/`#303741`、backdrop `rgba(16,21,31,.72)`=`#10151FB8`；徽章 pill 几何 r=10 pad 4/10 11px/500 ✓。徽章配色依赖本批新增的 `data-on`（旧 DOM 无该属性）→ 在旧 DOM 上模拟该属性测得 启用 `#E8F6EC`/`#2F7A44`、未配置 `#F1F3F6`/`#6E6E73`
  - S-02 ✓ `.reader` grid `2092px 400px`、`.article` `x=600 w=920`（与 pen 完全一致）
  - S-04 ✓ h2 28/600/-0.5、lead 18/1.8
  - S-05 ✓ `.clarify` r=20（padding 仍 12/14，见残留）
  - S-06 ✓ `.feedSurface` 底色透明、r=0；`.reader .article` 底色透明
  - S-07 ✓ `[data-state=read]` `#E8F1FF`/`#0A5DC2`/`#007AFF66`（同以模拟属性验证）；未读态白底 `#D9DDE5` r=10 pad 9/14
  - 响应式 ✓ ≤1100 `.reader` 单列 `overflow:auto`；≤650 弹窗宽 630px=`calc(100vw - 20px)`，证明新增块插入在移动端规则之前、未覆盖移动端
  - R-02 **部分**：live 空闲态措辞已与 pen 一致（`1 条未读 · 定时扫描 … · 最近一次手动补扫：completed · 上次启动 …`），本批仅新增 `扫描中` 前缀；pen 的 `已检索 N / M 个锚点` 与 `上次完成 HH:MM` 在 `RadarPayload` 中无数据来源 → 不实现（不编造）
  - S-01/S-03 属渲染分支（400px 右栏、来源类型前缀）→ 由新增 `cards/signalReader.test.tsx` 断言（2 用例），live 旧镜像不可见；S-01 宽度由 `.reader` 上的既有公共旋钮 `--rail-right:400px` 提供，实测 grid 第二轨 = 400px
- 残留（本批未做，需后续批次或裁决）：`.clarify` padding 12/14 vs pen 16/18；`.feed` 顶部 24 padding 未加（会与外壳 14 padding 叠加）；工具栏 gap 12 vs pen 14、状态行色 `#818590` vs pen `#6E6E73`（均在本批 R-02/R-03 范围外）；外壳 14 padding 造成右栏 `x=2106` vs pen `2120` 的系统性偏移；Signal 右栏高度按内容填充（pen 1324 为 mock 定值）；S-08 需状态写入，未验证。
- **本批未执行**：整页截图验收（`warmap-web-1` 镜像陈旧，需重建后才可产出最终截图）。

### 批次 4 · Issue 决策
- 文件：`styles/issue-workspace.module.css`、`cards/IssueCard.tsx`。
- 内容：I-01~I-10。
- 截图验收：`Issue pending`（1680 双栏 + 白卡 + 分段 tab + 选项选中态 + accent 主按钮）、`Issue decided`、`Issue dismissed` 三张；Meta 不含 `kw:`，dismissed 无任何 restore 入口。

### 批次 5 · Meeting
- 文件：`styles/advisor-shell.module.css` 及 meeting 相关模块、`cards/MeetingCard.tsx`。
- 内容：M-01~M-07（M-01/M-02 依赖批次 0 裁决）。
- 截图验收：`Meeting 会前预审`（含 `一号位点评要点参考` amber 盒）、`Meeting Ongoing`、`Meeting Outcome 复核` 三张。
- **文件更正**：本批不存在 `styles/advisor-shell.module.css`。Meeting 几何全部在 `styles/meeting-workspace.module.css`；对话栏标题令牌在 `styles/conversation-dock.module.css`。
- 状态（实现记录，不改结论）：M-01~M-07 代码完成（3 个既有文件 + 1 个新增测试）：
  - `cards/MeetingCard.tsx`：M-03 从真实 `leader_lens` 抽取 amber 盒并从分组正文去重（两种分组模式都过滤）；M-02 两个分支均传 `sidebar={{open:true,tone:"light"}}`；M-07 Outcome 改为两个 `.reviewColumn` + 400px 对话栏，逐项卡渲染真实 kind/state/引文/说话人，只渲染服务端下发的 action。
  - `styles/meeting-workspace.module.css`：M-01 `.materials` 持有 `--rail-stub:52px/--rail-right:400px`，`.advisorShell` `--rail-left:380px` + `gap:20px` + `padding:20px 40px 80px`；M-04 Header `28px 40px 20px`、标题 24/600、动作 38px、关闭 38×38；M-05 主区 section r=20/`#ECEEF2`/间距 16/pad 24；M-07 `.review` 三栏 + `.reviewColumn` 独立滚动 + `.decisionRecord` 卡片态；响应式：`≤2299` Outcome 单列、`≤1400` 会前预审单列（替换旧版 absolute 抽屉）、`≤1000` 隐藏对话栏。
  - `styles/conversation-dock.module.css`：浅色标题 14/600 `#1D1D1F`（同时修正 Signal 侧栏残留）。
  - 新增 `cards/meetingWorkspace.test.tsx`（3 用例）：leader-lens 盒 + 去重、两分支默认展开浅色对话栏、Outcome kind/state/action 渲染。
- 检查：`pnpm --filter @warmap/web test` 9 文件/26 用例通过；`typecheck` 0；`build` 通过；`git diff --check` 干净。
- **实测方式**：Chrome 于 2560×1440 CSS 视口（`innerWidth/Height=2560/1440`、DPR 1，emulate `1707x960x1.5`）注入本批 built CSS 子集（`/tmp/batch5.css`，274 规则）。live 镜像为旧版本，需注意两类注入假象：(a) 旧 `.advisorShell` 声明 `--rail-right`（`clamp(...)`）需 `#__shim` 强制 400px（新源码由 `.materials` 继承 400px，无需 shim）；(b) 注入无法取消旧声明，`.decisionRecord:first-of-type{border-top:0}`、`.decisionRecord blockquote` 等旧规则仍会生效。以下为**计算值实测，非整页截图验收**：
  - M-01/M-04 ✓（会前预审，真实 scheduled 会议）：`.advisorShell` 三栏 `379.992px 1607.05px 423.996px`（右栏 424 = 旧镜像 `--rail-right` 未被取消；带 shim 时为 `380 / 1631.05 / 400`，中心列与 pen 1660 的 29px 差为外壳 14px 内边距）；Header `28px 40px 20px`、h1 24/600/-0.3、动作按钮高 38、关闭 38×38；优先级栏 380/`#FFF`/r20；浅色对话栏 400/`#FFF`，标题 14/600 `#1D1D1F`；主区 section r20/`#ECEEF2`/pad 18/24。
  - M-03 ✓ amber 盒实测 pad 14、gap 9、`#FFF9EF`/`#F0E3C8`、r12（旧 live `.advisorMain .reviewSection h3` 15/640 属旧声明，新源码 15/600 已由注入的 `.reviewColumn ... h3` 覆盖，仅旧 DOM 隐藏分支保留 640）。
  - M-07 ✓（合成 Outcome DOM + 注入 CSS，容器按真实 `.materials` 高度 1302px 固定）：`.review` `grid-template-columns:1260px 780px 399.996px`、`clientWidth==scrollWidth==2560`（**无横向裁切**）、`overflow:hidden`；`.reviewColumn` `clientH=1202`、`scrollH=2983/3181` → 双列独立滚动；section r20/`#ECEEF2`/pad 22/24/`max-width:none`、`.count` 12px `#6E6E73`；`.decisionRecord` r12/pad 14/16/gap 8/`#F7FAFF`（`data-kind=decision`）、`.itemQuote` 12px/400 `#6B7686`/pad-left 12、`.itemState` 11/500 `#2F7A44`、动作按钮 pad 5/10 r6 11px 且启用态不降透明度；危险区 r20 + 边框 `#F0D9D5` + 标题 `#9C4A40`。
  - 响应式 ✓：`innerWidth=1920` 与 `1279` 下 `documentElement.scrollWidth==clientWidth`（无横向裁切）；Outcome `.review` 单列（`1844.02px` / `1211.51px`，双列等宽）；会前预审 `≤1400` 转单列（`.materials .advisorShell` 0,2,0 覆盖旧镜像 0,1,0 的 absolute 抽屉规则）。`≤1400` 单列下旧镜像自身还有 JS 内联 `display:none` 与旧 `.advisorMain/.sidebar` 声明，属陈旧镜像，不作为本批验收依据。
- 残留（本批未做）：
  - `.judgmentHero` 深色卡在 M-01~M-07 范围外，未动。
  - pen 的 `达成的共识`、`触发复议` 无 schema 字段与 API action → **不实现**（不编造）。
  - 文案保留 live 的 `会后抽取摘要` / `逐项处理`，未改成 pen 的 `核心判断` / `会议核心决策要点`（provenance 未变）。
  - M-06 无需改码：`READINESS_LABEL` 词表已符合 pen，可见状态由真实 payload（`readiness="revise"`）决定，无法强制显示 pen 的「可提交」。
  - M-03 用真实 leader-lens 数据，不硬编码 pen 文案。
  - 审计表两处笔误更正：M-04 的 DRI/Count 实为 12px；M-03 amber 圆角实为 12px；pen 中**不存在** `Meeting Ongoing` 帧（仅有 `Meeting 会前预审` 与 `Meeting 会议材料 · Outcome 复核`）。
- **本批未执行**：整页截图验收（`warmap-web-1` 镜像陈旧且未获授权重建）；M-07 真实数据渲染（DB 无 held 会议的 transcript/outcome）未在 live 验证。

### 批次 6 · 月度计划
- 文件：`styles/monthly-workspace.module.css`、`cards/MonthlyPlanCard.tsx`。
- 内容：P-01~P-06。
- 截图验收：`月度计划 · 已签发`（980+600 双栏 + 白卡 + tinted 回执）、`月度计划 · 协商中`（三结果 section + Todo 卡三字段 + accent 提交/签发按钮）两张。
- **文件更正**：本批无独立「monthly 相关模块」，几何与输入控件全在 `styles/monthly-workspace.module.css`；文案/结构在 `cards/MonthlyPlanCard.tsx`。
- 状态（实现记录，不改结论）：P-01~P-05、P-07 代码完成（2 个既有文件 + 1 个新增测试），P-06 **部分**（可复用结构已实现，无 negotiating 计划可验，未编造状态）：
  - `styles/monthly-workspace.module.css`：P-01 `.materials` 由 980px 居中单栏改为 `grid-template-columns:minmax(0,1fr) 600px; gap:24; padding:20px 40px 90px`，并去掉旧白底（露出 pen 的页面灰）；P-02 新增 `.section` 白卡 `r20`/`#ECEEF2`/`pad 20 22`、`.resultsColumn`/`.feedbackColumn`（gap 16）、textarea `r12`/`#F5F7FA`/`#E1E4E9`/`pad 12 14`/13px，`:not(:disabled)` 转可编辑态 `#FFF`/`#D9DDE5`；P-03 `.workspace .sectionTitle` 统一 `15/600`；P-04 Header `28px 40px 20px`、eyebrow `12/400 #5A5A60`、`h1 24/600`、关闭 `38×38` 白底 `#E1E4E9`；P-05 `.receipt` 恢复 tinted 卡 `r12`/`#EDF6EF`/`#CBE5D2`/`pad 14 18` + `small` meta；P-06 结构：`.todo` 卡 `r12`/`#FAFBFC`/`pad 12 14`、`.todoHead`+`.todoIndex`+`.battlefieldBadge`、`.feedback`/`.feedbackText`/`.feedbackMeta`、`.save` 次按钮（`#FFF`/`#D9DDE5`/`r10`/`pad 10 18`/`13/500`）、`.submit` 改 accent 主按钮（`#007AFF`/`r10`/`pad 10 20`/`13/600`，禁用态 `#F1F3F6`/`#6E6E73`）、`.check` 勾选行（14×14、`accent-color:#007AFF`、说明 12px、gap 8）、`.commitArea{padding:0 40px; gap:24}`；响应式新增 `@container(max-width:1240px)` 单列 + `pad 20px 24px 64px`，`≤690px` 的 `commitArea`/`receipt` 同步收边距；删除本次改造后失效的 `.intro/.reviewList/.reviewItem/.itemHeading/.number/.proposal` 与 `.notes{margin-bottom:24px}`。
  - `cards/MonthlyPlanCard.tsx`：正文拆为 `.resultsColumn`（公司结果 + 各战场结果 section）与 `.feedbackColumn`（普通待办 / DRI 反馈 / 备注 section）；eyebrow 收敛为两段（已签发看 `confirmedAt` 日期，协商中看 `GENERATION_LABEL`），`generation.error` 与重试仍保留在正文；待办卡改为序号 + 战场徽标（`battlefieldId ?? "公司级"`，payload 无战场显示名，不编造）+ 三字段 + 来源 + 核对行；保存计划换 `.save`、签发计划留 `.submit`；`ActionFeedback`、`commitArea`、`receipt` 移出滚动区成为页脚。公司结果 textarea 由 `<label>` 包裹改为 `aria-label="公司结果"`（保留可访问名），战场结果/备注同步补 `aria-label`。
  - 新增 `cards/monthlyWorkspace.test.tsx`（3 用例）：已签发两段眉标 + tinted 回执 + 无保存/签发入口（P-07 回归）、negotiating 眉标回落不伪装已签发、待办/反馈卡渲染序号·战场徽标·三字段·来源·meta 且只渲染服务端下发的 Action。
- 检查：`pnpm --filter @warmap/web test` 10 文件/29 用例通过；`typecheck` 0；`build` 通过；`git diff --check` 干净。
- **实测方式**：Chrome 于 2560×1440 CSS 视口（`innerWidth/Height=2560/1440`，emulate `1707x960x1.5`）。live 镜像是旧版本（旧 JS + 旧 CSS），因此**不能**直接测 live DOM；改为：用 vitest `renderToStaticMarkup` 以 **live 真实 payload**（`confirmed`、`battlefields=[]`、`todos=[]`、`feedback=[]`、`checkedItemIds=["company"]`、`confirmedAt=2026-09-16T07:47:27Z`、`actions=[]`）渲染组件 → 把 vitest 类名机械映射为本批 built 类名（`monthly-workspace-module__TdPrea__*`，与 live 镜像哈希一致）→ 经本地 `http.server:8899` 以跨源 `<script>/<link>` 注入到 live 页的真实 `.workspace` 外壳内（外壳几何 `14px` 内边距保留）→ 读计算值。以下为**计算值实测，非整页截图验收**：
  - P-01 ✓：`.materials` `display:grid`、`grid-template-columns:1826.27px 600px`、`gap:24px`、`padding:20px 40px 90px`；两列宽和 `1826.27+600+24 = 2450.27` = 内容宽，右栏精确 600px。
  - P-02 ✓：四个 section 均 `padding:20px 22px`、`border-radius:20px`、`border-color:#ECEEF2`、`background:#FFF`、`max-width:none`、`margin:0`；textarea `r12`/`#F5F7FA`/`#E1E4E9`/`pad 12px 14px`/13px/`#5A5A60`（禁用态=pen 已签发态）；勾选框实测 `13.99×13.99`、`accent-color:#007AFF`。
  - P-03 ✓：四类 section 标题统一 `15px/600`、`#1D1D1F`。
  - P-04 ✓：Header `padding:28px 40px 20px`、`border-bottom:#E6E9ED`；eyebrow 文本 `已签发 · 2026-09-16`、`12/400 #5A5A60`（**不含**「草案已就绪」）；`h1 24/600`；关闭 `37.99×37.99` 圆、白底、`#E1E4E9`。
  - P-05 ✓：回执 `r12`/`#EDF6EF`/`#CBE5D2`/`pad 14px 18px`/`13/500 #2F7A44`，`margin:0 40px 20px`，宽 2450.27（=2560−2×14 外壳 −2×40 页边距），含 `small` meta `签发于 2026-09-16`（参与人 payload 无字段，未编造）。
  - P-06（结构）✓：`.commitArea{padding:0px 40px; justify-content:space-between; gap:24px}`；live payload 无 `update_draft`/`sign` action，故 `.edit` 为空、按钮未渲染（数据驱动，正确）。
  - P-07 ✓：已签发真实 payload 下 DOM 无「保存计划 / 签发计划」（同时由单测固定）。
  - 响应式 ✓：2560/1920/1279/1200/1024/960 CSS 宽下 `documentElement.scrollWidth==clientWidth`（**无横向裁切**）；容器 >1240 双栏（1920 → `1185.77px 600px`，1279 → `545.27px 600px`），≤1240 单列（1200 → 1129.76px，1024 → 954.26px，960 → 889.76px）且 `pad 20px 24px 64px`。
- 注入假象（不影响上述结论）：旧 live CSS 的 `.materials{background:#fdfdfdfc}` 无法被注入取消，故实测背景为近白；新源码已删除该声明（built CSS 中 `.materials` 无 `background`，仅 `forced-colors` 下为 `canvas`），实际应为 `.workspace` 的页面灰。
- 残留（本批未做）：
  - P-06 的 negotiating 真实渲染（Todo 卡三字段 + BF Badge + accent 提交/签发按钮）**未验证**：DB 仅一条 `confirmed` 计划，无法进入 negotiating；未伪造状态。
  - 勾选框 `r=3` 未生效：用原生 `input[type=checkbox]` + `accent-color` 实现，Chrome 对原生控件忽略 `border-radius`（实测 `0px`）；换取键盘/无障碍/`forced-colors` 行为，不改为自绘控件。
  - 各 section 内部间距统一 `gap:10px`，未按 pen 逐节区分（结果 10 / 普通待办 12 / 备注 8）。
  - pen `Receipt` 的 16px 回执图标未实现（审计项只要求 tinted 卡 + meta 行）。
  - Header `Marker` 仍为 8px（pen 10×10 渐变），不在 P-04 范围。
  - 段落 `max-width`：pen 结果栏为 fill，live 也 fill（`.section{max-width:none}`），无 980px 残留。
- **本批未执行**：整页截图验收（`warmap-web-1` 镜像陈旧且未获授权重建）；negotiating 状态 live 渲染。

### 批次 7 · 全局交互与状态
- 文件：`styles/conversation.module.css`、`conversation/ConversationDock.tsx`、各按钮模块。
- 内容：D-01~D-04（D-01 可与批次 2 合并，视改动量）。
- 截图验收：`Dock`、`Dock · 展开`、`规范/交互状态` 覆盖的 loading/disabled/error 三态各一张。
- **文件更正**：审计 D-01~D-04 写的 `styles/conversation.module.css` **不存在**。实际文件为 `styles/conversation-dock.module.css`（`.layer/.dock/.content/.sendButton/.iconButton`）、`styles/app-shell.module.css`（`.historySheet/.sheetHeader/.chatBrand/.sheetScroll/.historyComposer`）；`HomeShell` 把 `<ConversationDock>` 渲染为 `.shell` 的子节点，故 `--main-start`/`--shell-edge` 可解析。
- 状态（实现记录，不改结论）：D-01/D-02/D-03/D-04 可达部分完成（3 个既有文件，无新增文件/测试；改动为 CSS + 1 个透传属性 + 2 处图标尺寸）：
  - `conversation/ConversationDock.tsx`：`<dialog className={w.historySheet}>` 增加 `data-tone="light"`（复用既有「浅色对话承载面」钩子，不新增 transcript CSS）；dialog 的关闭图标 `size 22→14`（pen `Close Icon 14`）。
  - `styles/conversation-dock.module.css`：D-02 基础几何对齐 pen `Dock / 全局对话`——`.dock` `292×48→340×52`、`gap 5→6`、`padding 5→6`（`r26` 不变，52 高下即 pen 的胶囊）；`.dock .iconButton`/`.content` `36→38`；`.dock .sendButton` `28→30`；`.dock .sendButton:disabled` 改用 pen 主按钮禁用令牌 `#F1F3F6`/`#E6E9ED`/`#8E9099`；`.dock .iconButton svg 18→16`、`.dock .sendButton svg 17→14`（pen Mic 16 / Send 14）；删除 `@media(min-width:1800px){.dock{width:320px}}`（2K/1440p 也拿到 pen 的 340）；`≤690` 只保留 `width:min(280px,100%)`（继承 52/6）。D-04 `.historyError` 改为 pen 输入框错误令牌 `#FFF8F7`/`#E34B43`/`#C2382F`，但**保留深色基态** `#5C2622`/`#F3D9D5` 并仅用 `:global([data-tone=light]) .historyError`（0,2,0）覆写，避免 Meeting 深色侧栏（live `data-tone` 缺失）被误改成浅色。新增浅色 composer 块（置于深色 `[data-in-history=true]` 块之后）：`:global([data-tone=light]) .dock[data-in-history=true]`（0,3,0）`h48`/`pad 0 6 0 16`/`#E1E4E9`/`r24`/`#F5F7FA`/`#282C32` + `.sendButton 34×34`（pen `Exp Send 34`）+ `.sendButton:not(:disabled)` accent + `.sendButton:disabled` pen 禁用令牌 + `.iconButton` `#737780` + textarea `#282C32`/占位 `#6E6E73`。
  - `styles/app-shell.module.css`：D-01 `.historySheet` 由「近全屏深色模态」改为 pen 浅色浮层 `720×560`/`r20`/`#FFFFFFF7`/`#FFFFFFE0`、`bottom:104px`、`max-height:min(560px,calc(100dvh - 120px))`、`box-shadow:0 24px 70px #10151F2E`、`::backdrop #10151F4D`（去掉 blur）；水平轴用主内容区公式 `left:calc((100vw + var(--main-start) - var(--shell-edge))/2);transform:translateX(-50%)`（与 Dock 同轴；实测 `left:50%` 会在 2560 下偏 222px）；Header `pad 16 20 14`/`#ECEEF2`/`small #626873`/关闭 `30×30 #F1F3F6 #626873`/`.chatBrandMark 27→22`（pen `Exp Mark 22`）；`.sheetScroll pad 16 20 20`；`.historyComposer pad 0 20 18`；`.historyContent max-width:720px`；`≤1000`/`≤690` 内边距与 `≤690` 浮层尺寸同步收边。
- pen 取值以 `.pen` 实测为准（审计表此处已过期，需修订）：`Dock / 全局对话` `340×52`/`#F8F8FAF6`/`#FFFFFFE0`/`r26`/`gap 6`/`pad 6`，Mic `38×38`（icon 16）、Send `30×30`（icon 14）；`Dock · 展开` `720×560`/`#FFFFFFF7`/`#FFFFFFE0`/`r20`/`gap 14`/`pad[18,20]`，`Exp Header` = Mark 22 + 标题 + `Scope Chip #F1F3F6 r6 pad[3,9]` + `Exp Close 30×30 r15 #F1F3F6`（icon 14）——**无** `New Thread`、无 28px Mark（审计表所记），`Exp Input` `h48 r24 #F5F7FA #E1E4E9 pad[0,6,0,16]`（审计写 r22，pen 实为 r24），`Exp Send 34×34`（icon 15），Messages `gap 12`（AI `#4F5866`、User `#E9EDF5 r12 pad[10,12]`、Loading 点 `#9AA3AE`/字 `#6E6E73`）；`规范/交互状态` = 主按钮 default `$accent`/hover `#0069DB`/pressed `#0059B8`/focus `#007AFF4D`/**禁用 `#F1F3F6`+`#E6E9ED`+`#8E9099`**/**loading `#7FB6FF`+白字**，次按钮禁用 `#F7F7FB`/`#E6E9ED`/`#8E9099`，输入框禁用同上、错误 `#FFF8F7`/`#E34B43`/`#C2382F`；Meeting/Signal 侧栏 `Conv Input h44 r22 #F5F7FA #E1E4E9 pad[0,6,0,14]` + `Send 32×32`（icon 14）。
- 检查：`pnpm --filter @warmap/web test` 10 文件/29 用例通过；`typecheck` 0；`build` 通过；`git diff --check` 干净。
- **实测方式**：Chrome 于 2560×1440 CSS 视口（emulate `1707x960x1.5` → `innerWidth/Height=2560/1440`；每次 `emulate` 后必须 `navigate_page`，否则 `position:fixed` 的 `left/width` 保持上一视口值）。live 镜像为旧 JS+旧 CSS，故把本批 built CSS 子集（`/tmp/batch7-serve.css`，241 规则，由 `/tmp/batch7_extract.py` 从含 `historySheet` 的 chunk 提取）经 `python3 -m http.server 8899` 以跨源 `<link>` 追加到 `document.head` 末尾（同特异性后置生效），并加 `style#__notrans` 关过渡。**关键坑**：跨源样式表的应用发生在主线程空闲后，`link` 与同步忙等（沙箱无 `setTimeout`）写在同一调用里会导致**本次测量仍读旧 CSS**（首轮实测 dock 仍为 320/48/5/5）；必须「注入 → 下一次调用再测量」。dialog 的 `data-tone=light` 与浅色 transcript 由 `setAttribute` shim（同批次 5 的 `#__shim`，**仅诊断**）。以下为**计算值实测，非整页截图验收**：
  - D-02 ✓（2560 收起态）：`.dock` `340×52`、`padding:6px`、`gap:6px`、`border-radius:26px`、`background:rgba(248,248,250,.97)`、`border-color:rgba(255,255,255,.88)`；`.iconButton` `38×38`（svg 16）；`.content`/textarea 高 38；`.sendButton` `30×30`、禁用 `#F1F3F6`/`#E6E9ED`/`#8E9099`。
  - D-03 ✓（无需改码）：`.layer` 中心 `1502.25` == `mainArea` 中心 `1502.24`（live 已满足；本批新增的浮层复用同轴）。
  - D-01 ✓（2560 展开态，含 shim）：dialog `720×560`、`r20`、`rgba(255,255,255,.97)`、`color:#1D1D1F`、`max-height:560px`、`bottomGap 104`、`::backdrop rgba(16,21,31,.3)`、中心 `1502.25` == `1502.24`；Header `pad 16/20/14`、`border-bottom #ECEEF2`、`small #626873`、关闭 `30×30 #F1F3F6 #626873`、Mark `21.996px`；`.sheetScroll pad 16/20/20`、`clientWidth==scrollWidth==719`（**无裁切**）；composer dock `678.52×48`、`r24`、`pad 0 6 0 16`、`#F5F7FA`/`#E1E4E9`/`#282C32`；发送 `34×34`、禁用 pen 令牌；textarea `#282C32`、占位 `#6E6E73`；合成 `#__syn` transcript 探针：assistant `#4F5866`、user `#E9EDF5`/`r12`/`pad 10 12` ✓。
  - D-04 可达部分 ✓：`<dialog>` 内合成 `.historyError` 实测 `#FFF8F7`/`#C2382F`/`#E34B43`（pen 输入框错误令牌）；Meeting 深色侧栏合成同类元素仍为 `#5C2622`/`#F3D9D5`（**S-0x 未回归**）；侧栏/浮层发送禁用 token 分层正确（Signal 侧栏 `(0,6,0)` 的 `#E0E4E9`/`#939BA6`、深色侧栏 `(0,3,0)` 的 `#48484C`/`#85858C` 均未被本批覆盖）。
  - 响应式 ✓：CSS 宽 3200/2560/1920/1707/1279/1024 下 `documentElement.clientWidth==scrollWidth`（**无横向裁切**），`.dock` 恒为 `340×52` 且始终落在 `mainArea` 内（`dockFits=true`）；浮层 720×560（1024 下 `682.5×456` 受视口约束）、中心始终等于 `mainArea` 中心、`scroll cw==sw`。覆盖 2K/1080p 的 Chrome 80%~150% 缩放。
  - 跨面复核 ✓：Signal 浅色侧栏仍 `366.5×44`/`r22`/`pad 0 6 0 14`/`#F5F7FA`/发送 `32×32`（其 `(0,6,0)` 覆写生效，仅图标 36→38）；Meeting 深色侧栏 `(live data-tone 缺失)` 仍深色 `#313134FA`、发送禁用 `#48484C`，仅基础几何 48→52、图标 18→16/发送 17→14（无裁切）。
- 注入假象与陈旧镜像（**不计为缺陷**）：
  - live JS 未包含本批 TSX，故 dialog **没有** `data-tone=light`、关闭图标仍为旧尺寸（实测 18px，新源码为 pen 的 14px）；浅色 composer/transcript 的实测值依赖上述 shim。
  - 旧 bundle 的 `@media(min-width:1800px){.dock{width:320px}}` 仍在，但被后置注入的基础规则覆盖（首轮误测的 320/48/5/5 即「注入未生效」而非规则冲突）。
  - Meeting 侧栏在 live 上是**深色**（旧 JS 未传 `tone:"light"`）；当前源码两处 `sidebar={{open:true,tone:"light"}}`，重建后由 `.sidebar[data-tone=light] .sidebarComposer .dock[data-in-history=true]`（0,5,0）接管为 pen 的浅色 `h44/r22/pad[0,6,0,14]`+`Send 32`，与 pen `会议材料对话`（`$surface`/`#ECEEF2`/`r20`）一致——该面属批次 5（M-02）结论，**待重建后才能截图验收**。
  - `≤1000` 且无 detail 打开时全局 Dock 被既有媒体规则隐藏（`[data-testid="global-controls"]{display:none}`），非本批引入。
- 残留（本批未做，属 §5 不可达或需产品裁决）：
  - D-04 的 **loading/pending/error 真实触发**不可达（需真实异步失败或提交，禁止伪造成功态）：仅完成静态令牌比对 + 可达禁用态。
  - 主按钮禁用现状 = accent 填充 + 全局 `:where(.shell) button:disabled{opacity:.55}`（实测 Issue「直接决定」`#007AFF` + `opacity .55`），视觉上等同 pen 的 **loading** 色而非 pen 的禁用灰 `#F1F3F6`；pen 的「禁用」与「加载中」在 live 里被合并为一种外观。要分开需新增 pending 属性/令牌，跨 5+ 模块且深色面不能直接套 `#F1F3F6` → **列为决策项**，本批只在自有面（Dock/浮层）改用 pen 令牌。
  - 焦点环：live 为 `outline:3px solid #007AFF88;offset 4px`（pen 为 2px `#007AFF4D` 无偏移）→ 保留 live（更强的可达性，不弱化）。
  - `.action-error`/`.action-conflict` 为浅底柔化样式（`#FDECEA`/`#9C4A40`），非 pen 的列表错误卡（白底 + `#E34B43` 图标 + `重试` 次按钮）→ 需真实失败才可验，列为决策项。
  - transcript 用户文字 `#25262B`（pen `#2B3240`）、`.meta` `#8A909B`（pen `#6E6E73`）沿用批次 3 既有共享令牌，未改动以避免回归 S-0x。
  - pen `Exp Header` 的 `Scope Chip` 与「按住说话」语音模式**不实现**（前者无对应行为，后者按本批约束排除；键盘输入模式保留）；`Card 引用` picker 保留（用户明确要求）。
  - `.t.empty` 在 `conversation-transcript.module.css` 中未定义（`undefined` 类，预存在），未修。
- **本批未执行**：整页截图验收（`warmap-web-1` 镜像陈旧且未获授权重建；批次 6/7 的截图验收一并待重建）。

**批次依赖**：0 → 1 → {2,3,4,5,6} → 7。批次 1 不做完，后续每批都要重复改圆角与字号。

---

## 4. pen（设计文件）自身缺陷，不应由代码跟随

| 位置 | 问题 | 建议 |
| --- | --- | --- |
| `Card / 战场卡 · 背面进展 / Todo · 输出东南 / Meta` | 文本字面量含 `undefined`：`2025-09-28 · 待外发 · undefined` | 修正 pen 文案 |
| `规范/交互状态` | 同一组件内 `列表加载用骨架而非转圈` 与 `首屏服务端直接展示 · 非骨架` 自相矛盾，且与已确认基线 #7 冲突 | 按基线 #7 修订 pen |
| `页面 / Radar 空状态` vs `规范/交互状态` 空态组件 | 空态标题两句不一致（`暂无待处理提请` / `本周没有待处理通知。`） | 统一文案后同步 live |

---

## 5. 未验证清单与最小复现

以下状态在**当前数据 + 只读约束**下不可达。每项给出阻塞原因与最小复现（复现需写状态，属独立授权）。

| 编号 | 未验证内容 | 阻塞原因 | 最小复现 |
| --- | --- | --- | --- |
| A-02 / A-03 | Access 精确几何、密码错误态描边/提示色 | 登录态下 `/access` 重定向；复测需先登出（状态变更） | 清 cookie → `/access` → 截图；再输入错误口令 → 截图（不提交任何其它写操作） |
| R-07 | Radar 空状态（`Orbit 100 + 还没有可读的 Signal`） | DB 中 8 条信号仅 1 条未隐藏，无法进入空态 | 用隔离 DB 或在 API 层加只读开关后截图；或临时把 `.stories` 数据源置空做视觉比对（需授权） |
| S-08 | 已读 Toast（`已标记为已读` + `撤销`） | 需执行 `PATCH` 标记已读，属写操作 | 打开 `/radar/signals/40a9a919-…` → 点「标记已读」→ 截图 |
| H-14 / H-15 | 通知浮卡实际尺寸配色、通知栏空态第二行 | 点击被 rail 每秒重渲染打断；且本周有 2 条通知，空态不可达 | 用 `evaluate_script` 在 `requestAnimationFrame` 内直接派发 `click` 到 `.card`（不改后端）；空态需清空本周通知的隔离数据 |
| I-07 | Issue `decided` 全页（Receipt、撤回决定） | DB 无 decided issue（`decided_at` 全空） | 用隔离 DB 造一条 decided issue 后截图 |
| M-07 | Meeting `held / Outcome 复核` 全页（三栏宽度、四色 Badge、状态色、操作） | DB 仅 scheduled 与 cancelled，无 held | 隔离 DB 造 held 会议 + 要点后截图 |
| P-06 | Monthly `协商中` 全页（三结果 section、Todo 卡、Commit Area） | DB 仅一条 confirmed（2026-09） | 隔离 DB 造 negotiating 计划后截图 |
| D-04 | loading / disabled / error 三态配色 | 需触发真实异步失败或提交 | 断开 API（或 mock 延迟）后点「手动补扫」「直接决定」；**不得**用伪造成功态替代 |
| R-03 | Radar 工具栏分段控件几何 | 首次测量只取到文案 | 重跑 §6 脚本，取 `.toolbar` 内按钮 `border-radius`/`padding` |

---

## 6. 人工复核命令（可复现本次结论）

```bash
# 1) 以 pen 原生视口打开页面（先登录一次，口令 202609）
#    MCP: navigate_page http://localhost/ → emulate viewport "2560x1440x1"
# 2) 一次性 dump 直接文本 + 几何 + 计算样式（替换 URL 即可复用到任意页面）
#    MCP evaluate_script，函数体：
#    () => { const out=[]; document.querySelectorAll('body *').forEach(el=>{
#      const t=[...el.childNodes].filter(n=>n.nodeType===3).map(n=>n.textContent.replace(/\s+/g,' ').trim()).filter(Boolean).join(' ');
#      const r=el.getBoundingClientRect(); if(!r.width&&!r.height) return;
#      const c=getComputedStyle(el); const cls=String(el.className).split(' ')[0];
#      if(!t && r.width<60) return;
#      out.push(cls+'|'+t.slice(0,55)+'|'+Math.round(r.x)+','+Math.round(r.y)+' '+Math.round(r.width)+'x'+Math.round(r.height)+' fs='+c.fontSize+'/'+c.fontWeight+' bg='+c.backgroundColor+' r='+c.borderRadius); });
#      return out.slice(0,40); }
#    ⚠ 函数字符串内不要出现 `||`（MCP 解析器会报 Unexpected token），用 ?? 之外的条件表达式替代

# 3) pen 侧几何/文案基线（只读）
python3 - <<'PY'
import json; d=json.load(open('UpgradeDesign.pen'))
for f in d['children']:
    if f.get('name','').startswith('页面 /'): print(f['name'], f.get('width'), f.get('height'))
PY
```

---

## 7. 附：已核对的基线回归项（本次无差异，勿改）

| 基线 | 证据 |
| --- | --- |
| #1 Radar 三源拆分 + outlets 只读、不显示为"微信公众号" | live 弹窗三行 `Web 搜索 / 微信公众号 / 发布方级媒体来源`，outlets 行列出 6 家 + `只读`；DB `radar_config.sources` 印证 |
| #2 dismissed Issue 为终态，无"重新纳入决策面" | `cards/IssueCard.tsx:115-119`；live dismissed 页无 restore 入口 |
| #3 Meeting Dock 统一命名"会议材料对话" | `rg "会前材料对话\|会前对话"` → 0 命中 |
| #4 不新增"后续推动建议"、无独立"外发状态" | `preflightOutline.ts` 中该文案为既有内容；payload 未扩展 |
| #5 登录失败文案"口令不正确"，无失败计数/锁定/重新申请 | `AccessScreen.tsx:43` |
| #6 通知空态"本周没有待处理通知。" | `NotificationRail.tsx:223` |
| #7 无通用骨架屏/加载系统，异步动作保留显式 loading/disabled 文案 | `rg "skeleton\|shimmer\|spinner"` 无业务实现 |
| confirmed 月度计划不出现保存/签发按钮 | live `/plans/2026-09` DOM 无「签发计划」 |
| Web 搜索行显示"未配置" | DB `radar_config.sources.sites[0].enabled=false`，属真实配置而非前端缺陷 |
