# CompanyMemory seed

CompanyMemory MCP 的生产输入（`.scratch/ceo-warmap-mvp/issues/03-company-memory-mcp-people.md`、`docs/technical/ceo-warmap/02-Pi与四层记忆.md` §9）。

单一来源：公司认知章节直接读取 `seed/memory/CompanyMemory.md` 所在目录（`## 标题` 切章、空行切段；`<Content>` 包装行与标题前前言自动忽略），本目录不再维护内容副本。

- 认知内容：唯一来源为 `seed/memory/CompanyMemory.md`，真实维护以项目授权人提供为准；解析对缺失、空目录、无 `## ` 章节一律启动诚实失败。
- `company-people.example.json`：`company-people.v1` 人员名单示例，**只用于本地联调**。生产禁止使用示例或演示人名；`COMPANY_PEOPLE_SEED` 必须指向项目授权人提供的真实名单，缺失或不合规时 API 启动即失败（诚实失败，不从姓名虚构 personId）。

API 环境变量（相对 apps/api 运行目录；Compose 用容器内绝对路径覆盖）：

```text
COMPANY_MEMORY_SEED_DIR=../../seed/memory
COMPANY_PEOPLE_SEED=../../seed/company-people.example.json   # 本地；生产指向真实名单
```

Compose 部署时 `seed/` 以只读挂载进入 api 容器（见 `infra/docker-compose.yml`）；未来迁移数据库时只替换 `apps/api/src/companyMemory.ts` 背后的 repository，不改公开 MCP 工具契约。
