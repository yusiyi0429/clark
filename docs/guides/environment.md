# 环境配置

变量示例只有一份：根目录 [`.env.example`](../../.env.example)。它只含占位值，真实配置不得提交或打进镜像。本文以 `apps/api/src/server.ts` 及各解析模块为准，列出 API 实际读取的变量。

## 配置文件放在哪里

| 运行方式 | 配置文件 | 加载方式 |
| --- | --- | --- |
| 本地直跑 API | `apps/api/.env` | 在 `apps/api` 目录 `pnpm exec tsx watch --env-file=.env src/server.ts`；`pnpm --filter @warmap/api dev` 不读 env 文件 |
| API 管理脚本 | `apps/api/.env` | 在 `apps/api` 目录 `pnpm exec tsx --env-file=.env scripts/<脚本>.ts` |
| Compose 部署（火山主机） | `infra/.env`（权限 600） | `docker compose -f infra/docker-compose.yml … --env-file infra/.env`；现网组合见 [release.md](../../infra/staging/release.md) |
| 本地准生产环境 | `infra/local/.env.local` | `bash infra/local/up.sh`，模板为 `infra/local/.env.local.example`，见 [infra/local](../../infra/local/README.md) |
| Web 开发代理 | 进程环境 | `next.config.ts` 只读 `API_SERVER_URL`（缺省 `http://localhost:4000`）和 `M2_SERVER_URL`（缺省 `http://localhost:4333`），生产构建不代理 |
| M2 | 进程环境 | 见 [M2 试用](m2-trial.md) |
| 测试 | 不加载真实 env | API 集成测试只读 `TEST_PG_URL` |

本地直跑时相对路径从 `apps/api` 解析，所以示例里写 `../../seed/...`。Compose 部署时 `seed/` 以只读方式挂到容器的 `/repo/seed`，文件类变量要写容器内路径。

Compose 只把 `infra/docker-compose.yml` 中 `api.environment` 声明过的变量交给 API。新增变量时要同时改这个文件和 `.env.example`。Web 容器只拿到 `API_SERVER_URL` 和 `PUBLIC_ORIGIN`，不能用 `env_file` 把整份配置注入 Web，也不能用 `NEXT_PUBLIC_*` 发布服务端凭据。

## API 必填

缺任一项 API 启动即失败。

| 变量 | 说明 |
| --- | --- |
| `DATABASE_URL` | PostgreSQL 连接。Compose 由 `POSTGRES_PASSWORD` 拼出，不用单独填 |
| `SESSION_SECRET` | 登录会话签名，随机长字符串 |
| `PUBLIC_ORIGIN` | 浏览器访问来源。Compose 由 `PUBLIC_DOMAIN` 拼成 `https://…` |
| `DRI_SERVICE_TOKEN` | DRI 导入导出的机器令牌，与会话密钥分开 |
| `COMPANY_PEOPLE_SEED` | `company-people.v1` 人员名单。本地可用示例，生产必须是授权的真实名单；Compose 固定 `/repo/seed/company-people.json` |
| `PI_BASE_URL`、`PI_API_KEY` | OpenAI-compatible Responses 端点与凭据 |
| `LIGHT_MODEL`、`HEAVY_MODEL`、`COMPACTION_MODEL` | 三个模型槽位，必须显式配置，不互相回退 |

## API 可选

留空时按“缺省行为”运行，不会阻断启动（飞书除外，见下表）。

| 分组 | 变量 | 缺省行为 |
| --- | --- | --- |
| 基础 | `PORT` | 4000 |
| | `SESSION_MAX_AGE_SECONDS` | 7776000（90 天；多久没用才过期，用着就续期） |
| | `EXTRA_ALLOWED_ORIGINS` | 除 `PUBLIC_ORIGIN` 外不放行其他来源；仅本地开发填写，逗号分隔 |
| | `BUILD_SHA` | `dev`，健康接口原样返回 |
| | `COMPANY_NAME` | 引导里不显示公司名 |
| | `ONBOARDING_DELEGATION_STEP` | 设为 `1` 才显示“授权天枢替你记进本体”一步 |
| | `TIANSHU_ADMIN_PERSON_IDS` | 逗号分隔的 personId；留空时没有人能看管理员视图 |
| 任务卡 | `MISSION_CARD_DRAFTS_DIR` | 讨论候选目录；Compose 缺省 `/repo/seed/placeholders` |
| | `MISSION_CARD_KNOWN_MISSIONS_FILE` | 起草时参考的已知本月任务；文件缺失照常起草 |
| 服务令牌 | `ONTOLOGY_SERVICE_TOKEN` | 本体拉每周进展的只读令牌；不填时对应接口返回 503 |
| | `INTERNAL_CHAT_TOKEN` | 独立 Chat 读确认会议（`/internal/confirmed-meetings`）的服务凭据；不填时接口一律 404 |
| | `NEXUS_DRI_SERVICE_TOKEN`、`NEXUS_DRI_TENANT_ID` | Nexus → DRI 确认的接收端（`/api/integrations/nexus/dri/*`）：Nexus 调天枢用的服务凭据，和天枢这边的租户（请求的 `recipientTenant` 要等于它）。都填才开，不填时接口一律 404 |
| | `NEXUS_DRI_AGENT_ID` | 请求里 `agentId` 要等于它；不填是 `tianshu-dri`（本地回放合成样例时换成样例里的值） |
| | `NEXUS_DRI_CALLBACK_URL`、`NEXUS_DRI_CALLBACK_SECRET` | 本人确认后回调 Nexus 的地址和 HMAC 共享密钥（至少 32 字节）；不填就不发，确认记录留在待发，填上重启后补发 |
| | `CHAT_SERVICE_URL` | 首页对话改走独立 Chat 服务的地址（预发 `http://chat:3101`），用 `INTERNAL_CHAT_TOKEN` 转发本人身份；不填时走天枢自己的对话，对象页对话不受影响 |
| 对话分段 | `CHAT_SESSION_ROTATION` | 设为 `1` 才开首页分段：首页的 Chat 对话闲置满 12 小时或跨过北京时间凌晨 4 点新开一段，界面拼最近 7 天的几段；同时在 `/internal/home-cards` 末尾多给 Chat 一张「以前的对话」卡（上一段纪要 + 近 14 天目录，见 `docs/guides/chat-conversation-recall.md`） |
| | `CONVERSATION_SEGMENTS` | 设为 `1` 才开天枢页面的对话分段：同一条规则换段，模型侧只带这一段，上一段经会话目录里的纪要交接，另给两个回看工具。缺省关，照旧闲置 12 小时只带摘要重开。两个分段开关都关时不跑会话纪要的后台任务 |
| 本体 | `TKOS_WORLD_API_URL`、`TKOS_WORLD_AGENT_TOKEN` | 都不填时本体相关能力如实显示未配置 |
| | `TKOS_WORLD_AGENT_TOKEN_FILE` | 从文件读凭证（只在内存里）；读失败时健康接口报告错误码 |
| | `TKOS_WORLD_INSTANCE` | `mvp`；可选 `demo`、`formal`、`tk`，对应 `apps/api/config/world-instance*.json` |
| | `TKOS_WORLD_INSTANCE_LOCAL_FILE` | 只合并人员对应（people），其余以仓库实例配置为准 |
| | `TKOS_WORLD_TK_INSTANCE`、`TKOS_WORLD_TK_API_URL`、`TKOS_WORLD_TK_TOKEN_FILE` | 第二个只读实例，只接受 `tk`；不填就关闭。地址缺省沿用主实例，凭证只从文件读 |
| | `TKOS_WORLD_PERIOD_GOAL_GATES` | 设为 `1` 才在签发月度计划后代记本体周期目标的门（签发时那一版草稿代 RU DRI 承诺，再代 CEO 确认；RU DRI 按实例配置的 `unit_dris` 逐域写明）；还要实例配置允许写。只管这一项，会议、周复盘等写入不受影响 |
| 公司事实与记忆 | `COMPANY_WORLD_ACCESS_FILE` | 按人授权的本体域，JSON `{"<personId>":["<domain_id>"]}`。公司事实只认本体：不填或读不到时如实说没读到，不用本地资料兜底 |
| | `COMPANY_SYSTEM_PERSON_ID` | 后台服务（雷达、会前预审、预研、月度起草与复盘、任务卡起草）读本体用谁的授权；这个 personId 要在授权文件里有域。不填时这些服务如实说没读到本体 |
| | `MEMORY_STORAGE_DIR` | 本体公司事实的只读投影写在 `<目录>/company`，可重建；不填用 `/tmp/warmap-company`。个人记忆存数据库，不在这里 |
| | `MEMORY_RECALL_MODEL` | 每轮从本人记忆目录挑相关条目的快模型；不填依次用 `TRIAGE_MODEL`、`LIGHT_MODEL` |
| 对话模型 | `CONVERSATION_MODEL`、`CONVERSATION_API`、`CONVERSATION_BASE_URL`、`CONVERSATION_THINKING` | 一号位主答；不配时按档位选模型（快答用 `HEAVY_MODEL`，检索问答与深度档用 `conversationModel.ts` 内置的模型），配一个 id 时三档都用它。协议按模型 id 推断（`claude-*` 走 Anthropic 协议），`CONVERSATION_API` 只能是 `openai-responses` 或 `anthropic-messages` |
| | `TRIAGE_MODEL` | 分诊；不配时用 `LIGHT_MODEL` |
| Agent 模型 | `PREFLIGHT_MODEL`、`PREFLIGHT_THINKING` | 会前预审：`HEAVY_MODEL`、思考 high |
| | `RESEARCH_*`、`OUTCOME_*` | 预研、会后提取：`HEAVY_MODEL`、不开思考 |
| | `RADAR_*`、`PERSONAL_RADAR_*` | 公司雷达：`LIGHT_MODEL`；个人雷达跟公司雷达 |
| | `MEMORY_IMPORT_MODEL`、`MEMORY_IMPORT_THINKING` | 记忆导入分类与去重：`LIGHT_MODEL` |
| | `PROGRESS_SUMMARY_MODEL`、`PROGRESS_SUMMARY_THINKING` | 战场进展汇总（每天 07:30 与页面打开时）：`HEAVY_MODEL`、思考 medium |
| | `TASK_PLACEMENT_MODEL`、`TASK_PLACEMENT_THINKING` | 会后分派的事项归位（挑挂到哪个 Mission）：`LIGHT_MODEL`、不开思考 |
| | `CONVERSATION_DIGEST_MODEL`、`CONVERSATION_DIGEST_THINKING` | 会话纪要（后台，一段闲置 15 分钟后增量写）：`LIGHT_MODEL`、不开思考；设计上用 TokenHub 上的 qwen 快模型 |
| 雷达 | `BOCHA_API_KEY` | 博查是唯一 Web Search；缺失时雷达卡如实显示未配置 |
| | `WECHAT_MCP_URL`、`WECHAT_MCP_TOKEN` | 公众号 sidecar 的内网 MCP；Compose 地址缺省 `http://wechat:5000/mcp` |
| 录音与声纹 | `TOS_ACCESS_KEY`、`TOS_SECRET_KEY`、`TOS_ENDPOINT`、`TOS_REGION`、`TOS_BUCKET` | 五项配全才能上传录音 |
| | `VOLC_ASR_API_KEY`，或 `VOLC_ASR_APP_KEY` 加 `VOLC_ASR_ACCESS_KEY`；`VOLC_ASR_RESOURCE_ID` | 火山录音识别；资源 ID 缺省 `volc.seedasr.auc` |
| | `TENCENTCLOUD_SECRET_ID`、`TENCENTCLOUD_SECRET_KEY`、`TENCENT_ASR_REGION`、`TENCENT_VOICEPRINT_GROUP` | 本人声纹；缺少时声纹不可用 |
| | `TENCENT_ASR_APP_ID`、`TENCENT_ASR_ENGINE` | 输入框实时听写；缺少时退回“说完再转” |
| | `ARK_API_KEY`、`ARK_BASE_URL`、`DICTATION_POLISH_MODEL`、`DICTATION_POLISH_BACKUP_MODEL`、`DICTATION_POLISH_TIMEOUT_MS` | 听写后整理；缺 key 或模型时保留识别原文 |
| | `FFMPEG_PATH` | 缺省从 PATH 找 ffmpeg |
| 文件目录 | `MEETING_MATERIAL_STORAGE_DIR`、`CONVERSATION_ATTACHMENT_STORAGE_DIR`、`MEETING_RECORDING_STORAGE_DIR` | 本地直跑可留空用默认目录；Compose 固定为持久卷 |
| 飞书 | `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_TOKEN_KEY` | 三项都留空＝关闭飞书（路由 404，不起长连接）；只填一部分 API 启动失败。`FEISHU_TOKEN_KEY` 为 base64 的 32 字节，与 `SESSION_SECRET` 分开 |
| | `FEISHU_TOKEN_KEY_VERSION` | 1；换密钥时递增，空串会被判非法 |
| 微信 ClawBot | 无单独配置 | 接了飞书就开：个人菜单「设置 › 连接微信」扫码绑定，bot token 用 `FEISHU_TOKEN_KEY` 加密。同一个微信 bot 同一时间只能有一个进程在收消息，生产和预发不要绑同一个人的微信 |
| | `FEISHU_BITABLE_MODE` | 只有 `live` 才写真实多维表格，其余为 mock |
| | `FEISHU_WEB_ORIGIN` | 飞书网页域名（如 `https://tokenking.feishu.cn`）；会议事件写本体时拼妙记链接，留空不带链接 |
| | `COLLECTIONS_ENABLED` | 只有 `1` 才开信息收集（收集接口、每分钟收集任务、对话里发起收集、定时任务里的收集项），其余关 |
| | `DOC_CHANGE_ENABLED` | 只有 `1` 时群里贴文档链接才触发文档变更推送，其余关 |
| 观测 | `LANGSMITH_TRACING`、`LANGSMITH_API_KEY` | 只有 `LANGSMITH_TRACING=true` 且有 key 才上报 |
| | `LANGSMITH_PROJECT` | Compose 缺省 `warmap`，代码缺省 `default` |
| | `LANGSMITH_ENDPOINT` | SDK 默认端点 |
| | `TRACE_ANON_SALT` | 匿名用户 id 的盐；不填时生成本地 `.data/trace-anon-salt` |

`COMPANY_TIMEZONE` 不是运行时配置：公司时区在代码里固定为 `Asia/Shanghai`。

## 仅 Compose 与宿主机使用

| 变量 | 用途 |
| --- | --- |
| `PUBLIC_DOMAIN`、`POSTGRES_PASSWORD` | 站点域名与数据库密码，必填 |
| `NPM_CONFIG_REGISTRY`、`ALPINE_MIRROR` | 构建参数，主机拉依赖慢时换镜像源 |
| `WECHAT_SITE_URL`、`WECHAT_LOGIN_PORT`、`WECHAT_PROXY_URLS` | 公众号 sidecar 自身配置与首次扫码端口 |
| `M2_SEED_DIR`、`M2_INTERNAL_TOKEN`、`M2_MODEL_KEY`、`M2_MODEL_BASE`、`M2_MODEL`、`M2_CHAT_MODEL`、`M2_CASCADE`、`M2_ROUND_OPERATORS`、`M2_WORLD_READ_TOKEN` | 启用 `infra/m2.override.yml` 时使用，见 [M2 试用](m2-trial.md) |
| `BACKUP_*`、`WARMAP_*` | 宿主机备份脚本，见[部署指南](deployment.md#备份与恢复) |

## 生成随机值

```bash
openssl rand -base64 32
```

`SESSION_SECRET`、`DRI_SERVICE_TOKEN`、`FEISHU_TOKEN_KEY` 各用不同的值，不同环境不得复用。
