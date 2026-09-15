# CEO WarMap 视觉与交互基线（Ticket 01）

本目录冻结旧 `frontend/` 中 CEO WarMap 在目标 scope 内的可复现视觉与交互证据。后续新 Web（`apps/web`，Ticket 14）以本基线做像素级与交互验收，而不是凭记忆比较。

- 采集对象：旧 Web 的公开浏览器页面（`/access`、`/`），经口令 cookie 进入。
- 采集视口：**1440×900** 与 **1600×1000**，deviceScaleFactor 1，Chrome headless（`--disable-gpu` 软件渲染）。
- 采集数据：全部来自 `tools/visual-baseline/fixture.mjs` 的确定性 fixture（路由 mock 注入，不改旧前端代码）。
- 本目录截图与 JSON 均为可重复命令的产物；本 fixture 不是新系统的业务数据源。

## 目录结构

```text
docs/visual-baseline/
├── README.md                  ← 本文件：清单、复现方法、结论
├── screenshots/               ← 46 张稳定截图（<状态>.<视口>.png）
└── evidence/
    ├── interactions.json      ← 66 项交互断言：动画终态/焦点/Escape/reduced-motion
    ├── design-tokens.json     ← 关键表面的字体、颜色、阴影、间距、Card 几何（两视口）
    └── health.json            ← 旧入口与健康状态记录
tools/visual-baseline/         ← 可重复采集工具（fixture.mjs + capture.mjs）
```

## 状态清单（scope 覆盖）

| 状态 | 截图 | 说明 |
|---|---|---|
| 登录入口 | `access.*` | 未登录访问任意页重定向 `/access`（evidence：`entry-gate-redirect`） |
| 首页默认 | `home.*` | 战略议题、雷达入口、双战场正面、公司能力、通知栏、对话 dock |
| 入场动画终态 | `home-entry-final.*` | `?_entry=unlock` 进入，覆盖层移除后与首页一致 |
| 战场正反面 | `battlefield-{lighthouse,tokenops}-{front,back}.*` | 翻面仅切展示面；背面含 Agent 评估与反馈依据 |
| 通知浮卡 | `notification-float-{confirmation,inquiry}.*` | 会后共识、负责人提请两类浮卡（月度/会议进入工作区） |
| Meeting | `meeting-preflight-product.*` | 议程卡进入会前预审工作区 |
| MonthlyPlan | `monthly-plan.*` | 月度协商通知进入月度工作区 |
| Radar 列表 | `radar-list.*` | 展开视图内的信号列表、筛选排序、扫描状态 |
| Signal 详情 | `radar-signal-reader.*` | 信号阅读器：影响、锚点、议题、来源摘录 |
| Radar 配置 | `radar-config-editor.*` | 监测范围对话框（本体监测/锚点/来源） |
| 对话历史 | `conversation-history-welcome.*`、`conversation-reply-history.*` | 全局对话记录层：欢迎页与带 Markdown 回复的记录 |
| 对话 dock | `conversation-dock-keyboard.*` | 键盘模式、输入展开 |
| thinking 终态 | `conversation-thinking.*` | 回答进行中的思考指示（mock 流延迟 900ms） |
| 引用托盘 | `conversation-dock-references.*`、`conversation-reference-preview.*` | 多卡引用 chip、引用内容预览 |
| Issue 工作区 | `issue-workspace.*`、`issue-workspace-research.*` | 总结与判断页签、研究与依据页签 |
| reduced-motion | `reduced-motion-*`（仅 1440） | 打开动作无 >0ms 运行中动画，几何与正常 motion 一致 |

## 复现方法

前置：Node 22+、pnpm、本机 Google Chrome。

```bash
# 1. 生产构建并启动旧 frontend（干净产物目录，不影响开发）
cd frontend
NEXT_DIST_DIR=.next-baseline TKOS_DATA_DIR=.data-baseline \
TKOS_ACCESS_PASSWORD=warmap-baseline TKOS_ACCESS_SECRET=warmap-baseline-secret \
pnpm build
NEXT_DIST_DIR=.next-baseline TKOS_DATA_DIR=.data-baseline \
TKOS_ACCESS_PASSWORD=warmap-baseline TKOS_ACCESS_SECRET=warmap-baseline-secret \
pnpm start -p 4318

# 2. 采集（覆盖本目录）
cd ../tools/visual-baseline
pnpm install
node capture.mjs            # 或 BASELINE_URL=http://127.0.0.1:<port> 指定地址
```

已验证：同一环境连续多次完整运行，66/66 项检查稳定通过；截图逐像素一致（PNG 编码器在个别文件可能产生字节差异，像素差为 0，不影响视觉比较）。跨机器重跑时像素可能因字体栅格化产生差异，容器几何与交互断言不受影响。

## 等长 fixture 约定

`tools/visual-baseline/fixture.mjs` 用全角空格把每类可变文本补齐到固定 JS 字符数（约定写在文件头注释）：`signal.title` 24、`summary` 66、`excerpt` 160、`issue.judgment` 60、`anchor.material` 100 等。时间戳全部固定（2026-09-15 时段），ID 以 `*-fixture-*` 命名。新 Web 做像素回归时应复用同一 fixture 生成等长内容，保证换行与容器几何可比。

内容为虚构演练材料，不代表任何真实公司事实；新系统不得把它当业务种子数据。

## 视觉 token 要点（详见 evidence/design-tokens.json）

- 字体：`-apple-system, system-ui, "Segoe UI", ...` 栈，正文 14px，行高随组件。
- 首页看板 1440：x 412 起（左侧通知栏约占 398px），看板 1014×872，内边距与卡片圆角 22px。
- 卡片底色纸白 `rgb(255,255,255)`，阴影为多层 inset/外投组合（每个表面的完整值在 JSON）。
- 通知卡颜色由 `--notice-color`（RGB 三元组）与 `--notice-alpha`（透明度评分反推）驱动，四类通知各不相同。
- 对话 dock 固定于视口底部居中；几何值见 JSON 的「对话 dock」条目。

## 交互结论（详见 evidence/interactions.json，66 项全部通过）

- **动画终态**：视图展开、议题 sheet（clip-path）、浮卡、战场翻面、月度/会议工作区打开后均能到达无运行中有限动画的终态；无限装饰动画在截图采集时统一暂停在 1500ms 相位。
- **键盘焦点**：打开视图/议题 sheet/浮卡后焦点分别落在各自的关闭按钮；战场翻面后焦点保持在对侧控制上；切换键盘模式后焦点进入输入框。
- **Escape 分层顺序（旧版实际行为，新 Web 需保持或有意改进）**：
  1. 键盘模式开启时，第一层 Escape 先收起键盘（回到语音模式）；
  2. 之后依次为：历史记录层 → 议题 sheet → 会议/月度工作区 → 展开视图；
  3. view + sheet 同开时，一次 Escape 只关最上层，视图保留（`escape-order-sheet-first`）。
- **焦点返回**：浮卡与议题 sheet 关闭后焦点返回原触发元素；**已知旧版缺陷**：从首页打开雷达等展开视图后按 Escape，焦点落在 `body`（原点按钮仍处于 inert 的首页表面，返回聚焦静默失败），已按原样记录（`radar-view-escape-focus-return`），新 Web 可在此基础上修复。
- **reduced-motion**：`prefers-reduced-motion: reduce` 下打开视图与议题 sheet 均无 >0ms 的运行中动画，且终态几何与正常 motion 完全一致。

## 旧入口与健康状态（evidence/health.json）

- 入口：`http://127.0.0.1:4318/`（生产构建，commit 标识 `dev`），口令经 `TKOS_ACCESS_PASSWORD/SECRET` 配置，cookie 为 HMAC 签名，12 小时有效。
- `GET /api/health`（公开、无副作用）：`status: ok`；上游模型/图服务/检索均未配置（`model:false`、`search.providers:["none"]`），雷达数据由 fixture mock 提供，采集流程不依赖真实外部服务。
- 采集时间：2026-09-15T07:12Z（首次冻结）；复跑会覆盖更新。

## 边界

- 本 ticket 不修改旧前端业务行为，不迁移、不删除旧 `frontend/`；采集工具通过 Playwright 路由 mock 注入数据。
- 对话回复、战场评估为 fixture mock，只用于呈现相应视觉状态，不代表真实模型输出质量。
- 旧前端随开发演进可能导致截图漂移；冻结基线以本目录当前内容为准，复跑仅用于重新生成或验证。
