# 01 · world 客户端与同步台账

Type: implementation
Status: ready-for-agent
Blocked by: —

## 要做什么

`apps/api` 里一个只负责和 world-02 说话的模块，后面每张工单都经它读写。

- 配置：`TKOS_WORLD_API_URL`、`TKOS_WORLD_AGENT_TOKEN`（compose 透传，缺失时整个推送关闭并在 healthz 如实报「未配置」）；人员映射 `personId → principal_id`（天枢 `liu-minghua / yu-siyi / liu-renhao` → ids.json 里的 ceo / eo-dri / eo-owner），放一个随实例替换的配置文件（实例重建即换）。
- 写：`prepare → commit` 同一请求体、同一幂等键（16–128 字符）；把 prepare 返回的 `expected_versions` 原样带进 commit。可选 `on_behalf_of {principal_id, external_record_id, external_confirmed_at}`。
- 读：`GET /v1/world/objects`（`external_system`+`external_id` 查回、`domain_id`/`type` 列表、游标翻页）、取对象（从 `business` 组取 `object_id`/`revision_id`/`object_version`/`version`，`records.lifecycle`）。
- 错误：`VERSION_CONFLICT`、`STALE_DEPENDENCY` → 重取再写一次；`IDEMPOTENCY_CONFLICT`、`INVALID_STATE`、`FORBIDDEN`、`INVALID_REQUEST` 不重试，记台账并如实暴露；网络失败保留幂等键，下次用同一个键重放。
- 同步台账表（新 migration）：每次写一行 `{instance, action_type, idempotency_key, target_ref, status, receipt_id, error_code, request_digest, created_at}`；按 `instance`（= API URL + scope_id）整批作废重来。
- 调用日志沿用 `logEvent`，不打印凭证。

## 完成定义

- 用 `examples-24e6202.md` §1（列对象、按外部引用查回）与 §11（典型错误）的真实请求／返回做契约测试（桩 HTTP），覆盖：成功回执、同键重放、409 冲突后重取、403／422 不重试。
- 对 world-02 真实实例跑一次只读冒烟：`/v1/identity` 与 `external_system=tianshu&external_id=capability:05` 查回 E&O 单元。
