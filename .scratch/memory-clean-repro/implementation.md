# 方案 A 实施与验证

实现基于 `73e05cdcf87ba1d322f4a6214e09b31972c4374f`，交付目标为 `codex/main-chat-memory-langsmith`。

## 行为

- Personal 只学习由 currentSequence 本人原话支持的变化；历史只解指代。明确记住、纠正、遗忘和重新授权各自保留原有权限与排除边界。
- 候选状态为 apply、noop、needs_clarification，严格校验状态与 changes/clarification 组合，成功说明不得放入澄清字段。
- 候选提交后，在同一执行中完成业务校验与写入；实际失败写入 AgentRun 和 Trace，完成结果记录 memoryOutcome、revision、epoch 与变化数量。
- Company 查询和续页参数互斥，续页恢复服务端保存的原 query。
- 工具 Trace 记录真实返回，Pi 历史保留占位；Reference 与嵌套 JSON 凭据继续脱敏。
- 不改 World 权威、原子提交、版本、epoch 或遗忘屏障；无数据库迁移。

## 验证证据

- 15 个 API 相关文件 113 项通过：`/tmp/memory-a-regression.log`。
- Contracts 75 项通过。
- API typecheck、build 与 git diff --check 通过。
- 新测试先确认本轮契约、互斥参数、工具正文观测和候选完成边界失败，再实施；原有正文隐藏断言按既定 ADR 更新，凭据与遗忘断言保留。
- 真实 worker + Pi Responses + 独立 PostgreSQL + 文件存储的一次自然归纳成功，只提交 seq3 的本轮偏好，revision1 后可召回：`/tmp/fresh-personal-repro/a-live-worker-output.json`。该脚本末尾独立测试库清理出现 57P01，不能将整体进程退出码称为通过；业务结果有独立持久证据。
- 新 Company 工具 schema 经两次真实 Responses 调用验证，模型查询合成资料后正确回答：`/tmp/fresh-company-repro/real-provider-contract.json`。没有调用真实 World。
- 独立复核未发现阻塞项；未重新执行全部仓库测试，未部署公网网页。

## 环境

CEO API 使用当前源码运行在本地 4317 端口，合成只读 World，LangSmith 上传关闭。测试产生的合成体验库数据已重新清空并迁移，初始聊天、原文、Personal 文档和任务计数全为0。CEO 登录与空历史再次通过 HTTP 验证：`/tmp/tianshu-clean-ceo-runtime/a-http-proof.json`。凭据仅保存在权限600的临时文件。
