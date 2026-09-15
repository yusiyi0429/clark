---
status: superseded by ADR-0012
---

# 使用 OpenAI Agents API 作为 Agent Runtime

本决策曾计划由 Python API 服务使用 OpenAI Agents API 承载 Chat 的 agent loop、内置 Web Search、持久 Session 和上下文压缩。对现有 OpenAI-compatible Responses 端点进行验证后，改由 Pi SDK 在 TypeScript 服务中承载相同边界；见 ADR-0012。