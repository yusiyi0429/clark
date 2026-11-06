// 真 Claude Code（订阅 haiku）在卡的工作树里先问本人一次（AskUserQuestion），本人在「网页」上选一个选项，它照回答写文件。
// 看三件事：提问到网页时是「等你回复」带问题和选项（不是权限请求）；回答交回去它真的按选项做；工作树里写文件不用批准。
// 用法：先起本机程序（--headless，TIANSHU_LOCAL_AUTO_APPROVE=1、TIANSHU_LOCAL_PICK_FOLDER=<一个 git 仓库>），再
//   node M_question-e2e.mjs --port 47673 --out <结果.json>
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const arg = (name, dflt) => { const i = process.argv.indexOf(name); return i >= 0 ? process.argv[i + 1] : dflt; };
const port = Number(arg("--port", "47673"));
const out = arg("--out");
const origin = "https://tk.tokenkingos.com";
const base = `http://127.0.0.1:${port}`;
const t0 = Date.now();
const at = () => +((Date.now() - t0) / 1000).toFixed(1);
const log = [];
const say = (what, data) => { const e = { t: at(), what, ...(data ? { data } : {}) }; log.push(e); console.log(JSON.stringify(e)); };

let token = "";
async function api(method, path, body) {
  if (body === undefined && method !== "GET" && method !== "DELETE") body = {};
  const res = await fetch(base + path, {
    method,
    headers: { origin, ...(token ? { "x-tianshu-local-token": token } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.error?.message ?? ""}`);
  return json;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const p = await api("POST", "/v1/pairings", { clientLabel: "提问真跑" });
for (;;) {
  const s = await api("GET", `/v1/pairings/${p.pairingId}`);
  if (s.token) { token = s.token; break; }
  await sleep(300);
}
const work = (await api("POST", "/v1/folders/pick")).folder.path;
await api("PUT", "/v1/models/e2e-haiku", { label: "订阅 · haiku", source: "subscription", model: "haiku", isDefault: true });

const card = await api("POST", "/v1/sessions", {
  subject: { kind: "card", cardId: "q-e2e" }, title: "问一下再写", cwd: work,
  firstMessage: "先用 AskUserQuestion 问我：写哪个文件？选项 a.txt、b.txt。然后只写我选的那个，内容是「选了」。写完就停，不用交回。",
});
say("开工", { status: card.status, workspace: card.workspace });

let answered = null;
let final = null;
for (const deadline = Date.now() + 240_000; Date.now() < deadline;) {
  const { session } = await api("GET", `/v1/sessions/${card.id}`);
  if (session.pendingQuestion && !answered) {
    say("等你回复：提问", { status: session.status, question: session.pendingQuestion });
    const q = session.pendingQuestion.questions[0];
    const pick = q.options.find((o) => o.label.includes("b.txt"))?.label ?? q.options.at(-1).label;
    answered = await api("POST", `/v1/sessions/${card.id}/questions/${encodeURIComponent(session.pendingQuestion.requestId)}`, {
      choices: session.pendingQuestion.questions.map((_, i) => (i === 0 ? [pick] : [])),
      ...(session.pendingQuestion.questions.length > 1 ? { text: "其余按你的判断" } : {}),
    });
    say("回答了", { pick, status: answered.session.status });
  }
  if (session.pendingPermissions) say("要批准（不该有）", { n: session.pendingPermissions });
  if (answered && session.status === "idle" && !session.pendingQuestion) { final = session; break; }
  await sleep(1000);
}

const evs = readFileSync(join(arg("--data-dir"), "sessions", card.id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
const wt = final?.workspace?.path ?? card.workspace?.path;
const result = {
  run: "11/07，源码起的本机程序 + 真 Claude Code（订阅 haiku），临时 git 仓库",
  workspace: card.workspace,
  question: evs.find((e) => e.type === "question")?.request ?? null,
  resolved: evs.find((e) => e.type === "question_resolved") ?? null,
  permissionRequests: evs.filter((e) => e.type === "permission_request").map((e) => e.request.title),
  toolCalls: evs.filter((e) => e.type === "tool_call").map((e) => e.name),
  assistantText: evs.filter((e) => e.type === "assistant_text").map((e) => e.text.slice(0, 200)),
  files: { "a.txt": wt && existsSync(join(wt, "a.txt")) ? readFileSync(join(wt, "a.txt"), "utf8") : null, "b.txt": wt && existsSync(join(wt, "b.txt")) ? readFileSync(join(wt, "b.txt"), "utf8") : null },
  mainFolderUntouched: !existsSync(join(work, "a.txt")) && !existsSync(join(work, "b.txt")),
  finalStatus: final?.status ?? null,
  costUsd: final?.usage?.costUsd ?? null,
  log,
};
if (out) writeFileSync(out, JSON.stringify(result, null, 2));
console.log(JSON.stringify({ ...result, log: undefined }, null, 1));
process.exit(0);
