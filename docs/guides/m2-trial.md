# M2 内部试用发布

## 部署边界

M2 是同站点 `/m2/` 的独立应用。主站入口、发布脚本、备份与回滚见[部署指南](deployment.md)；现网主机、目录与 compose 组合以 [`infra/staging/release.md`](../../infra/staging/release.md) 为准。执行前核对现网域名、主机、目录和当前部署人，仓库记录不能替代现网验证。

## 发布输入

1. 明确合入提交 SHA，保留旧 API/Web 镜像和已核对的旧版启动参数。
2. 在原 demo 工作区只读导出当前第 13 轮：
   `node apps/m2/export-trial.mjs <demo-workspace> <private-directory>`。
   导出包含旧轮归档及人工记录，禁止打印内容或上传到 Git；snapshot-receipt.json 记录原文件哈希。
3. 核对旧版实际人员 seed 的稳定 personId，再建立 accounts.json。使用 accounts.example.json 的结构；每个账号与成员编号唯一。不要根据重名、职责名称或工作台视角猜测。配置文件由发布人回读核对九位成员，包括兼任职责者。
4. 将私有数据目录通过受控渠道交接到服务器，归 uid/gid 1000，目录 0700，文件 0600。
5. 在服务器受限的 `infra/.env` 中配置：M2_SEED_DIR（私有目录）、M2_INTERNAL_TOKEN（随机至少32字符）、M2_MODEL_KEY（服务端模型凭据），以及可选 M2_WORLD_READ_TOKEN（产品专用只读凭证）。模型沿用本次 demo 的明确模型；修改模型或技能属于另一轮验证，不混入本次接入。

模型默认走 TokenHub 的 HTTPS 域名 `https://tokenhub.corp.tokenkingos.com/api/openai/v1`（2026-10-16 起替换原 IP 加端口的 HTTP 地址）。程序只接受 HTTPS。发布人需核对容器内能解析并访问该域名；可通过 M2_MODEL_BASE 显式配置其他团队核对过的 HTTPS 地址。不能把个人钥匙串或 Codex agent.token 复制到服务器。

## 模型与开关

- `M2_MODEL`、`M2_CHAT_MODEL`（容器内为 `DECODING_MODEL`、`DECODING_CHAT_MODEL`）缺省都是 `wangsu/claude-sonnet-5-5`。前者用于拆解生成，后者用于 Nexus 群聊和私人 Agent。Claude 在 TokenHub 上只走 Messages 接口，程序按 TokenHub 地址自动改用 `/api/anthropic/v1/messages`，不用另配地址；同一个 `M2_MODEL_KEY` 即可。
- Messages 流断开时，`.runtime/stream-breaks.jsonl`（在 `m2_state` 卷里）记一行诊断：时间、模型、请求编号、持续时间、字节数、最后 15 个事件的类型名和原因，不含模型输出和密钥。需要排查时从卷里导出。
- `M2_ROUND_OPERATORS` 写成员编号（逗号分隔，如 `member-04`）。名单里的人和 CEO 一样，可以在页面上开始、续跑、载入新一轮，并看到生成进度详情；不带确认计划或查看计划审核的权限。缺省为空，只有 CEO 能开新一轮。
- `M2_CASCADE=off` 关闭下级对齐：上级卡片修订后，Nexus 不再按技能对照下级并出修订卡。缺省开启。
- 技能随镜像固定为 `apps/m2/skill`（tkos-decoding 3.1.5，指纹 `01a9b1723261`）。新一轮从本体生成时，私有 seed 里的 `source-manifest.json` 要用 10/17 版本体选择清单（各单元 10 月 PO、Mission、Task 标为参考答案，不进入生成）。只阅读和协作已有计划时不受影响。

## 从已上线版本升级

已有 `m2_state` 卷直接沿用，不重新导入。升级前先备份 `m2_state`，并记下当前 m2、web 镜像标签。新版本会在状态里增加下级对齐队列、Activity 生成记录等字段；回退到旧镜像时如果读取异常，用这次备份恢复 `m2_state`。

## 部署

使用原 Compose 参数和现行火山 override，额外加入 `-f infra/m2.override.yml`。该文件增加独立 m2 服务和卷，并让 edge 使用 Caddyfile.m2；默认旧栈不启用 M2。

先在仓库根目录运行 `docker compose -f infra/docker-compose.yml -f infra/volcano.override.yml -f infra/m2.override.yml --env-file infra/.env config --quiet`（现网按 `infra/compose-files` 带全部 `-f`），避免打印展开后的密钥。用 `release.sh` 发布时按 [release.md](../../infra/staging/release.md) 的「M2 内部试用」一节执行。备份旧栈以及已有 m2_state，再构建 M2 和 Web，启动 M2，确认健康，再更新 Web 和 edge。API 无代码改动，无新数据库迁移。上线地址为 `https://tk.tokenkingos.com/m2/`。

原本体选择清单针对截至 10/9 的事实。这次导出的第13轮也沿用该时点输入。“实时读取”表示重新核对这些来源，不表示自动纳入10/10后的进展。资料或组织责任变化时按来源校验停止，由负责人重新审查清单。

## 本地运行

M2 读取进程环境，不自动加载 env 文件。准备私有 seed 与账号映射（结构见 `apps/m2/accounts.example.json`）后，在 `apps/m2` 目录导出所需变量再启动：`M2_SEED_DIR`、`M2_ACCOUNT_MAP_FILE`、`M2_INTERNAL_TOKEN`、`M2_AUTH_API_URL`（本地 API 为 `http://127.0.0.1:4000/api/auth/session`），模型用 `DECODING_API_BASE`、`DECODING_API_KEY`、`DECODING_MODEL`，本体只读用 `TKOS_WORLD_PRODUCT_TOKEN`。端口取 `PORT`，缺省 4333；不要和 API 共用同一个 `PORT` 值。

```bash
pnpm --filter @warmap/m2 build
pnpm --filter @warmap/m2 start
```

先登录主应用，再访问 `http://localhost:3100/m2/`。Web 开发代理把 `/m2/*` 转到 `M2_SERVER_URL`（缺省 `http://localhost:4333`）。M2 每次请求仍向 API 校验会话。

## 验收

- CEO、RU DRI 和 Mission DRI 登录旧版后都能看到入口，打开后自动进入本人。
- 任意改 URL 或请求中的 memberId 不能换人；未登录与重置后的旧会话不能访问 M2。
- 用两账号完成公开意见、建议、接受／不采用、修订与同版确认；另一账号的私聊不可读。
- 当前计划、历史和人工记录与导出回执一致。旧版计划没有被写入。
- 正常停止再启动，M2 记录恢复。真实部署模型群回应和本体读取单独核对；本次本地自动测试使用隔离数据及可控响应。

## 停止和回退

先停 M2 入口流量，再正常停止 m2，保留 m2_state 和私有 seed；回退 Web 镜像和 edge 原 Caddyfile。不删除卷、不恢复旧版数据库。

M2 使用单进程写锁。异常强杀可能留下锁文件；只能在确认 m2 已停止、没有其他进程使用同一卷并备份后清理残留锁。禁止并行启动两个进程写同一文件。长模型调用期间不要直接重启；生成中重启会保存明确失败状态，再人工续跑。

服务器权限和现网配置未交接前，PR 与本地验证可以完成，上线验收仍为待执行。
