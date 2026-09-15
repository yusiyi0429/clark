# clark-memory-adapter

clark 的本体链接替换层：以 TKOS GraphKnowledge M7 的同形 HTTP 契约（P0-P3 + /healthz）暴露 workspsce `memory_service` 的读能力。

- 设计文档：`docs/design.md`（含三阶段方案、接口契约、验收标准）
- 协作分工：`docs/peer-plan.md`（文件所有权矩阵、任务书、Wave 结构）

## 边界（不可违反）

1. 本仓库**只读**消费 memory_service 公开 API；禁止对 `wm_*`/`semantic_*`/`memory_*` 表写裸 SQL（读也不行）。
2. 不 `import aw.*`；memory_service 经 `adapter/bootstrap.py` 注入 `sys.path`。
3. 三态语义不可混淆：404=锚点不存在（clark 走 external_only），503=服务不可用（必须上抛）。
4. 测试只用随机隔离 scope，禁止读写 `local`/`local-org`。

## 运行

```bash
uv sync

export MEMORY_TENANT='<tenant>'
export MEMORY_ORG='<organization>'
export VIEWER_USER_ID='<scope 内 users.kind=human 的 UUID>'
# DATABASE_URL 缺省回退读取 /Users/renhaoliu/Desktop/workspsce/.env

# P3 可选；缺失时 /healthz 的 embedding=false，dynamic 返回 503
export MEMORY_EMBEDDING_API_KEY='<key>'
export MEMORY_EMBEDDING_BASE_URL='<Ark base URL；adapter 调用 /embeddings/multimodal>'
export MEMORY_EMBEDDING_MODEL='<embedding model>'
export MEMORY_EMBEDDING_DIM=2048

uv run uvicorn adapter.main:app --host 127.0.0.1 --port 8010
uv run pytest
```

clark 灰度切换只需设置：

```bash
TKOS_GRAPHKNOWLEDGE_BASE_URL=http://127.0.0.1:8010
TKOS_GRAPHKNOWLEDGE_VIEWER=PSN-01  # wire compatibility；治理身份仍以上面的 VIEWER_USER_ID 为准
```

## MVP 明账

- `ADAPTER_AUTH` 当前只进入 healthz 配置告警，服务端**尚未执行 Basic Auth 校验**；本期必须仅监听 loopback，不得暴露公网。
- P3 的 `CG-{UUID}` 是真实、稳定的只读 Context Graph 引用，可进入 clark 本轮引用白名单；本期不能经 P1/P2 解引用。
- P0 本期只渲染 confirmed Working Memory 判断与 human viewer；Context Graph/CompanyVision 静态叙事尚未接入。
