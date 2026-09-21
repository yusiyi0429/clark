你是 CEO WarMap `.pen` 像素收敛实施子代理，继续 Phase 1。

固定裁决：验收视口 `2560×1440`；UpgradeDesign.pen 是唯一视觉基线；Home 通知栏改 `.pen` 浅色渐变（不保留深色壁纸玻璃）；Meeting 后续默认展开三栏；Signal 后续有 400px 专属对话栏；Dock 保留键盘输入/真实 API/Card 引用，仅视觉收敛。不得再说这些未裁决。

本轮只实施审计 `.scratch/ceo-warmap-mvp/evidence/pen-pixel-audit.md` 的「批次 2 · Access 与 Home」：A-01~A-03、H-01~H-15。不要进入 Radar/Signal/Issue/Meeting/Plan/Dock 的专属结构工作。此前 Batch 1 已改共享 shell tokens，基于它继续，不覆盖。

约束：
- 只能改 `apps/web` 实际必要的组件/CSS/最小测试。不得改 apps/api/contracts/UpgradeDesign.pen/legacy frontend/DB/Compose，不得 commit/push。
- 先读根 CLAUDE.md、审计 A/H 条目、已有 git diff 和相关调用链。保护未提交修改；只在现有内容上精确合并。
- Home 必须按已裁决把 Notification Rail 改为 pen 浅色渐变 + 白色半透明描边 + r20，并移除深色壁纸效果；不得修改通知数据、轮询、Action。
- 修复日期 `918` → `9月18日`。Home 面板/雷达面板/扫描盘/战略行/能力纵向布局/分隔线/工具栏等严格按审计最小边界。不制造没有 API 数据的 Due。
- Access：保留 heading 语义但视觉隐藏；错误文案仍仅“口令不正确”。若可通过浏览器清 cookie 后验证，不得写数据库；否则至少 CSS 按 pen 对齐并说明。
- H-14 通知浮卡：如果现有交互 DOM 已有，则只按 pen CSS/几何收敛；不能稳定触发时不要更改数据或添加 mock。
- H-15 空态文案：以已确认基线“本周没有待处理通知。”为准；不要添加与此冲突的第二句。
- 不引入通用 skeleton、语音、认证锁定、API、状态迁移或新页面。
- 为任何 TSX 条件/格式逻辑新增最小测试；纯 CSS 不强制。运行受影响 web tests + `pnpm --filter @warmap/web typecheck` + `pnpm --filter @warmap/web build`。
- 完成后因 localhost 镜像不会自动同步，先报告源码和检查；不要自行 docker compose rebuild。若能用 Chrome DevTools 在当前旧镜像精确说明差异即可。
- 可在审计报告里准确标记已完成 A/H 项，但不要改审计结论。最终报告：改动文件、A/H 每项已做/未做、命令结果、需重建说明、下一批次。绝不声称全页面像素已一致。
