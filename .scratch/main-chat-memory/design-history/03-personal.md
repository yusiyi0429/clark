# 03 · 每人 Personal.md 与自然蒸馏

Type: implementation
Status: ready-for-agent
Blocked by: —（对话消费接入依赖 04）

## 工作

- 按 memory-design.md §5–8 建立本人文档、revision、串行更新、持久蒸馏任务和遗忘排除记录。
- 主聊成功提交时同事务排任务；后台读取本人消息，Company/Anchor/工具输出不得变成个人事实依据。
- Prompt 输出 add/update/remove/noop，区分明确偏好、稳定个人情况与谨慎归纳；不用“记住”作触发条件。
- 实现本人 GET/PUT/forget TypeBox 接口与 revision 冲突；不允许替换 owner，不开放任意文件路径。
- 处理重启 pending_revision、跨 scope 任务顺序、纠正与遗忘；明确遗忘不依赖助手成功回答。
- 默认从切换后的新对话蒸馏，Personal 初始为空；不批量扫描旧聊天或群消息。

## 完成定义

- 同人跨 scope 可读同一份记忆，不同人完全隔离；目录/缓存/日志/任务均核对 owner。
- 临时情绪、假设、他人转述、助手建议与公司目标不会自动变成个人事实。
- 重复消费同一任务不重复写入，旧任务不会覆盖新纠正，写入中断可正确恢复。
- 遗忘后旧任务、历史召回、Pi entries、缓存不会重新带回对应属性；新明确授权与旧信息区分。
- 失败不影响主回答；超过容量不静默截断正文。用代表性语义样本核对蒸馏质量。
