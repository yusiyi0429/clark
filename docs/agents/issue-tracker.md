# Issue tracker: Local Markdown

本项目的 Issues 和 Specs 保存在 `.scratch/`。

## Conventions

- 每个 feature 一个目录：`.scratch/<feature-slug>/`
- Spec 为 `.scratch/<feature-slug>/spec.md`
- Implementation issue 放在 `.scratch/<feature-slug>/issues/`
- 每个 issue 单独一个文件，按 `01-<slug>.md` 顺序编号
- Triage 状态写在 issue 顶部的 `Status:` 行
- 评论追加在文件底部的 `## Comments`

## Publishing

当 skill 要求“publish to the issue tracker”时，在对应 `.scratch/<feature-slug>/` 下创建文件。

## Fetching

读取用户提供的 issue 路径或编号。

## Wayfinding

- Map：`.scratch/<effort>/map.md`
- Child ticket：`.scratch/<effort>/issues/NN-<slug>.md`
- Ticket 使用 `Type:` 和 `Status:`
- `Blocked by:` 记录依赖
- claim 前写入 `Status: claimed`
- resolve 后写入 `Status: resolved`，并把结果摘要追加到 map
