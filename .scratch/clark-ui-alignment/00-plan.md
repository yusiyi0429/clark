# 天枢 MVP 前端对齐 clark-main CEO 界面 · 计划与决定

## 目标
apps/web 的展示与交互 1:1 对齐 clark-main（v0.169.0）CEO 工作面（`src/components/ceo-warmap/*`）。交互不确定处以 `clark-main/docs/product/tianshu-ssot.md` 为准；美学不确定处以 `Desktop/clark/ts-design`（tkos-ui v0.4）为准。手机（≤690）、折叠屏（691–1000）、桌面（>1000）三档都要好用。

## 约束（用户 2026-09-23）
- 只改前端展示与交互；不改功能模块、后端、契约、前端调用逻辑。
- 没有后端支撑的 clark 功能不加（语音识别、同事频道、Co-Agent 显示区、战场三环/进展看板/指标、演示重置、角色切换、议题协作、监测范围编辑……）。语音只保留「语音未接入」态。
- 天枢独有功能保留，按 clark / ts-design 语言重做样式（会话/附件、决策路径、移出/恢复、会议材料/记录/Outcome、月度签发、Mission 页、配置页、原文证据高亮与图片）。
- 介于交互与调用之间的改动先问用户。

## 已拍板（2026-09-23）
1. 组件栈：换成与 clark 同栈 HeroUI 3.2.5 + Tailwind 4 + ts-design 0.4（版本钉死）。
2. 卡片开关：改成原地打开（首页与通知栏常驻；卡片形变成详情、通知栏折窄条；关闭形变回原卡、焦点复位；保留 URL；直接打开详情链接时额外读已有首页卡片接口画背景与通知栏，不新增接口）。
3. 门禁页：浅蓝锁屏 + 单口令输入框（不放角色切换）。
4. 需新增接口调用的交互（信号自动已读、皇冠、信号战略锚点/继续浏览）：都不做。

## 我方默认（未单独问，按 clark 为准）
- 对话回复展示按 clark：思考行（阶段 + 秒数 + 停止）→ 完整回复；（若等待过长影响体验再与用户确认）。
- 通知栏去掉「稍后处理」与 6 条上限（违反 SSOT C-05），按 clark 分组呈现天枢已有通知。
- 公司能力首页卡只列议题、不摆能力目标（SSOT CEO-01）。
- 折叠屏 691–1000：按 ts-design「双页阅读桌面」契约；clark-main 的折叠屏 bug 最后修，两边一致。

## 步骤
1. 设计基础：依赖、PostCSS、token（clark globals + heroui-tianshu）、字体/图标/品牌图、全局重置修正、VT CSS。
2. 外壳与卡片开关：共享 CEO layout、首页常驻、详情面板、通知栏↔窄条、peek（⌘\、左缘滑动）、View Transitions 开/关、焦点复位、Escape 链、三档响应式。
3. 首页看板。
4. 通知栏。
5. 对话（输入条、caption、历史、二级页右侧 rail、引用、思考态、错误文案、Escape、草稿）。
6. 二级页（议题、雷达/信号、会议、月度、Mission、配置）。
7. 门禁页 + 进入动画。
8. 灌测试数据（用 clark SSOT 同一套组织资料，经天枢配置接口）+ 三档浏览器验收 + 对话测试 + 测试/类型/构建；最后修 clark-main 折叠屏 bug。

## 参考报告
01-home-board.md · 02-notifications.md · 03-conversation.md · 04-detail-pages.md · 05-shell-tokens-access.md
