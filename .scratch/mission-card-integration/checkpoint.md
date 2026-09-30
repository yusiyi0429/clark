# 暂停交接点

此记录为暂停时的历史交接。用户恢复后，剩余实现与桌面/手机验收均已完成。最新状态见 spec.md 与 report.md；下列“尚待完成”列表是历史记录，已全部处理。

2026-09-30，用户明确要求暂停，回家后再继续。所有子代理已停止，代码已落盘；未 commit、未 push、未部署。基础分支 `feat/mvp-member-workspace`，HEAD `d0af641`；不整体 merge 旧分支。

## 已完成

- 当前分支保留直接批注、私聊引用、Agent 即时改写、澄清与完整修订历史，移植本人审核、取消确认、全员自动汇总、统一页头及状态。
- 服务端仅审核期间未本人确认时即时改写，sourceRound 和所读版本保护；pending 批注阻断完成/汇总，明确保留备注及原因可解除阻断。重开清空确认，旧建议过期禁止采纳。迁移 053。
- API 隔离回归 103 项、私聊/Agent 工具 17 项通过；contracts 9 项通过；Web 21 文件 247 项通过，后续冻结提示对应 42 项复验通过。
- API、contracts、Web 类型检查通过。OpenAPI 与客户端已由生成管线更新。
- 真实浏览器已通过 320/360/390/768/959/1440 页头 48px/无重叠检查、任务视图/禁用执行拆分、直接批注即时改写且不进私聊、澄清自定义输入后改写及历史。
- 五页案例引导曾在桌面/390px通过真实动画、不能跳过首次观看、观看状态保存与问号重播；随后第五页文案/状态更新需要最终复验。

## 尚待完成（恢复后继续）

1. 检查并修复 `useMissionAnnotations` 保存期间旧 GET 短暂覆盖新状态的竞态（审查发现，服务端写入保护有效，2.5 秒轮询会恢复）。建议在成功 POST 后也推进 generation，且同卡切换时保护回应，补有意义的乱序测试。
2. 完成浏览器闭环：第三条失败批注明确保留原因、完成/取消本人审核、提前汇总提醒、重新开放、页头切人、最后一人自动汇总单快照、最终确认及历史。当前 flows.cjs 停于两条“保留备注”按钮同时可见的严格选择器歧义，需等待第三条 failed 状态并将动作限定在该批注区域；不可仅靠 `.first()` 掩盖选择错误。
3. 最后手机 CSS 修正已写入源码但未复制到预览：≤959px右边距 12px，删除旧 container 54px 预留；桌面真实展开按钮仍由共享框架预留。复验 320/390 标题与热区、批注/澄清弹框。
4. 将最新源码复制到隔离预览并重新验收第五页引导；完成外围 diff 审查、diff check、选择性暂存、commit。不要 stage 其他历史 scratch/output 文件，不要 push（此前请求以 commit 收束）。

## 恢复工具与环境

我启动的临时 API 4592 已优雅停止并删除自己的随机测试库；临时 Web 3512 也已停止。已有 3500/4500/PG55432 服务未动；正式数据从未用于本次验收。

- 预览：`.scratch/preview-web-mission-integration`，node_modules 是现有 Web 的 junction。复制最新 `apps/web/src` 到这里，设置 `API_SERVER_URL=http://127.0.0.1:4592`，运行现有 Next CLI，端口3512。
- 隔离 API：删除本目录 `run/stop` 这一文件，设置 `TEST_PG_URL=postgres://postgres:postgres@localhost:55432/postgres`，用 `apps/api/node_modules/tsx/dist/cli.mjs` 启动本目录 `server.ts`；每次创建独立随机 `warmap_test_...` 数据库，run/fixture.json 返回新 ID。
- 浏览器：本目录 `flows.cjs`、`tour.cjs` 使用已安装 Chrome/Playwright；重新启动后按 agent-browser-verify skill 先做真实浏览器检查。只有本地隔离验收使用假模型与测试数据。
- 暂停保险：`run/paused-tracked.patch` 保存暂停时已跟踪文件差异；新增文件本身也已落盘。run/evidence/log 忽略。最终 code 由工作区本身为准，不应用旧 patch 覆盖新改动。
- 直接用各 package 现有 Node CLI 检查；常规 pnpm workspace 命令会被已有 web-manual-preview 的缺失 vendor tarball 阻断，勿安装/改锁文件来绕开。

代理状态：annotation_review 后端完成；tour_design 前端完成并已暂停；private_mission_edits 工具完成且最终审查已暂停。恢复时可继续使用这些代理；本次用户已授权多 Agent 和推荐方案。
