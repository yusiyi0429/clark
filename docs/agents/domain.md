# Domain Docs

本项目使用 single-context 领域文档。

## Before exploring

- 读取根目录 `CONTEXT.md`
- 读取与当前任务相关的 `docs/adr/`
- 文件不存在时静默继续

## Vocabulary

输出中的领域术语必须采用 `CONTEXT.md` 的定义，避免使用其中明确列入 `_Avoid_` 的同义词。

## ADR conflicts

若方案与现有 ADR 冲突，必须明确指出，不得静默覆盖。

## Layout

- 领域词表：`CONTEXT.md`
- 架构决策：`docs/adr/`
- 不创建 `CONTEXT-MAP.md`
- 不按 Web、API 或 contracts 包重复维护领域词表
