# 交接：发布 PR #4 并正式导入 9 月复盘（2026-10-08 13:40，写给 Codex）

接着你 12:54 的 `7b4fca3` 发布往下做。部署记录在 `C:\Users\10021\Desktop\clark\_deployments\tianshu-20261008\`，沿用你的脚本和做法即可。Sean 已同意由你继续部署；每一步照旧向 Sean 报结果，不确定的先问。

## 1. 要发的东西：PR #4

- https://github.com/TokenkingOS/Tianshu-MVP/pull/4，分支 `fix/october-ui-polish`，基于 `fe3a0ab`（= 线上 `7b4fca3` 的 main 合并提交）。合并前以 PR 页的最新 head 为准（写这份文档时是 `b75ae86` 之后再加这份文档的提交）。
- **没有迁移**。API、Web 都有改动，所以两个镜像都要重建（`7b4fca3` 时 Web 没变，这次变了）。
- 内容：
  - Web：手机上能写材料批注（触屏 `selectionchange`，「写批注」和输入框 portal 到 body 固定在底部）；电脑上批注输入框打开时 `scrollIntoView`；≤959px 签发区换行；战场编辑「保存」按钮样式。
  - API：`missionRounds.ts` 起草失败文案（非战场 DRI 看到「起草未完成 · 等{DRI}重试」）；`materialSelection.ts` HTML 预览选区脚本在触屏上听 `selectionchange`。
  - **seed：`seed/imports/reviews-2026-09.json` 变了**（见第 3 节）。服务器上 `/repo/seed/imports/reviews-2026-09.json` 要换成新文件，换完核对 SHA-256 与仓库一致。
  - `.scratch`：上线决定、world-02 原始导出、工单 02/03 浏览器验收记录、时间机器修复。
- 本机已验：api/web 类型检查；Web 全量 812；API 相关 `missionRounds`、`objectMaterials`、`materialAnnotations`、`config`、`reviewImport` 共 76 条；浏览器（时间机器）逐项看过。PR 的 CI 以 GitHub 结果为准。

## 2. 发布顺序（同你上次）

CI 全绿 → 合并 PR #4 → 服务器建 `warmap-api:<sha>`、`warmap-web:<sha>` → 加密备份 → 切换 → 公网与 world-02 只读检查 → 逐人只读读取核对。旧镜像保留为 `before-<sha>`。

## 3. 9 月复盘导入：文件变了，开工时间也变了

**文件**：CEO 在 10/8 11:10–13:26 给 5 个人的飞书复盘末尾加了「CEO反馈」一节（白田田、陈溪南、孙铭泽、刘人豪、于斯一；刘人豪那份有两节）。Sean 决定带进导入：整节原样（去掉 callout 标签）接在各自 `selfReview.overall.text` 后面，本人自评原文不变。王创峰的文档还没有 CEO 反馈，Sean 决定不等。能力域 03、05 的导入项按人引用个人复盘，会一起带上。
- 你 12:5x 的 dry-run 用的是旧文件，结果里的人数和状态不会变，但要用新文件重跑 dry-run 再正式导入。
- 导入对已导入的人会「已导入，跳过」：**导入之后 CEO 再改飞书，内容进不来**。正式导入前可以再看一眼 5 份文档的 `obj_edit_time` 是否晚于 13:30（CEO 反馈是 13:30 前后取的；白田田那份最后改在 13:26）（`lark-cli wiki +node-get --as user`），晚了就告诉 Sean。

**开工时间（`--cycle-start`）**：Sean 定的是「这次发版完成那一刻」，**不是**你 dry-run 用的 `2026-10-08T12:11:27.953+08:00`。用 PR #4 切换完成、检查通过的时刻（上海时区 ISO），72 小时截止随之顺延。用之前跟 Sean 确认一下具体时刻。

**顺序**：`reviews:import <file> --cycle-start <ISO> --dry-run` → 正式 → 再跑一遍确认不重复写入。API 要在运行中（调度器每分钟接手秦梦怡、唐巨杰的起草；API 重启会把正在起草的标成失败，需要点「重新起草」）。观察两人从 drafting 到 draft，记下真实模型的耗时。

## 4. Sean 已定的其他事（`.scratch/october-launch/map.md` 末尾）

- 工单 01「不覆盖」：只跳过已提交、CEO 已跳过、本人改过的个人复盘；系统自动起草、本人没碰过的草稿照样被导入覆盖。
- 复盘项来源文案不区分，都写「飞书导入 · 未在天枢逐项确认」。
- 签发前要把各战场参与者名单设好（名单为空的战场签发时不起草，之后也补不了）。签发、改名单、`access:issue` 发码都是业务操作，不在这次发布里，等 Sean。

## 5. 发布后建议看的（还没人看过）

- 工单 01：个人复盘页副标题「从飞书导入」，「依据」里的飞书链接点得开；5 个人的「总体」末尾能看到「CEO反馈」；能力域 03/05/08 显示「飞书导入 · 未在天枢逐项确认」。
- 工单 02/03 已在时间机器里验过，记录在 `issues/02-*.md`、`issues/03-*.md` 的 Comments。

## 6. 没验证的

- 真实模型下：秦梦怡、唐巨杰的复盘起草；签发后起草全部成功→自动交给本人。
- 手机上在 HTML / Word 预览里选字写批注（iframe 无同源沙箱，模拟器里无法脚本选字）；iOS 键盘弹起时底部输入框的位置。

## 约束

- 不打印 `.env` 和凭据；不碰 `tkos-secrets`。
- 推送前 `git remote -v` 确认是 `TokenkingOS/Tianshu-MVP`。
- 本机还开着两套环境：3200/4100（Sean 测封面用，`.claude/worktrees/october-launch`，库 `warmap_launch`）、3500/4500（时间机器，`.claude/worktrees/october-fixes`，一次性测试库）。不要停 3200/4100；3500/4500 用 `pwsh -NoProfile -File .claude/worktrees/october-fixes/.scratch/manual-test/stop.ps1` 关。
