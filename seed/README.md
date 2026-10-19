# seed

API 启动和人工导入读取的受控文件。Compose 部署时整个 `seed/` 以只读方式挂到 API 容器的 `/repo/seed`（见 `infra/docker-compose.yml`）；本地直跑时路径相对 `apps/api` 解析。变量说明见 [环境配置](../docs/guides/environment.md)。

| 路径 | 用途 | 对应变量或命令 |
| --- | --- | --- |
| `memory/CompanyMemory.md` | CompanyMemory 的唯一内容来源：`## 标题` 切章、空行切段，`<Content>` 包装行与标题前前言自动忽略。缺失、空目录或没有 `## ` 章节时 API 启动失败 | `COMPANY_MEMORY_SEED_DIR`（本地 `../../seed/memory`，Compose 固定 `/repo/seed/memory`） |
| `company-people.example.json` | `company-people.v1` 人员名单示例，**只用于本地联调** | `COMPANY_PEOPLE_SEED` |
| `company-people.json` | 生产真实名单，由项目授权人放在部署机，不进 Git | Compose 固定 `/repo/seed/company-people.json` |
| `placeholders/` | 本月个人卡讨论候选（`mission-card-drafts.v1`） | `MISSION_CARD_DRAFTS_DIR` |
| `imports/2026-10-known-missions.json` | 起草任务卡时参考的已知本月任务 | `MISSION_CARD_KNOWN_MISSIONS_FILE` |
| `imports/missions-2026-09.json`、`imports/reviews-2026-09.json` | 9 月 Mission 与复盘的一次性导入 | `pnpm --filter @warmap/api missions:import`、`reviews:import` |

生产禁止使用示例或演示人名。人员名单缺失、格式不符或 personId 重复时 API 启动即失败，不从姓名虚构 personId。

本体公司事实的按人授权文件（`COMPANY_WORLD_ACCESS_FILE`，内容 `{"<personId>":["<domain_id>"]}`）和本体凭证文件不进 Git。Compose 部署时放在部署机的 `seed/` 下才能被容器读到，变量里写容器内路径，如 `/repo/seed/company-world-access.json`。
