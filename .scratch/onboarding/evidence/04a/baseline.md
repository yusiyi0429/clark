# 04a 测试基线

2026-09-27，任何产品源码修改之前执行。

| 检查 | 结果 |
|---|---|
| `pnpm --filter @warmap/contracts build` | 通过 |
| `pnpm --filter @warmap/contracts test` | 2 文件，42 通过 |
| `pnpm --filter @warmap/api typecheck` | 通过 |
| `pnpm --filter @warmap/api exec vitest run --maxWorkers=1` | 42 文件，477 通过、8 失败；350.38 秒 |
| `pnpm --filter @warmap/web typecheck` | 通过 |
| `pnpm --filter @warmap/web test` | 37 文件，291 通过 |

API 8 项失败均在既有 `test/deployment.test.ts`：两个 compose backup 行为断言、六个 restore 相关断言（checksum/目标空库与空卷/恢复校验）。与工单 01 已记录的 Windows/Git Bash 基线一致；本单不修改备份恢复脚本。

只读候选文件 SHA-256：`5c133d53a18025e9f8466fa58fda30aedf25f6ac4713641d5480715756086712`。

工作开始时 `git status --short` 无输出。仅使用只读 Git 检查，不提交、不暂存、不切分支、不回退。
