# 本地事项

项目的 Issue 与 Spec 使用 Markdown，保存在 `.scratch/`。这里的 Issue 指开发工单，不是产品中的决策议题。

## 文件位置

| 内容 | 路径 |
| --- | --- |
| 功能目录 | `.scratch/<feature-slug>/` |
| 规格 | `.scratch/<feature-slug>/spec.md` |
| 工单 | `.scratch/<feature-slug>/issues/01-<slug>.md` |
| 工作索引 | `.scratch/<feature-slug>/map.md` |

每个工单使用独立文件，并按编号排序。Skill 要求发布到事项系统时，在对应本地目录创建文件。用户提供路径或编号时，读取对应工单。

## 状态与评论

- 工单顶部使用 `Type:` 与 `Status:`。
- `Blocked by:` 记录依赖。
- 领取前写入 `Status: claimed`。
- 完成后写入 `Status: resolved`，并将结果摘要追加到工作索引。
- 评论追加在文件底部的 `## Comments`。
- 分类使用[分类标签](triage-labels.md)。

历史证据保留在原功能目录。不得因重新整理正式文档而改写历史验收结果。
