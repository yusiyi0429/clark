# MVP 使用单机 Docker Compose 和 PostgreSQL

桌面 Web、独立 API 与 PostgreSQL 部署在一台云服务器的 Docker Compose 中；六实体、配置、Conversation、Transcript JSONB 和 Agent 产出均进入 PostgreSQL。API 内的轻量 scheduler 用数据库锁和日期键防止重复运行，不增加 Redis、消息队列或对象存储；数据库每天生成异机加密备份并在上线前完成至少一次真实恢复验证。