# 隔离审计/验收环境 Runbook 提醒（非代码备忘）

- 任何隔离 mock 验收（Stage 2 风格的独立 API + Postgres + `next dev`）在**启动 API 之前**必须把模型/外部端点指到死地址：`PI_BASE_URL=https://provider.invalid/v1`、`PI_API_KEY=<占位>`，Radar/WebSearch 凭据一律不设（`BOCHA_API_KEY`/`WECHAT_MCP_URL` 留空）。
- 原因：API 启动即装配 research/radar/monthly scheduler 与 recovery 路径（`recoverInterruptedResearch/Preflight/Outcome`）；种子数据若带 running 态或调度器触发，会在启动后立即外呼真实模型/搜索。死端点保证即使误触发也只是本地失败，不产生外部调用与费用。
- 审计结束后按 Stage 2 报告口径复核：进程 0、容器 0、`/tmp` 目录 0、端口关闭，并复核共享 staging（healthz、行数、关键列）未被触碰。
- 本提醒不改变任何部署配置；生产 compose 的真实凭据装载见 infra/.env（Ticket 15/16 范围）。
