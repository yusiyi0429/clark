# 历史设计图

本目录保留 Archify 原始设计图与可编辑 JSON。图表不是当前架构或验收证据。当前实现见[架构说明](../architecture/README.md)。

| 图 | 阅读入口 | 可编辑源 |
| --- | --- | --- |
| 业务对象关系 | [HTML](CEOwarmap_业务对象关系.html) | [JSON](CEOwarmap_业务对象关系.architecture.json) |
| 技术架构 | [HTML](CEOwarmap_技术架构.html) | [JSON](CEOwarmap_技术架构.architecture.json) |
| 六实体生命周期 | [HTML](CEOwarmap_六实体生命周期.html) | [JSON](CEOwarmap_六实体生命周期.lifecycle.json) |
| 雷达自动升级 | [HTML](CEOwarmap_雷达自动升级时序.html) | [JSON](CEOwarmap_雷达自动升级.sequence.json) |
| 预研到决定 | [HTML](CEOwarmap_预研到决定时序.html) | [JSON](CEOwarmap_预研到决定.sequence.json) |
| 会议准备与抽取 | [HTML](CEOwarmap_会议准备与抽取时序.html) | [JSON](CEOwarmap_会议准备与抽取.sequence.json) |
| 会后逐项确认 | [HTML](CEOwarmap_会后逐项确认时序.html) | [JSON](CEOwarmap_会后逐项确认.sequence.json) |

“六实体”只描述最初模型。后续新增 Mission、执行事项、复盘与任务卡轮次。旧技术图中的 CompanyMemory MCP 和权限范围也不再代表现状。

保留旧文件名以便定位历史事项。重复的 `visual-check` HTML、PNG 和 JSON 导出不再维护；原始产物可从 Git 历史恢复。需要新图时，以当前源码和契约重新生成，不把旧截图当作当前验收。
