// 从本机程序的数据目录汇总 L 真跑的结果（L_plan-verify-e2e.mjs 第一次跑时，汇总那段脚本出错，链路本身已跑完）。
// 用法：node L_collect.mjs <本机程序数据目录> <工作目录> <结果.json>
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const [dataDir, work, out] = process.argv.slice(2);
const dir = join(dataDir, "sessions");
const sessions = readdirSync(dir).filter((id) => existsSync(join(dir, id, "session.json"))).map((id) => {
  const rec = JSON.parse(readFileSync(join(dir, id, "session.json"), "utf8"));
  const events = readFileSync(join(dir, id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  return { rec, events };
}).sort((a, b) => a.rec.createdAt.localeCompare(b.rec.createdAt));

const view = ({ rec, events }) => ({
  kind: rec.subject.kind, title: rec.title, subject: rec.subject, status: rec.status, model: rec.modelLabel, costUsd: rec.usage.costUsd,
  lastReason: events.filter((e) => e.type === "status").at(-1)?.reason ?? null,
  firstMessage: events.find((e) => e.type === "user_message")?.text ?? null,
  toolCalls: events.filter((e) => e.type === "tool_call").map((e) => e.name),
  toolErrors: events.filter((e) => e.type === "tool_result" && e.isError).map((e) => e.preview.slice(0, 120)),
  permissionRequests: events.filter((e) => e.type === "permission_request").map((e) => e.request.title),
  notices: events.filter((e) => e.type === "notice" && e.code !== "agent_stderr").map((e) => `${e.code}: ${e.text}`),
  verdicts: events.filter((e) => e.type === "verdict").map(({ passed, failStreak, blocked, returnText, criteria, summary }) => ({
    passed, failStreak, blocked, returnText, summary, criteria: criteria.map((c) => `${c.index}:${c.verdict} ${c.reason}`),
  })),
  agent: events.find((e) => e.type === "agent_info") ?? null,
});

const result = {
  run: "11/06 下午，重新编的 tianshu-local-windows-x64.exe + 真 Claude Code（订阅 haiku），假天枢（收同步、给验收交代、给 get_task_context）",
  timeline: [
    "17.7 s 规划员交派活单（2 件，各对约定第 1、2 条，岗位「写作员」，档位 light）",
    "22.6 s 一批开工 2 件，都马上开始（上限 3）",
    "41.4 s 第 1 件交回 → 本机起验收员（排着等交代）→ 41.5 s 交回送到天枢、取到交代 → 41.9 s 开始",
    "45.5 s 第 2 件交回 → 本机起验收员 → 45.6 s 取到交代 → 46.0 s 开始",
    "60.1 s 第 1 份结论同步上去 → 63.0 s 验收员自己退出（验收完了）",
    "65.9 s 第 2 份结论同步上去",
  ],
  sessions: sessions.map(view),
  probeWritten: existsSync(join(work, "probe.txt")),
  filesInWork: readdirSync(work).filter((f) => !f.startsWith(".")),
  totalCostUsd: +sessions.reduce((s, x) => s + (x.rec.usage.costUsd ?? 0), 0).toFixed(4),
};
writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result.sessions.map((s) => ({ kind: s.kind, title: s.title, status: s.status, reason: s.lastReason, tools: s.toolCalls, perms: s.permissionRequests, verdicts: s.verdicts, errors: s.toolErrors })), null, 1));
console.log({ probeWritten: result.probeWritten, files: result.filesInWork, totalCostUsd: result.totalCostUsd });
