# CEO WarMap 项目完整评估（2026-09-22）

取证范围：全部 API/Web/contracts 源码结构、5 个 Agent prompt 全文、staging 真实产出
（TKOS 研究报告、会前预审、对话回答）、债务标记、测试规模。评估时 HEAD = ef5e383。

**总评：治理模型出色、执行链干净、输入侧偏薄的 MVP。决策流水线（发现→研究→预审→确认→
留痕→可撤回）已达可用水准；短板集中在对象只能建不能改、情报源单点、prompt 补丁句堆积。**

## 1. 业务功能设计与系统整体

强项：
- 治理模型自洽：Agent 只产候选，Organization Fact 只能由 CEO 确定性 Action 产生；
  fingerprint 幂等 + version 乐观锁 + Receipt 审计 + 统一 revoker，无旁路。
- 六实体边界从 spec 到表到投影一致；单 CEO/单公司假设贯彻彻底。

不支持/会撞上的场景（按概率排序）：
1. 注册表对象只能建、删，不能改（战场/能力/会议基本字段），删战场还级联解绑议题
2. Transcript 只收结构化 JSON 导入；真实会后只有录音或自由笔记
3. Radar 单源（量子位 RSS，微信被频控关停），源挂即静默停摆，无告警面
4. 企业知识是静态 seed 文件，改公司事实要改文件重启容器，与配置页体验割裂
5. 对话与业务对象之间无桥（缺"生成 Issue 草稿、CEO 确认"的过渡）
6. 预研失败仅手动重试，CEO 视角缺下一步指引

单进程假设（登录限速/inflight/调度器）有 7 处 ponytail 注释标记升级路径，属明债。

## 2. 业务对象与数据链路：清晰（最强维度）

- 11 表 = 6 实体 + 2 注册表 + radar_config + agent_runs + migrations；值对象 JSONB 内嵌，
  对象边界与表边界一比一。
- 链路单向：DB row → projectXCard() → TCard → OpenAPI 生成客户端 → React；web 零业务逻辑。
- effects.ts 按 effectRef 前缀统一分派撤回，同事务同步四类派生状态。

弱点：JSONB 不变量只活在代码里（无 DB 约束）；fingerprint 幂等三套形似实现
（issue/meeting/monthlyPlan），一致性靠纪律。

## 3. Agent 链路：架构清晰，prompt 正在腐蚀

- 5 Agent + 对话运行时统一 candidateAgentRuntime，submit_candidate 单工具收口，
  代码侧二次守门（assessPromotion / ResearchDoc schema / preflight entries 白名单）。
- 腐蚀证据一：preflight prompt 堆积补丁句（禁英文 slug、禁 CompanyMemory、禁"视角预判"、
  条数规则），大多在校验器有镜像，规则一改要动 prompt+校验器+测试三处。
- 腐蚀证据二：list_sections/search_sections/get_passages defineTool 三件套在
  radar/preflight/conversation/mcp 复制四份（企业知识改名动 5 文件即账单）。

## 4. 业务质量（用户视角）：达标

- TKOS 研究报告：summary 是真判断（"能力域全部占位、深度分阶段"），unknowns 7 条可跟进，
  来源诚实（承认厂商供稿转载不足证明行业门槛）。可直接作决策输入。
- 预审 criticalIssue/priorityAction 直给可执行；对话回答结构干净、引用准确。
- 天花板在输入侧：单 RSS 源 + 静态企业知识限制发现密度与内证深度。
- 存量瑕疵：TKOS 报告 unknowns 有一处改名前的"CompanyMemory"字样。

## 5. 架构与代码：整洁，两块巨石

- API src 9.5k 行 / 测试 10.8k 行（307 用例真实 Postgres）；contracts 2.7k 按域 17 文件；
  17 篇 ADR；债务全标记。
- 扣分：meetings.ts 1564 行（Meeting+Material+Preflight 编排+Outcome 四合一）、
  app.ts 1540 行 52 路由；ConversationDock.tsx 945 行；battlefields.ts 开始混职责。

## 建议优先级（评估时未实施）

1. 注册表对象加编辑
2. Transcript 自由文本 → Agent 抽取候选 → CEO 逐项确认
3. Radar 源健康面板 + 第二源
4. makeMemoryTools() + prompt 规则单一来源（→ Ticket 24 已立项）
5. 拆 meetings.ts / app.ts（→ Ticket 23 已立项）
