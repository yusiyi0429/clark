# 生产 Pi Runtime 不加载用户环境

CEO WarMap 使用自定义 ResourceLoader，关闭 Pi 的用户级 Skills、AGENTS、Prompt、文件、Shell 和写入工具；每个场景只加载独立 Prompt 及明确允许的 Web Search、本体公司事实读取（ADR-0027，原 CompanyMemory MCP 已退役）或结构化候选提交 Tool。这样保留 Pi 的 loop、Session 和 compaction，同时防止开发机配置或 coding-agent 能力进入生产业务边界。