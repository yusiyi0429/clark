# 18: 切换生产入口并删除旧 frontend

Type: implementation
Status: ready-for-agent
Blocked by: 17 执行用户像素级验收与 cutover 授权

## What to build

在人工授权后把生产入口切换到新 CEO WarMap，完成 smoke 和观察；确认稳定后整体删除旧前端及其旧业务实现。

## Acceptance criteria

- [ ] 开始前确认 17 已 resolved，且包含明确的 cutover 与旧前端删除授权。
- [ ] 本机 age 加密与独立恢复证据、环境配置、DNS/TLS、migration 与回滚入口均已就绪；异机备份按 2026-09-16 用户风险豁免延期，不得描述为已完成。
- [ ] 切换后登录、首页、对象 URL、Action、SSE、Transcript、DRI API 与 MCP smoke 全部通过。
- [ ] 观察窗口内监测 health、错误、Agent usage、Provider 与数据库状态；触发既定条件时执行回滚。
- [ ] 稳定条件满足后整体删除旧 `frontend/`，不迁移其业务数据、localStorage、兼容路由或旧 Agent。
- [ ] 根 workspace、Caddy、构建、文档和部署配置不再引用旧前端。
- [ ] 最终验收确认目标路由、四条业务链、视觉回归和 bundle 边界仍通过。
- [ ] 在 map 的 Results 中记录切换时间、验证证据、删除范围与最终状态。

## Comments
