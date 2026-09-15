# 16: 完成 Compose 部署与真实外部验收

Type: implementation
Status: ready-for-agent
Blocked by: 15 建立全链测试、观测与安全门槛

## What to build

把已通过功能门槛的系统部署到 integration/staging，验证 Caddy TLS、真实 Provider、生产模型、CompanyMemory MCP、备份恢复和上线 smoke。

## Acceptance criteria

- [ ] Caddy、Web、API 和 PostgreSQL 通过单机 Docker Compose 运行，只有 Caddy 暴露 80/443 并自动处理证书与 HTTP 跳转。
- [ ] Web/API 镜像可重复构建、以非 root 运行；migration 在 API 接流量前完成且不会自动回滚数据库。
- [ ] SSE、Transcript multipart、DRI service API 与 MCP 均直接经 Caddy 正确透传，不经过 Web rewrite。
- [ ] 一个真实 Web Search query 返回 title、URL、excerpt，并由 Pi 完成一次自主 Tool loop。
- [ ] 一个真实公众号账号按账号拉取文章并进入同一 Signal 管线，不以站点关键词搜索替代。
- [ ] light、heavy、compaction 模型槽位和合法 Transcript 各完成一次真实验收。
- [ ] CompanyMemory MCP 装载真实人员 seed，Pi 与独立客户端得到一致稳定 personId。
- [ ] 宿主机 cron 生成 age 加密 pg_dump、校验 checksum、经 SSH/SFTP 复制异机并保留至少 7 天。
- [ ] 独立 restore 流程恢复到空 PostgreSQL，不覆盖现有库；恢复后抽查六实体、Transcript、消息和 Pi entries，并继续一次 Conversation。
- [ ] staging smoke、回滚步骤和发布观察清单完成；未引入 Redis、队列、对象存储、Kubernetes或额外 Runtime。

## Comments
