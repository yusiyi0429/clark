# 10: 导入 Transcript 并抽取 MeetingOutcome

Type: implementation
Status: ready-for-agent
Blocked by: 09 完成 Meeting 创建与会前准备

## What to build

让 CEO 或集成客户端向 Meeting 导入严格结构的 Transcript，成功后进入 held 并抽取可追溯的 MeetingOutcome Candidate Material。

## Acceptance criteria

- [ ] Web 与服务接口只接受 `warmap-transcript.v1`，并执行相同的认证、大小限制和 schema 校验。
- [ ] 重复 turn ID、未知 speakerId、空文本、时间顺序或其他必填错误导致整份拒绝且不改变 Meeting。
- [ ] 有效 Transcript 在一个事务中保存并把 scheduled Meeting 变为 held，提交后才启动 Outcome 抽取。
- [ ] 每个 Outcome item 绑定准确 turnId，quote 必须连续存在于被引用 turn，而非仅存在于全文其他位置。
- [ ] owner、CEO judgment 和权限类型依据 Person/speaker 确定性校验，未知身份不能产生组织效果候选。
- [ ] 抽取失败保留原始 Transcript，页面展示失败原因并允许 CEO 显式重试。
- [ ] Transcript 替换只允许不存在 confirmed effect 时经危险 Action 二次确认；替换使旧 candidate 和 actionId 失效并重新抽取。
- [ ] 不实现录音、ASR、说话人猜测、格式转换或部分导入。

## Comments
