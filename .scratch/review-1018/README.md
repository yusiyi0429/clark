# integration/review-1018 审核演示库

只给本地审核用：库是 54329 上的 `tianshu_review_1018`，文件放在 worktree 的 `.data/review-1018/`（gitignore）。

## 灌数（会删库重建）

在 worktree 根目录：

```powershell
node apps/api/node_modules/tsx/dist/cli.mjs .scratch/review-1018/seed.ts
```

- 要先有 54329 的 Postgres（容器 `tkos-preview-test-pg-54329`）；别的端口用 `REVIEW_PG_ADMIN_URL` 指过去。
- 人员名单取主工作区 `seed/company-people.json` 里的四个人，写到 `.data/review-1018/people.json`。
- 模型网关只从主工作区 `apps/api/.env` 读 `PI_BASE_URL`、`PI_API_KEY`、`LIGHT_MODEL`、`HEAVY_MODEL`、`COMPACTION_MODEL`、`COMPANY_TIMEZONE`，进程内使用，不落盘。本体、飞书、LangSmith、对象存储、博查一概不读。
- 灌数要 3–6 分钟：本周周复盘（孙铭泽、唐巨杰）和十月个人复盘（孙铭泽、唐巨杰）用真实模型起草。
- ⑨ 请求和首页两段历史对话用脚本化 Agent 写入（模拟已经发生的事）；之后在页面上的操作都走真实模型。
- 演示库给 `conversation_messages` 加了一个触发器，把 `created_at` 截到毫秒：main 上个人记忆提炼的游标只有毫秒精度，
  不截的话最后一条消息永远排在游标之后，提炼每个 tick 都重跑一次真实模型（审核期间会一直空烧网关）。这只是演示库的绕法，代码没改。

## 启动

用 `.claude/launch.json` 的 `review-1018`：网页 http://localhost:3818 ，API 4818。
等价命令：`node .scratch/review-1018/run.mjs`。

API 一启动，周复盘定时任务会给名单里还没有本周周复盘的人（刘明华、陈溪南）各起草一次（周五 15:00 到周日 24:00 之间才会）。

## 账号（口令都是 8742，已跳过首次改码）

| 登录 ID | 人 | 角色 | 用来看 |
|---|---|---|---|
| `lium` | 刘明华 | CEO（也能切 DRI 视角） | 首页连续对话、记忆小标记、⑨ 起草与「有人提问」、周复盘与个人复盘看板 |
| `sunm` | 孙铭泽 | 成员 | 待办卡、「帮我问问」「生成我的复盘」、本周复盘待确认、个人复盘 |
| `tangj` | 唐巨杰 | 成员 | 备案表请求的发起人、访谈纪要请求的接收人 |
| `chenx` | 陈溪南 | 成员，引导未完成 | 登录后进 `/welcome`，看采集器同意开关 |
