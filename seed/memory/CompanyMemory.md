将/Users/renhaoliu/Desktop/Project/tkos/CompanyMemory.md，Markdown 文件（现在是Markdown文件，之后是存在数据库里）是一章公司认知（战略一章、业务域一章）→系统启动时把这些章节登记进长期认知库，每章记下内容和更新时间 → 对话中模型拿到的只是一份目录（有哪些章、各讲什么、何时更新）→ 真正需要某章内容时，按当前问题去那一章里捞最相关的几段 → 捞到的段落同时存档成带来源的“证据”，回答时可回溯。

背后其实是三个需求点：
1. 按需取用，不占上下文：公司知识从“全量背景”变成“目录 + 按需查阅”，材料再长也不稀释对话质量。
2. 重启不丢、修订不被冲掉：部署环境磁盘易失，仓库永远留一份种子；启动只补缺失的章节，线上人工改过的内容优先——所以认知可以持续运
营，不怕重新部署。
3. 结论有据可查：每次查到的公司材料都落成证据文件，配合“回答要区分事实与推论”的顾问纪律，让 CEO 能追问“这个判断依据的是什么”。

<Content>
## 1. 公司战略：词元云集要成为一家什么公司
词元云集是一家：
面向 AI 时代企业经营范式重构的科技公司。

公司的核心战略判断是：
AI 对企业真正深刻的影响，不只是“让员工多几个 AI 工具”，而是企业的价值创造主体正在从单一的“人”，演化为：
人 + AI Agent + 数字劳动力共同构成的新型企业运行系统。

因此，未来企业真正缺失的并不是某一个 Agent，而是一整套新的：
- 战略与决策机制；
- 经营与任务运行方法；
- 人与 Agent 的协作方式；
- 企业级 Agent 产品；
- 企业 Context / Ontology；
- Agent Runtime 与运行基础设施；
- Token 与模型资源基础设施。

词元云集希望建立的，就是这套面向 AI-native 企业的新型经营基础设施。

## 2. 最高战略锚点：TKOS
当前公司最高优先级的核心战略锚点仍然是：
TKOS（TokenKing Operating System）

TKOS 是词元云集未来：
- 核心产品母体；
- 核心能力系统；
- 企业客户长期运行载体；
- 公司商业模式最重要的产品化基础。

但 TKOS 的架构已经从此前的四类能力，进一步收敛为三个核心部分：
Method × Agents × ENO
形成更加清晰的 3×3 体系。

## 3. TKOS 的三大核心能力
### 1. Method
Method 解决的是：
AI 时代企业应该如何运行。

包括：
- 企业战略感知与决策；
- Company Outcome；
- Domain Outcome；
- Mission；
- DRI；
- 人机协作；
- Review；
- 复盘；
- 战略刷新；
- 任务运行机制。

Method 不是单纯的方法论资产，而是需要最终被 TKOS 产品化、系统化运行的企业经营方法。

### 2. Agents
Agents 是：
真正面向 CEO、DRI、IC 等企业角色的 AI 产品和 Agent 应用。

Agents 不再被理解为 TKOS 上层一个独立的 “Applications” 层，而是 TKOS 的核心组成部分。

它解决的问题是：
不同角色在新的 AI-native 企业中，究竟如何借助 AI 工作。

例如：

**CEO 层**

可能包括：
- 战略情报 Agent；
- Research Agent；
- CEO Agent；
- 决策辅助 Agent；
- 会议 Agent；
- Outcome Review Agent。

**DRI 层**

围绕：
- Mission 定义；
- 计划；
- 跨 Domain 协同；
- Review；
- 风险识别；
- 经营分析。

**IC 层**

围绕：
- 专业任务执行；
- Research；
- 内容生产；
- 数据分析；
- 工作自动化；
- 多 Agent 协作。

因此 Agents 本质上是：
TKOS 面向企业真实工作角色的产品界面和价值交付载体。

### 3. ENO：Engine & Ontology
ENO 是 TKOS 真正的企业级基础系统和底座。

它把过去分别讨论的：
- Foundry；
- Ontology；
- Context；
- Memory；
- Engine；
- Runtime；
进一步统一起来。

ENO 解决的是：
怎样让企业 Agent 真正理解一家企业，并能够安全、持续、可靠地运行。

它既包含企业的“认知底座”，也包含 Agent 的“运行底座”。

主要包括：

**Ontology / Context**

建立企业可被 AI 理解的经营世界，包括：
- 企业战略；
- Domain；
- Outcome；
- Mission；
- 人与组织；
- Decision；
- Evidence；
- Risk；
- Artifact；
- 企业关系；
- 历史状态；
- 时间演进。

**Memory**

解决 Agent 如何：
- 记住企业；
- 记住 Mission；
- 记住历史判断；
- 找回正确 Context；
- 持续形成企业级记忆。

**Engine / Runtime**

支撑 Agent：
- Harness；
- Context Assembly；
- 模型调用；
- Tool / Skill 调用；
- 多 Agent 协作；
- 权限管理；
- 鉴权；
- 可观测；
- 运行状态管理；
- 回滚；
- 安全控制。

因此 ENO 可以理解为：
Enterprise AI 的 Operating Substrate。

没有 ENO，Agents 很容易只是一个个独立的 AI 应用；
有了 ENO，才可能形成真正理解企业、持续进化的 Agent 网络。

## 4. TKOS：从 3×4 更新为 3×3
组织仍然按照三个角色层运行：
- L1：CEO 决策层
- L2：DRI 经营管理层
- L3：IC 执行层

系统能力更新为：
- Method
- Agents
- ENO

形成新的：
3 × 3 TKOS

|        | L1 CEO | L2 DRI | L3 IC |
| ------ | ------ | ------ | ----- |
| Method | CEO战略与经营方法 | DRI经营与Mission方法 | IC任务与协作方法 |
| Agents | CEO级Agent产品 | DRI级Agent产品 | IC级Agent产品 |
| ENO | 企业统一的 Engine & Ontology 底座贯穿三个层级 | 企业统一底座 | 企业统一底座 |

这里最重要的变化是：
ENO 原则上不是三个彼此割裂的产品层，而是一套贯穿 CEO、DRI、IC 的企业级基础系统。

不同层级使用的 Context、权限、运行逻辑不同，但底层应逐渐形成统一体系。

## 5. 整体业务结构
词元云集当前业务结构仍然可以概括为三层：
ReArc 进入客户
→ TKOS 持续经营客户
→ Token Hub 提供长期 AI 基础设施

### 第一层：Re-architecture / ReArc
ReArc 是词元云集进入企业的核心商业化与转型能力。
ReArc 不是传统咨询。

它解决的是：
如何把一家传统企业真正迁移到 AI-native 的经营方式。

包括：
- 找到企业真正值得 AI 改造的问题；
- 从 CEO 和战略层重新理解 AI；
- 重构经营机制；
- 重构 Domain / Outcome / Mission；
- 重新定义人与 Agent 的分工；
- 设计新的 Agent；
- 建立企业 ENO；
- 在真实业务中运行；
- 形成可持续的新经营系统。

AI 转型九步法，是 ReArc 当前最重要的方法载体。

### 第二层：TKOS
ReArc 不是最终目的。
ReArc 的最终价值是：
帮助企业完成 Re-architecture，并进入 TKOS 持续运行。

因此词元云集希望形成的并不是：
咨询项目 → 项目结束
而是：
ReArc
→ 新经营机制形成
→ Method 被系统化
→ Agents 进入日常经营
→ ENO 持续积累
→ TKOS 成为企业长期经营基础设施。

### 第三层：Token Hub
Token Hub 是更加底层、长期的 AI 基础设施业务。

包括：
- 多模型统一入口；
- API Gateway；
- 模型路由；
- Token 采购；
- 计量计费；
- 限流；
- Failover；
- 模型质量评价；
- 成本优化；
- TokenOps；
- 企业 AI 资源运营。

Token Hub 的最终战略价值不是简单 Token 分销，而是：
当企业大量 Agent 在 TKOS 中运行以后，承载越来越多的企业 AI Workload。

## 6. 商业模式
词元云集商业模式可以分为三个阶段。

### 1. ReArc：高价值项目收入
以企业真实战略和经营问题切入。

主要形成：
- AI 转型项目；
- Re-architecture 项目；
- CEO / 一号位战略项目；
- Agent 与经营机制设计；
- 企业 ENO 建设；
- AI-native 经营落地。

它既产生收入，也是客户进入 TKOS 的 Customer Acquisition Mechanism。

### 2. TKOS：长期产品收入
当企业新的经营方式开始运行以后，收入逐步转化为：
- 企业级 TKOS 收入；
- Agents 产品收入；
- 企业级 ENO 能力收入；
- Agent Runtime；
- 企业 AI 运行服务；
- 长期升级和扩展收入。

这是未来最重要的经常性收入基础。

### 3. Token Hub：规模型基础设施收入
随着 Agents 和企业 AI Workload 增长：
- Token 消耗增加；
- 模型调用增加；
- 推理需求增加；
- Routing 与优化需求增加。

最终产生：
- Token Margin；
- Routing；
- TokenOps；
- AI Infrastructure；
- 推理与资源运营收入。

## 7. 目标客户
现阶段核心目标客户先聚焦为：
大型企业的一号位。

包括：
- 董事长；
- CEO；
- 集团总裁；
- 企业 AI 转型的一号位。

典型企业包括：
- 大型集团；
- 上市公司；
- 龙头制造企业；
- 大型服务企业；
- 面临战略转型或第二增长曲线的企业。

为什么从一号位切入：
因为词元云集当前要解决的首先不是：
“某一个流程如何用 AI 提效？”
而是：
“AI 到底意味着什么，以及一家企业未来应该如何经营？”

这是一个天然的一号位命题。

## 8. 商业化核心打法：AI 转型九步法
九步法是 Domain 02 ReArc 当前最重要的商业化与 Transformation 方法。
它不是为了形成一个传统咨询 Methodology。

它承担两件事情：

### 第一，真正帮助客户完成 AI Re-architecture
把客户从：
AI 工具采购 / Use Case
带向：
企业经营范式重构。

### 第二，形成从项目到 TKOS 的迁移路径
理想路径是：
九步法进入客户
→ 发现真正的经营问题
→ Method 重构
→ Agent 进入经营
→ ENO 建设
→ TKOS 持续运行。

因此九步法本身就是公司最关键的：
Go-to-Market + Transformation + Product Adoption Mechanism。

## 9. 九步法 Step 1：看见未来 / CEO Inception
目前最成熟的是第一步：
看见未来。

不是传统的客户访谈，而是帮助 CEO 回答：
AI 时代，这个行业、这家公司以及 CEO 自己的工作会发生什么变化？

核心包括：

### Pre-Strategy
在见 CEO 之前形成：
- 行业判断；
- 企业诊断；
- 战略议题；
- AI 冲击判断；
- 值得讨论的问题。

### CEO 对谈
围绕真正的战略问题，而不是围绕 AI 功能清单讨论。

### Agents 现场体验
让 CEO 直接看到：
- 情报；
- Research；
- 决策；
- 会议；
- Mission；
- Review；
- 未来如何由 AI 支持。

### 找到值得改变的经营问题
从：
AI 能做什么？
变成：
这家公司真正应该重构什么？
再进入后续 ReArc。

## 10. 词元云集八个 Domain
公司自身也按照 AI-native 企业方式运行。

组织基本单元不是传统职能部门，而是：
Domain + Mission + DRI

最新八个 Domain 为：

### Domain 01｜公司战略与方向
回答：
词元云集自己应该去哪里。
由 CEO / 一号位承担核心责任。

负责：
- 公司战略；
- 战略方向；
- 核心选择；
- Company Outcomes；
- 战略演进。

### Domain 02｜Re-architecture / ReArc
负责：
把词元云集的能力真正带入客户，并推动客户完成 AI 转型和价值实现。
这是商业化和 Transformation 一体化的 Domain。

核心包括：
- 客户拓展；
- CEO Inception；
- 九步法；
- Transformation；
- Client Value Realization；
- 客户 TKOS 落地。

### Domain 03｜Method
负责建立和迭代：
AI-native 企业如何经营的方法系统。

包括：
- 战略决策机制；
- Outcome；
- Mission；
- DRI；
- Review；
- 人机协作；
- 经营运行机制。

### Domain 04｜Agents
负责：
面向企业不同角色构建真正可使用的 AI 产品。

重点包括：
- CEO Agents；
- DRI Agents；
- IC Agents；
- 多 Agent 产品；
- Agent UX；
- Agent 产品化与落地。

### Domain 05｜Engine & Ontology / ENO
负责：
企业级 Agent 运行的基础系统。

包括：
- Ontology；
- Context；
- Memory；
- Agent Runtime；
- Harness；
- Tool / Skill；
- Context Assembly；
- 权限；
- 可观测；
- 企业 Agent 基础设施。

### Domain 06｜Token Hub
负责：
企业 AI Workload 的模型、Token 与推理基础设施。

包括：
- Gateway；
- Routing；
- Token；
- Billing；
- 模型运营；
- TokenOps；
- 成本与质量优化；
- AI 资源运营。

### Domain 07｜组织与人才支持
负责：
- 组织设计；
- Talent；
- 招聘；
- 绩效；
- 激励；
- 期权；
- 文化；
- 人才发展。

### Domain 08｜运营保障
负责：
- 财务；
- 经营经济性；
- 法务；
- 合同；
- 合规；
- 采购；
- IT；
- 办公；
- 公司运营保障。

## 11. 公司能力与业务 Domain 的关系
八个 Domain 实际构成了一条完整的公司价值链：

01 战略决定公司去哪里
↓
02 ReArc 把公司能力带入客户
↓
03 Method 定义新的企业运行方式
04 Agents 把新的运行方式变成用户真正使用的 AI 产品
05 ENO 让 Agent 真正理解企业并可靠运行
↓
06 Token Hub 承载不断增长的 AI Workload
↓
07 + 08 构成组织与运营基础设施

其中：
- 02 是商业化入口；
- 03–05 是 TKOS 核心产品能力；
- 06 是长期基础设施与规模杠杆；
- 01、07、08 保证公司自身能够持续运行。

## 12. 当前六个月战略目标
词元云集已经从：
战略定义期
进入：
战略证明期。

未来约六个月最重要的不是把整个 TKOS 做完整，而是证明三件事情。

### 1. 商业模式第一次可复制验证
证明：
ReArc 能够稳定从一号位进入客户，并最终把客户带入 TKOS。

核心不是完成一个灯塔项目，而是验证：
ReArc → TKOS
是不是一台可以重复运行的商业机器。

### 2. TKOS 形成第一个真正的产品核
优先围绕 L1 / CEO 场景。

核心包括：
- M1 战略与经营 Method；
- M1-A 战略决策机制；
- M1-B 战略运行机制；
- CEO Agents；
- 支撑上述 Agents 的最小 ENO。

而不是一次性开发完整的 L1/L2/L3。

### 3. 建立不依赖 CEO 人工拼接的最小组织机器
公司必须形成：
- 清晰 Domain；
- 清晰 DRI；
- Mission 机制；
- Client DRI；
- 产品总装；
- TKOS Assembly；
- Review；
- 复盘；
- 跨 Domain 协同。

否则即使单一灯塔客户成功，也无法复制。

## 13. 商业飞轮
词元云集当前希望最终建立的 Flywheel 是：

CEO 的重要战略问题
↓
ReArc / 九步法进入
↓
Method 被重新设计
↓
Agents 进入真实经营
↓
ENO 持续形成企业 Context 和运行数据
↓
Agent 越来越理解企业、价值越来越高
↓
更多 CEO / DRI / IC 工作进入 TKOS
↓
更多 AI Workload 与 Token 消耗
↓
TKOS 与 Token Hub 的商业价值持续增加
↓
客户关系从项目制转向长期经营关系

## 14. 长期战略逻辑
如果把词元云集战略压缩成一句话：
从大型企业一号位的真实经营问题切入，通过 ReArc 与 AI 转型九步法重构企业经营方式，把 Method、Agents 和 ENO 产品化为 TKOS，并最终承载企业越来越多的 AI Workload。

商业公式可以进一步压缩成：
ReArc 获客
× Method 重构经营
× Agents 创造用户价值
× ENO 形成企业智能壁垒
× TKOS 长期留存
× Token Hub 放大规模

因此，词元云集最终既不是：
- 咨询公司；
- 单纯 Agent 公司；
- 企业软件公司；
- Token 中转平台；

而希望逐渐成为：
AI 时代企业经营与智能运行的基础设施公司。

## 15. 当前最重要的战略验证问题
现阶段真正需要持续回答的，不是“我们做出了多少 Agent”。

而是以下五个问题：

1. 是否存在足够强的一号位问题，让大型企业愿意从 CEO 层启动 AI Re-architecture？
2. 九步法是否能够把一次 CEO 对话，稳定转变成真实的 Transformation？
3. ReArc 项目结束之后，企业是否自然进入 TKOS，而不是回到传统项目制？
4. Method、Agents 和 ENO 是否能够形成真正的复合壁垒，使产品随着使用越来越有价值？
5. 这套模式是否能够从第一个灯塔客户复制到第二个、第三个客户，而逐步摆脱对创始人本人和少数核心人员手工总装的依赖？

这五个问题，构成词元云集当前“战略证明期”的核心战略检验。
</Content>
