# 主私聊记忆重构：事实归属与读取边界

Status: design-agreed; implementation-not-started
日期：2026-10-15

本文件是事实归属审计。后续确认的 Anchor / Reference 方案以 [开发规格](context-contract.md) 为准；存储与更新见 [记忆实现设计](memory-design.md)，执行顺序见 [开发工单](map.md)，实测结果见 [预验证报告](validation.md)。业务运行代码尚未改造。

## 范围与已确认决定

面向 apps/web 主私聊及 apps/api Pi Conversation Runtime。群组消息、任务卡批注与 apps/m2 不在功能改造范围内。

- TKOS World 是公司事实的唯一权威源。World 中对象的状态本身也是事实；草稿对象应表达为草稿的存在与内容，不能改述为已经履约或完成的成果。
- Company 是 World 的可重建阅读投影，没有独立事实编辑权。推理用于理解关系、组织上下文；未经事实支持的经营推论不写入 Company 正文。
- 公司事实变更通过产品流程写入 World，主 Agent 不直接写回。
- Company 正文与模型上下文不包含 sourceFingerprint、来源声明、同步台账等机器信息。更新所需的对象对应关系和版本仅供后端使用。
- Personal.md 按 personId 私有，自动蒸馏个人偏好、稳定约束、反复出现的个人情况与谨慎归纳的特征，不保存公司事实副本。
- 先完成归属核对，再切换读取链路。此文件记录设计和源码核对，不表示已经接通 World 或完成 MCP 删除。

## 源码核对结果

| 内容 | 当前存储或读取位置 | 目标归属与处理 |
| --- | --- | --- |
| 公司战略、商业模式、客户、组织认知 | seed/memory/CompanyMemory.md；companyMemory.ts 启动加载 | Company 只能由 World 形成；旧文件只参考章节组织，不能作为内容补齐源 |
| LTCO | company_strategy_config；strategy.ts | 当前公司目标读取 World；本地编辑过程属于产品流程，提交是否落 World 必须显式处理 |
| 战场、能力域、长期目标、业务负责人 | battlefield_config、capability_config | 公司认知读取 World；本地页面布局、表单与流程配置可保留，但不能平行提供同一公司事实 |
| 月度结果与计划 | monthly_plans，含 draft/negotiating/confirmed | World 提供公司事实；本地协商草稿与签发流程保留为流程态，不能仅因本地 confirmed 就宣称已同步 World |
| Mission 的责任、预期结果、依赖、里程碑 | missions；listConversationMissions | 主 Agent 公司查询改走 World；本地卡片候选、审批与历史仍是产品流程或历史记录 |
| 执行事项状态、材料、进展和验收 | tasks、task_progress 等 | 当前天枢流程状态在本地；World 若已有相应对象，必须区分本地操作状态与 World 事实，不能靠同名或标题合并 |
| 议题、信号、预研、会议、逐字稿、结论候选 | issues、signals、meetings 等 | 保留为当前产品对象上下文；候选、讨论和待办不进入 Company；已写入 World 的公司结论以 World 为准 |
| 冻结目标、已发送引用、旧版计划 | goal_snapshot、references_snapshot、历史对象版本 | 保留为明确的历史快照，不改写历史，也不当作当前公司事实 |
| 登录身份、角色与权限 | company-people seed、member_access、session 校验 | 与记忆模块解耦；继续按稳定 personId 校验。World 业务负责人不自动成为天枢登录角色 |
| 个人偏好、习惯与个人情况 | 目前仅有聊天与 Pi entries | 独立的每人 Personal.md；当前指令优先于历史偏好，单次情绪不直接变成长期特征 |
| 聊天原文和运行态 | conversations、conversation_messages、agent_runs | 仍由 PostgreSQL 保存；Pi entries 是可替换执行态，不是 Company/Personal 的事实源 |

以上是公司事实的目标归属，不代表 World 当前覆盖了表中所有内容。未覆盖部分应如实缺失，不能使用旧 Markdown 或本地正式字段静默补齐 Company。后续确认的 Anchor 可以保留与前端 Card 对应的本地页面值，但必须表达为“当前页面内容／草稿／历史快照”；它们不自动成为 World 当前事实。这次改造不删除本地业务库，也不重写既有业务流程。

## 必须一起治理的模型入口

1. `app.ts` 为 Pi 注入 `globalConversationContext` 与 `listConversationMissions`，当前均读取本地库。
2. `piConversationRuntime.ts` 的 `get_warmap_overview`、`list_missions` 及 `search_people` 当前可提供本地公司信息。
3. `conversations.ts:getScopeObject` 自动把本地 Card payload 带进当前对象；执行事项上下文还联查本地 Mission、战场目标和月度目标。
4. `conversations.ts:resolveReferenceSnapshots` 会把议题、会议、计划和 Mission 的本地 payload 作为显式引用传给模型。
5. 成员议题和会议快照由 `routes/conversations.ts:scopeObjectFor` 单独投影，同样要遵守事实边界，不能只改 CEO 路径。
6. Pi 历史 entries 可能仍包含旧工具结果与公司摘要。切换后不能继续把旧执行态当作当前事实：保留原始聊天，按新的记忆策略重建执行上下文；历史内容明确按历史理解。

一致性治理在进入模型之前执行。不能仅用一句 system prompt 要求模型自行裁决两个冲突事实源。

## World 读取能力：已有与尚未验证

已有代码：

- `worldClient.ts` 提供列表分页、对象详情、外部引用查询，以及 prepare/commit 写入。
- `worldMissions.ts` 的显式脚本只关联三项已配置 Mission；不能视为全公司的实体映射。
- `worldMeetingEvents.ts` 单独发送 E&O 已确认会议条目；当前没有通用公司数据同步闭环。
- `routes/ontology.ts` 仍保留旧的周进展导出接口；不属于新的 Company 读取实现。
- `pendingOntologyUpdater` 默认保留 pending，不能把这条路径视为已经更新 World。

仓库中的 World 示例包含 business.blocks、relations、identity 与 records。当前 `WorldObject` TypeScript 类型只描述了窄子集，直接调用 `getHead` 会丢掉 Company 所需的正文与关系信息。Company 读取需要明确的完整响应契约与内容适配。

尚未验证：当前实例的实际可读类型、全公司覆盖、服务身份权限、最新返回形状，以及变更发现能力。不能根据旧 E&O 实例示例推断这些已经具备。没有证据支持时不假定存在搜索、变更订阅或增量游标。

## Company 生成与消费

- 链路：授权范围内的 World 读取 → 正文与关系提取 → 去重及时间整理 → 有界章节 → Company 上下文。
- 目录可参考原文件：公司方向、业务结构、商业模式、目标客户、组织责任、阶段目标、协作约束。无 World 内容的章节不编造、不从旧文件复制。
- 只维护一份当前阅读投影。刷新先生成完整候选，再整体替换；失败保留旧文件用于历史诊断，但不能继续当作已经核实的当前事实注入。
- 为本轮问题读取的 World 状态优先；读取失败时说明无法取得当前事实，不退回旧本地目标或旧记忆冒充最新状态。
- 精简的稳定公司背景可常驻；相关章节按需读取；对象详情与动态状态实时查 World。具体预算用代表性问题验证后确定，不凭空规定大量固定注入。
- 阅读正文不含对象 ID、版本号、哈希和来源标签；后端解析引用、解析负责人显示名并维护更新关系。业务需要的日期、周期和状态保留。
- 业务链接等用户需要的内容不能仅因字段叫 artifacts/url 就全部删除；正文输出避免把来源链接或协议元数据当作知识内容。
- 服务令牌可读取的范围不等于每个用户可读取的范围。共享存储不等于全员可见，进入上下文前保留现有访问边界。

## Personal 更新与消费

- 只使用当前本人有权访问的主私聊，不能从其他人的私聊、群消息、任务卡批注或 M2 蒸馏。
- 成功会话结束后异步蒸馏，不阻塞响应；同时检查用户纠正与“不再保留”指令，避免依赖助手成功回复才能处理遗忘。助手推测不能充当用户事实。
- 更新采用合并、替换、移除；没有长期价值的内容不写入。公司对象、目标和责任等信息不复制进 Personal。
- 明确偏好与谨慎归纳分别表达；重复出现仍需核对语境，不能把偶发任务要求升级为永久标签。
- 同一个人的不同 scope 共用一份 Personal.md；不同人的文件、召回和写入完全隔离。并发蒸馏串行合并，防止后完成的旧请求覆盖更新。
- 少量稳定协作偏好常驻，其他个人内容按当前问题召回。当前指令覆盖历史偏好，历史聊天不覆盖当前 World 事实。
- 用户可纠正、查看与删除；删除后的内容不能通过下一次重放同一段历史被重新蒸馏回来。

## 删除 CompanyMemory MCP 的依赖边界

`mcpCompanyMemory.ts` 除主 Runtime 外，还被 radarAgent、preflightAgent 使用，并通过 `/mcp/company-memory` 暴露。`companyMemory.ts` 同时承载人员目录，许多权限检查直接依赖它。

因此删除顺序是：

1. 把人员目录与登录权限职责从认知仓储中拆出，保持稳定 personId 与现有授权行为。
2. 主 Runtime 改用 World/Company/Personal 的读取接口，清除旧章节工具与旧公司摘要路径。
3. 雷达和预审等现有调用方改用共同的 Company 读取能力，仅做移除依赖所需的适配；不新增这些场景的产品行为。
4. 删除 CompanyMemory MCP 实现、端点、专用配置及测试；更新对应健康状态与启动条件。

这与 ADR-0013 的 MCP 决定及 ADR-0004 中旧知识写入流程存在变更，用户本次决定优先。实施时补充替代 ADR 并更新 CONTEXT，不能保留相互矛盾的当前规则。ADR-0010 中 Runtime 不持有业务事实与原始聊天的边界继续成立。

## 实施顺序与完成条件

1. 验证 World 读取契约和实体对应，建立代表性响应测试；不能对未对应的本地对象猜测 World ID。
2. 实现 World 正文适配与 Company 阅读投影，验证语义、更新、撤销、缺失和权限。
3. 实现 Personal 文件隔离、蒸馏、合并和遗忘，验证跨 scope 连续与跨人隔离。
4. 切换所有主私聊上下文入口，重建旧 Pi 执行态，保留原始历史和流程记录。
5. 移除 MCP 及其必要依赖，更新部署配置与领域文档。

完成条件：

- 同一公司字段在一轮上下文中只有 World 当前事实路径；本地草稿及历史内容清楚表达其性质。
- World 缺失、拒绝访问或读取失败时，不静默回退旧公司知识。
- 模型看到的 Company/Personal 是可读正文，不含 sourceFingerprint 或“来源：”等追溯模板。
- Company 可从 World 重建，不能由私聊、Personal 或助手回答改写；主 Agent 工具集不开放 World 写入。
- 删除 MCP 不破坏登录鉴权、人员解析或已有非主私聊服务启动。
- 公司事实、流程状态、历史快照和个人信息分别验证，不以类型检查代替这些行为验证。

## 本次核对的证据入口

- `apps/api/src/app.ts`、`conversationContext.ts`、`piConversationRuntime.ts`
- `apps/api/src/conversations.ts`、`routes/conversations.ts`、`routes/shared.ts`
- `apps/api/src/worldClient.ts`、`worldMissions.ts`、`worldMeetingEvents.ts`
- `apps/api/src/companyMemory.ts`、`mcpCompanyMemory.ts`、`memoryTools.ts`
- `.scratch/tkos-world-02/examples-v0.6.1.md` 与现有 World 接入工单
- `seed/memory/CompanyMemory.md` 的章节目录，以及现有配置、Mission、月度计划迁移

以上证据来自仓库源码与样例。本次未访问真实 World、未修改运行代码、未迁移或删除业务数据。
