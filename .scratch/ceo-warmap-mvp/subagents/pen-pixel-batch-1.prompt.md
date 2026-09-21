你是 CEO WarMap `.pen` 像素收敛实施子代理。现在从审计转入实现，严格执行本任务范围。

已裁决的基线（无需再次提问）：
- 视觉验收固定为 UpgradeDesign.pen 原生 2560×1440。
- 通知栏后续按 pen 的浅色渐变，不保留深色壁纸玻璃。
- Meeting 后续按 pen 的默认展开三栏布局。
- Signal 后续增加 pen 的 400px 专属对话栏。
- 全局 Dock：选项 B。保留键盘输入交互、真实 API scope 和 Card 引用；只按 pen 收敛尺寸、材质、位置。此为有记录的功能例外，不能实现语音、不能删除键盘输入。

本轮只实施审计报告 `.scratch/ceo-warmap-mvp/evidence/pen-pixel-audit.md` 的「批次 1 · 共享令牌与栅格」：G-01 至 G-06。不要提前做 Access/Home/Radar/Issue/Meeting/Plan/Dock 的页面结构重做，除非某处是 G-01~G-06 的共享令牌引用、且改动不超过必要范围。

硬约束：
- 修改仅限 `apps/web` 中必要实现、样式与最小受影响测试。不得改 apps/api、packages/contracts、UpgradeDesign.pen、legacy frontend、数据库、Compose。不得 commit/push。
- 先完整阅读根 CLAUDE.md、审计报告的 §1/§2.1/§3 以及 `git diff`、目标调用链和现有 CSS。工作树已有许多他人未提交修改，绝不覆盖、回退、格式化无关部分。
- 使用现有 CSS module / custom properties，不新增设计系统、依赖、抽象或页面。
- G-02/G-03 可能波及大量页面：只在当前共享 CSS 和真正的公共规则上收敛。页面专属字号/圆角留给各自批次；不要做全仓逐项替换。
- G-06 仅将现有 Issue 主行动「直接决定」校正为 pen 的 accent/白字/r=10，保留 disabled/loading/error 行为；不要改 action 语义。
- G-05：按 pen 三段线性渐变收敛 shell 底色；若现有紫色 radial 是独立装饰，移除它。不要影响可读性。
- 为每个实质 CSS/TSX 修改保留或新增最小测试；纯 CSS token 不强制新增单元测试。至少运行 `pnpm --filter @warmap/web typecheck`，并运行受影响的现有 Web tests；完成后用 Chrome DevTools 在 https://localhost（若当前运行镜像未包含改动，允许仅说明需 rebuild，不自行改 Compose）以 2560×1440 检查一张 Home、Issue、Monthly 页面；对未重建状态如实说明。
- 绝不声称全页面已像素一致。本轮的完成条件是 G-01~G-06 的本轮可影响部分已收敛、没有突破页面批次边界、测试通过。

最终报告只包含：改动文件、每项 G-01~G-06 已做/未做和原因、实际命令与结果、Chrome 验证状态、下一批次。报告不要改审计结论；可更新审计报告的批次状态，但仅限准确记录本轮已完成项。
