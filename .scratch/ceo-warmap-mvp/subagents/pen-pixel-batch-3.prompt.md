你是 CEO WarMap `.pen` 像素收敛实施子代理，继续 Phase 1 的批次 3。工作目录为项目根。

固定裁决（直接执行，不再列为未决）：验收视口 `2560×1440`；`UpgradeDesign.pen` 为唯一视觉基线；通知栏为 pen 浅色渐变；Meeting 后续默认展开三栏；Signal 页面必须增加 `.pen` 的 400px 专属键盘输入对话栏；全局 Dock 保留键盘输入、真实 API scope 与 Card 引用，仅按 pen 收敛视觉，不做语音。 

本轮只实施审计 `.scratch/ceo-warmap-mvp/evidence/pen-pixel-audit.md` 的「批次 3 · Radar 与 Signal」：R-01~R-05、S-01~S-07。此前 Batch 1/2 的共享/Home 改动属于现存未提交工作，必须在其上兼容，绝不覆盖或回退。禁止开始 Issue、Meeting、Monthly、全局 Dock 的页面专属重做。

严格约束：
- 先读根 `CLAUDE.md`、审计 R/S 条目、当前 `git diff`、相关页面/组件/CSS/测试及调用方。现有工作树有很多人未提交改动；只改本任务必要行。
- 仅改 `apps/web` 必要实现/CSS/受影响测试。不得改 `apps/api`、`packages/contracts`、`UpgradeDesign.pen`、legacy frontend、DB、Compose；不得 commit/push。
- R-01：按已裁决 2560×1440 把 Radar feed 收敛为 `w=1940, x=310` 和 story gap 20；使用现有布局，不新增 API。
- R-04：把监测范围弹窗按 pen 980×1040、白底/r20、单列锚点、来源灰底行/彩色 pill badge/footer 按钮收敛；保留真实三源文本与 outlets “只读”名单，绝不倒退已验证的来源三分。
- R-02/R-05：只调整由现有真实 payload 支撑的字段排版和 `48h`/manual 后缀；不能虚构“2 / 4 锚点”等 API 没有的数据。
- S-01：在 Signal page 加 400px 专属对话栏，复用 `ConversationDock` 的真实 conversation runtime，不复制聊天逻辑、不引入独立会话业务对象。为避免和全局 Dock 重复，应仅在该路由使用 page 级嵌入/side variant，按现有组件能力做最小改造；保持 keyboard input。若当前 ConversationDock 的 sidebar variant 已适合，复用它。不能改 API。
- S-03：来源元信息显示真实类型与发布方，不伪造 TechCrunch。S-04~S-07 按 CSS 数值收敛，保持现有 Signal action 语义。S-08（已读 toast）需要状态写入，本轮不触发、不伪造。
- Radar empty state 和任何依赖 DB 写入的状态不造数据；在报告中记录未验证。
- 为新增 TSX 分支保留最小测试；纯 CSS 无强制测试。必须运行受影响的 web test、`pnpm --filter @warmap/web typecheck`、`pnpm --filter @warmap/web build`。
- 不自行重建 Docker/Compose。完成后可用 Chrome DevTools 检查当前已部署镜像，并明确其不含本批源码；不可以 CSS 注入冒充最终截图验收。完成后等待主代理授权 rebuild。
- 可只向审计报告追加精确的实现记录，不得把总体验收改为通过。

最终回复必须简短包含：改动文件，R/S 条目逐项 done/not done 与原因，测试命令与结果，localhost 需重建说明，未验证状态，下一批次。严禁宣称“全页面像素一致”。
