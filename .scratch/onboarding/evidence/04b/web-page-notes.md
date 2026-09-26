# 04b 个人卡页面移植记录

页面部分由 `MissionCardScreen` 统一提供，成员与 CEO 仅入口前缀与路由守卫不同；正文依据同一个服务端投影。外壳和群组接线见最终报告。

## 页面改动

- `apps/web/src/components/missionCards/MissionCardScreen.tsx`：移植概念 `workspace.tsx` 的阅读页组合、行内修改建议、划词、反馈、冻结目标弹层、重开确认；接真实 API 与 ConversationHost 群组上下文。
- `CardDocument.tsx`、`mission-card.module.css`：移植概念 `card-document.tsx` 的版本行、个人任务、字段列、挂字段的意见和整卡意见；保留原件可选分支，10 月不启用。完整呈现 13 字段，12 个字段允许建议，责任人只读。
- `RoundLine.tsx`、`round-line.module.css`：移植概念 `round-panel.tsx` 的单行、展开五步、各卡入口、目标和本轮状态；首次按人和轮次自动展开一次。拍板人在草稿期可统一开放；待拍板期可重开。
- `RoundClock.tsx`、`round-clock.module.css`、`useRoundNow.ts`：移植概念 `countdown.tsx`，按服务端校时；同一个截止时刻一个定时器、按截止秒位跳分钟、回到前台对表；不出现负倒计时或演示窗口。`glass` 预留样式也采用晨光墨色。
- `loadPersonalMissionCard.ts`、两个 `mission-cards/[cardId]/page.tsx`：个人卡加载、角色守卫、401/404 分流。
- `personalMissionCard.test.tsx`、`missionCardScreen.test.tsx`、`useRoundNow.test.tsx`、`personalMissionFixture.ts`：页面测试与合成 fixture。

## 测试先后

2026-09-27 先添加页面测试，首次运行因缺少 `CardDocument` 模块失败，确认在实现前建立检查。实现后 20 条中 13 条通过、7 条倒计时测试失败；根因是 Windows 上 `./RoundClock` 优先匹配大小写相同的 `roundClock.ts`。共享时钟改名 `useRoundNow.ts` 后 20/20 通过。

随后补齐首次展开、提交建议成功/失败/409、重试幂等及共享时钟测试，达到 28/28。浏览器断网演练再补两条失败呈现检查，最终本页专属 **30/30 通过，3 文件**。最初命令 `pnpm --filter @warmap/web test -- src/components/missionCards`；浏览器副本存在期间改用 Web 目录下 `node node_modules/vitest/vitest.mjs run src/components/missionCards`，避免工作区自动同步依赖。`node node_modules/typescript/bin/tsc --noEmit` 同时通过；全量测试由主报告记录。

浏览器 `member-suggestion-offline.png` 确认了断网时输入保留，但原错误出现在页首、当前编辑位置不可见。先新增两条测试得到 **4 通过 / 2 失败**，随后把建议错误独立为 `proposalError`，显示在行内输入与提交按钮之间，并通过 `aria-describedby` 关联输入；fetch / NetworkError 转为「暂时无法连接服务器，请稍后重试；输入已保留。」。动作与刷新错误仍在页首。修正后全部 30 条通过；修改文件已同步到临时 Web 副本供 HMR 与复测。

验证包括：五阶段字段按钮、责任人不可建议；列表原文连接；占位来源三处；保存时原文与源版本；跨字段划词拒绝；未开放/48 小时/31 小时 24 分/42 分/不到 1 分/截止/已确定/重开轮次；开放按钮只给草稿拍板人；首次展开按人按轮去重；建议成功才清空、网络和 409 失败保留输入；原样重试复用 clientId，改字后生成新的 clientId；引用绑定当前卡及 Mission 源版本；共享时钟、校时、截止秒位、恢复前台、订阅清理。

## 未搬的部分与原因

- `WorkspaceShell`：用现有 `DetailFrame` + 统一 CEO/成员外壳承载，相同阅读页、右列和展开逻辑；避免出现第二个壳和第二个对话列。
- 演示控制台、拨钟、模拟起草等待、Review 扫光/节拍、写入候选的模拟流光：设计明确禁用；只显示真实服务端状态。
- 本机 `model.ts` / `store.ts` 状态机、localStorage 业务数据、模拟 Agent 回复：被服务端投影/写入和真实私有 scope 替代；只有本轮是否已讲解这个显示偏好保存在浏览器。
- 目标签发和草稿整理表单：MVP 已有月度计划签发与 04a 整理入口，个人卡这里只读目标、统一开放。
- 10 月原件页签、下载原件、飞书全文：无 10 月原件且设计 §0.A 禁止保存正文；可选原件阅读分支保留，但未接 API 数据、不出入口。来源链接与 revision 完整保留。
- 概念版「未报告」、成功证据执行状态、完成率：MVP 的 Mission 是结果承诺，不追踪执行；证据和里程碑保留原文。
- 逐条采纳/不采纳、从第一条开始、确认前核对表单与整轮确认：归 04c；当前呈现服务端处理结果与候选字段，没有放不可用的动作。04a 已有重开动作可在本页执行。
- 通知分组和共享时钟接入通知栏：归 04d；本页时钟已可共享。Windows 模块名使用 `useRoundNow.ts`，避免设计草图 `RoundClock.tsx` / `roundClock.ts` 导致不区分大小写的解析冲突。

## 美学与消融

概念版的页头胶囊、本轮单行、版本来源、字段阅读列、行内建议和意见痕迹保持同一层次；正文最大 840px，实心 `--surface`，页头/弹层映射晨光厚玻璃 token。截止时刻、拍板人、Owner、来源均为可阅读正文尺寸。圆角复用 24/16/12 token，主行动 17px/600 实心天枢蓝，触控目标至少 44px，手机字段改为上下阅读。右列收起时正文让出其 56px 控件通道。减少动效、减少透明度和高对比有对应回退。

天枢蓝配白字约 3.6:1，按已定产品要求使用 17px/600 主按钮；本页不自行替换品牌蓝。未增加运行时依赖、通用表单框架或新状态机；逐项移除演示状态和未授权业务动作。浏览器尺寸与最终美学验收由主报告记录，不把静态测试当作视觉通过。
