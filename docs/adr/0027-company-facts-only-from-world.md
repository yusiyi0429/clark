# 公司事实只认本体，人员目录独立

替代 ADR-0004 的 Company Memory 与 ADR-0013 的 CompanyMemory MCP；ADR-0010 的「Runtime 不拥有业务记忆」继续有效。采纳 PR #12 的主张，2026-10-19 决定（决策记录 D-47 至 D-51）。

本体（tkos.world 的 World）是公司事实的唯一权威。天枢不再维护第二份公司事实：`seed/memory/CompanyMemory.md` 不再加载，只作为 Company 投影该覆盖哪些目录的参考。对话用 `query_company` 按本人在 `COMPANY_WORLD_ACCESS_FILE` 里被授权的域读取；雷达、会前预审、预研、月度起草与复盘、任务卡起草用 `COMPANY_SYSTEM_PERSON_ID` 这个人的授权读取，服务凭据本身不授予任何范围。

读不到本体（未配置、未授权、读取失败）时如实说没读到，不用本地资料兜底；`empty` 才表示本体里确实没有。天枢自己的业务数据（Mission、执行事项、会议、复盘、材料）照常可用，它们不是公司事实。

人员目录（`company-people.v1`）独立于公司事实：登录、会话角色、本人隔离和人名解析只看人员目录，不从本体负责人推导登录权限。人员名单缺失或不合规时 API 启动失败。

`/mcp/company-memory`、`COMPANY_MEMORY_MCP_TOKEN`、`COMPANY_MEMORY_SEED_DIR` 和旧章节工具（`list_sections`、`search_sections`、`get_passages`）一并删除，不做过渡；`/mcp/me` 等其他 MCP 不受影响。
