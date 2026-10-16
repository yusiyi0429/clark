# 历史方案

以下文件保存原始需求、实施目标和决策依据。它们不是当前开发或部署入口。当前口径见[领域上下文](../../context.md)与[架构](../README.md)。

| 文件 | 保留内容 |
| --- | --- |
| [原始规格](mvp-spec.md) | 用户故事、范围和原始验收目标 |
| [目标设计](target-design.md) | 原始页面、对象、协议与设计取舍 |
| [实施路线](implementation-roadmap.md) | 最初纵向实施阶段 |
| [基础设施与契约](infrastructure-contracts.md) | 原始接口与数据库边界 |
| [Runtime 与记忆](runtime-memory.md) | 原始运行时和记忆设计 |
| [雷达与预研](radar-research.md) | 公司雷达的门槛和研究链路 |
| [会议与会后结果](meeting-outcome.md) | 会议处理与逐项确认设计 |
| [月度计划与 DRI](monthly-plan-dri.md) | 早期计划与外发流程 |
| [Web 重构](web-rebuild.md) | 旧前端替换的视觉与迁移目标 |
| [测试与观测](testing-observability.md) | 原始验收边界 |
| [联调与部署](integration-deployment.md) | 历史发布门槛及风险豁免 |

## 已变化的前提

- 成员可以登录，执行事项与任务卡有独立权限。
- Company 读取授权 World，旧 CompanyMemory MCP 已停用。
- 会议支持受限妙记转换与录音转写。
- 任务卡采用本人准备与组合核对，不再按旧公开讨论流程实施。
- LangSmith 使用 SDK，获准的业务与记忆正文完整记录。
- 旧 `frontend/` 已移除，配置集中到根目录 `.env`。
- M2 是独立运行的试用服务。

历史报告中的“通过”只指当时记录的检查，不表示当前分支重新验证。旧设计稿与删除的重复导出可通过 Git 历史查询。未实现目标仍需逐项核对，不从历史方案自动推导完成状态。
