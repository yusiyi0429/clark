// 拆卡和验收改在本机（V2 设计第 21 节）：规划员、验收员两种会话，交回后本机自己起验收员，结论报给云端和卡的会话。
// 假 claude：执行会话每轮要一次写文件的权限；只读会话（--disallowedTools 里有 Write）不来要权限，照会话 MCP 给的工具交计划或结论（内容在 .fake-claude.json）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { api, gitRepo, pair, raw, startTestRunner, tempDir, ORIGIN } from "./helpers.js";
import { agreementInBrief, CHINESE_RULE, EDIT_SCOPE_RULE, systemPrompt } from "../src/rolePrompt.js";

async function until<T>(fn: () => Promise<T | null | undefined | false> | T | null | undefined | false, ms = 10_000): Promise<T> {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error("等待超时");
    await new Promise((r) => setTimeout(r, 30));
  }
}

const REVIEWER = { id: "8a6f0f0e-1b2c-4d3e-9f40-5a6b7c8d9e0f", name: "验收员", kind: "reviewer", dutiesMd: "逐条判", practiceMd: "", acceptanceMd: "要有截图", tools: ["tianshu"], modelTier: "light", version: 2 };
const PLANNER = { id: "1f2e3d4c-5b6a-4978-8a9b-0c1d2e3f4a5b", name: "规划员", kind: "worker", dutiesMd: "拆卡", practiceMd: "", acceptanceMd: "", tools: ["tianshu"], modelTier: "normal", version: 1 };
const CRITERIA = ["页面能登录", "有截图"];
const FAILING = {
  summary: "第 2 条没截图",
  criteria: [{ index: 1, verdict: "met", reason: "能登录", evidence: "hello.txt" }, { index: 2, verdict: "unmet", reason: "没截图", fix: "补一张登录后的截图" }],
};
const PASSING = { summary: "都达到了", criteria: [{ index: 1, verdict: "met", reason: "能登录" }, { index: 2, verdict: "met", reason: "有截图" }] };
const PLAN = {
  summary: "拆两件", steps: [{ title: "改页面" }, { title: "补截图", detail: "登录后截一张" }], risks: ["登录接口可能要改"],
  cards: [
    { title: "改登录页", brief: "按约定第 1 条改", doneDefinition: "能登录", criterionIndex: 1, role: "前端", modelTier: "normal", why: "先通再美" },
    { title: "补截图", brief: "登录后截图", doneDefinition: "有截图", modelTier: "light" },
  ],
};

/** 假天枢：收同步（全部收下）、给验收交代（按 brief() 回）。 */
function fakeCloud() {
  const items: any[] = [];
  const asked: string[] = [];
  const agreementAsked: string[] = [];
  let agreement: (cardId: string) => { revision: number; brief: string | null; standards: string[] } | null | "offline" = () => null;
  let brief: (key: string) => { status: number; body?: unknown } | "offline" = () => ({ status: 200, body: { markdown: "# 验收交代", criteria: CRITERIA, role: REVIEWER, failStreak: 0 } });
  const impl = (async (input: any, init?: any) => {
    const url = new URL(String(input));
    if (url.pathname === "/api/local-runner/sync") {
      const body = JSON.parse(init.body);
      items.push(...body.items);
      return new Response(JSON.stringify({ accepted: body.items.map((i: any) => i.key), rejected: [] }), { status: 200, headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/api/local-runner/verify-brief") {
      const key = url.searchParams.get("handbackKey")!;
      asked.push(key);
      // 和真的天枢一样：还没收到这次交回就是 404
      if (!items.some((i) => i.type === "handback" && i.key === key)) return new Response("{}", { status: 404 });
      const r = brief(key);
      if (r === "offline") throw new Error("offline");
      return new Response(r.body === undefined ? "{}" : JSON.stringify(r.body), { status: r.status, headers: { "content-type": "application/json" } });
    }
    if (url.pathname === "/api/local-runner/card-agreement") {
      // 卡的约定（主循环第 60 条）：默认没有这张卡（404），本机照常交回
      const cardId = url.searchParams.get("cardId")!;
      agreementAsked.push(cardId);
      const a = agreement(cardId);
      if (a === "offline") throw new Error("offline");
      return a ? new Response(JSON.stringify({ cardId, ...a }), { status: 200, headers: { "content-type": "application/json" } }) : new Response("{}", { status: 404 });
    }
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, items, asked, agreementAsked, setBrief(fn: typeof brief) { brief = fn; }, setAgreement(fn: typeof agreement) { agreement = fn; } };
}

async function setup(max: number, opts: { link?: boolean; reuse?: { dataDir: string; work: string; token: string; cloud: ReturnType<typeof fakeCloud> } } = {}) {
  const work = opts.reuse?.work ?? tempDir("tl-pv-");
  const cloud = opts.reuse?.cloud ?? fakeCloud();
  const t = await startTestRunner({ pickFolder: work, fetchImpl: cloud.impl, dataDir: opts.reuse?.dataDir });
  const token = opts.reuse?.token ?? await pair(t.port);
  const call = (method: string, path: string, body?: unknown) => api(t.port, token, method, path, body);
  const link = () => call("PUT", "/v1/cloud", { apiBaseUrl: ORIGIN, token: "cloud-token-0123456789abcdef" });
  if (!opts.reuse) {
    await call("POST", "/v1/folders/pick", {});
    await call("PATCH", "/v1/settings", { maxConcurrent: max });
    // 档位按模型名认：light → Haiku、normal → Sonnet；卡的会话用默认的订阅
    await call("PUT", "/v1/models/haiku", { label: "Haiku", source: "subscription", model: "haiku" });
    await call("PUT", "/v1/models/sonnet", { label: "Sonnet", source: "subscription", model: "sonnet" });
    if (opts.link !== false) expect((await link()).status).toBe(200);
  }
  const fake = (cfg: unknown) => writeFileSync(join(work, ".fake-claude.json"), JSON.stringify(cfg));
  const session = async (id: string) => (await call("GET", `/v1/sessions/${id}`)).body;
  const list = async () => (await call("GET", "/v1/sessions")).body.sessions as any[];
  const status = async (id: string) => (await session(id)).session.status as string;
  const waitStatus = (id: string, want: string) => until(async () => (await status(id)) === want);
  // 每张卡一个子文件夹（不是 git 仓库的同一个文件夹同时只做一张卡，ADR 0038）；假 claude 往上找到 work 里的配置
  const card = (title: string) => {
    mkdirSync(join(work, title), { recursive: true });
    return { subject: { kind: "card", cardId: title }, title, cwd: join(work, title), firstMessage: `做 ${title}` };
  };
  const open = async (req: unknown) => (await call("POST", "/v1/sessions", req)).body;
  const allow = async (id: string) => {
    const s = await until(async () => { const b = await session(id); return b.pendingPermissions[0] ? b : null; });
    return call("POST", `/v1/sessions/${id}/permissions/${encodeURIComponent(s.pendingPermissions[0].requestId)}`, { decision: "allow" });
  };
  /** 以执行方的身份调本会话 MCP（密钥在会话记录里，每次拉起换一个）。 */
  const mcp = async (id: string, name: string, args: unknown) => {
    const secret = JSON.parse(readFileSync(join(t.dataDir, "sessions", id, "session.json"), "utf8")).mcpSecret;
    const r = await raw(t.port, {
      method: "POST", path: `/internal/sessions/${id}/mcp`, headers: { "x-tianshu-session-secret": secret, "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } }),
    });
    return r.body.result as { isError: boolean; content: { text: string }[] };
  };
  const events = (id: string) => readFileSync(join(t.dataDir, "sessions", id, "events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  const trace = () => existsSync(join(work, ".fake-claude-trace.jsonl"))
    ? readFileSync(join(work, ".fake-claude-trace.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
  /** 新开（--session-id）的先后。 */
  const started = () => trace().filter((l) => l.argv?.includes("--session-id")).map((l) => l.argv[l.argv.indexOf("--session-id") + 1] as string);
  const argvOf = (id: string) => trace().find((l) => l.argv?.includes(id))!.argv as string[];
  const verifies = async () => (await list()).filter((s) => s.subject.kind === "verify").sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const handBack = (id: string) => mcp(id, "hand_back", { summary: "做完了", criteria: [{ index: 1, result: "met", evidence: "hello.txt" }] });
  // 规划员在一个像样的仓库里拆（开拆前的检查不拦，设计 18.11）；假 claude 往上找到 work 里的配置
  const repo = opts.reuse ? join(work, "repo") : gitRepo(join(work, "repo"));
  /** 没绑文件夹的规划员：本人说一句（开拆前要问的算交代过了），等这一轮做完。 */
  const clarify = async (id: string) => {
    const turns = () => events(id).filter((e) => e.type === "turn_end").length;
    const before = turns();
    expect((await call("POST", `/v1/sessions/${id}/messages`, { text: "就在这里拆" })).status).toBe(200);
    await until(() => turns() > before);
  };
  return { t, token, work, repo, clarify, cloud, call, link, fake, session, list, status, waitStatus, card, open, allow, mcp, events, trace, started, argvOf, verifies, handBack };
}
const flagList = (argv: string[], name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1]!.split(",") : []);
const flag = (argv: string[], name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);

// 每条要拉起几个假 claude 进程，机器忙时单条要好几秒：显式给 30 秒，不靠 vitest 默认的 5 秒或 package.json 里的参数
describe("规划员和验收员", { timeout: 30_000 }, () => {
  it("排队先后验收员 → 规划员 → 执行；两者只读、各用自己的工具；验收员按岗位档位挑模型、交完结论就收工", async () => {
    const h = await setup(1);
    try {
      h.fake({ verdict: FAILING, plan: PLAN });
      // 本人加的工具：执行的挂，验收员、规划员不挂
      expect((await h.call("PUT", "/v1/tools/kd", { name: "金蝶", preset: "kingdee", url: "https://kd.example.com/mcp" })).status).toBe(200);
      const a = await h.open(h.card("A"));
      await h.waitStatus(a.id, "waiting_permission");
      const b = await h.open(h.card("B"));
      const p = await h.open({ subject: { kind: "plan", taskId: "T1" }, title: "拆卡：T1", cwd: h.repo, firstMessage: "拆卡交代", role: PLANNER });
      // 规划员后来的，但排在执行前面
      expect([(await h.session(p.id)).session.queuePosition, (await h.session(b.id)).session.queuePosition]).toEqual([1, 2]);

      // A 交回：本机自己起验收员，先排着等交代；交回送到天枢后取到交代，排到最前
      const hb = await h.handBack(a.id);
      expect(hb.content[0]!.text).toContain("本机接着起验收员验收");
      const handbackKey = (await until(() => h.cloud.items.find((i) => i.type === "handback"))).key;
      const v = (await until(async () => (await h.verifies())[0]));
      expect(v.subject).toEqual({ kind: "verify", cardId: "A", handbackKey });
      expect(v.title).toBe("验收：A");
      await until(async () => (await h.session(v.id)).session.modelLabel === "Haiku"); // 拿到交代，按验收员的档位（light）换了模型
      expect(h.cloud.asked).toEqual([handbackKey]);
      const positions = await Promise.all([v.id, p.id, b.id].map(async (id) => (await h.session(id)).session.queuePosition));
      expect(positions).toEqual([1, 2, 3]);

      // A 这一轮做完让位：验收员先开，交完结论自己退出；接着规划员；最后 B
      await h.allow(a.id);
      await until(async () => (await h.session(v.id)).session.status === "done");
      await h.waitStatus(p.id, "done");
      await h.waitStatus(b.id, "waiting_permission");
      expect(h.started()).toEqual([a.id, v.id, p.id, b.id]);
      expect(h.events(v.id).filter((e) => e.type === "status").at(-1)).toMatchObject({ status: "done", reason: "验收完了" });

      // 参数：验收员、规划员不给改东西的工具（子 agent 也不给），只给自己的那个工具和读 Task 上下文；验收员用 Haiku，执行用默认的订阅
      const [av, vv, pv] = [h.argvOf(a.id), h.argvOf(v.id), h.argvOf(p.id)];
      for (const argv of [vv, pv]) expect(flagList(argv, "--disallowedTools")).toEqual(expect.arrayContaining(["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash", "PowerShell", "Agent", "Task"]));
      expect(flagList(av, "--disallowedTools")).not.toContain("Write");
      expect(flagList(vv, "--allowedTools")).toEqual(["mcp__tianshu-session__submit_verdict", "mcp__tianshu__get_task_context"]);
      expect(flagList(pv, "--allowedTools")).toEqual(["mcp__tianshu-session__propose_plan", "mcp__tianshu__get_task_context"]);
      expect(flagList(av, "--allowedTools")).toEqual(expect.arrayContaining(["mcp__tianshu-session__hand_back", "mcp__tianshu__get_task_context"]));
      const toolServers = (argv: string[]) => Object.keys(JSON.parse(readFileSync(flag(argv, "--mcp-config")!, "utf8")).mcpServers).filter((k) => k.startsWith("tool-"));
      expect([toolServers(av), toolServers(vv), toolServers(pv)]).toEqual([["tool-kd"], [], []]);
      expect([flag(vv, "--model"), flag(av, "--model")]).toEqual(["haiku", "opus"]); // 执行没说档位：按标准档 Opus
      // 验收员的提示词：验收规矩 + 交代里的验收员岗位
      const vPrompt = readFileSync(flag(vv, "--append-system-prompt-file")!, "utf8");
      expect(vPrompt).toContain("你是验收员：只读");
      expect(vPrompt).toContain("## 你的技能：验收员");
      expect(readFileSync(flag(pv, "--append-system-prompt-file")!, "utf8")).toContain("你是规划员：只读");
      // 只读的两个从没来要过写文件的权限，第一句话是交代
      for (const id of [v.id, p.id]) expect(h.events(id).some((e) => e.type === "permission_request")).toBe(false);
      expect(h.events(v.id).find((e) => e.type === "user_message")).toMatchObject({ text: "# 验收交代", source: "initial" });

      // 同步给天枢：派活单草稿、验收结论（记模型、岗位和版本）
      await until(() => h.cloud.items.some((i) => i.type === "verdict") && h.cloud.items.some((i) => i.type === "card_plan"));
      const verdict = h.cloud.items.find((i) => i.type === "verdict");
      expect(verdict.subject).toEqual({ kind: "verify", cardId: "A", handbackKey });
      expect(verdict.data).toMatchObject({ passed: false, modelLabel: "Haiku", roleId: REVIEWER.id, roleVersion: 2, beyondScope: [] });
      expect(verdict.data.criteria.map((c: any) => [c.index, c.verdict, c.fix])).toEqual([[1, "met", null], [2, "unmet", "补一张登录后的截图"]]);
      const plan = h.cloud.items.find((i) => i.type === "card_plan");
      expect(plan.subject).toEqual({ kind: "plan", taskId: "T1" });
      expect(plan.data).toMatchObject({ revision: 1, summary: "拆两件", risks: ["登录接口可能要改"], roleId: PLANNER.id, roleVersion: 1 });
      expect(plan.data.steps).toEqual([{ title: "改页面", detail: null }, { title: "补截图", detail: "登录后截一张" }]);
      expect(plan.data.cards.map((c: any) => [c.title, c.criterionIndex, c.role, c.modelTier, c.why])).toEqual([["改登录页", 1, "前端", "normal", "先通再美"], ["补截图", null, null, "light", null]]);
      // 验收会话的 status 条目带着 kind=verify，云端不会当成卡 A 自己的状态
      expect(h.cloud.items.filter((i) => i.sessionId === v.id && i.type === "status").every((i) => i.subject.kind === "verify")).toBe(true);
    } finally {
      await h.t.cleanup();
    }
  });

  it("无上限（11.3）：验收员用重档（Opus high，不开多 agent），连续没过 3 次才受阻；自动的第 2 次就受阻", async () => {
    const h = await setup(3);
    try {
      h.fake({ verdict: FAILING });
      h.cloud.setBrief(() => ({ status: 200, body: { markdown: "# 验收交代", criteria: CRITERIA, role: REVIEWER, failStreak: 1 } }));
      const unlimited = { mode: "unlimited", hours: null, weeklyPercent: null, money: null };
      const a = await h.open({ ...h.card("A"), taskBudget: { taskId: "T-9", budget: unlimited } });
      await h.allow(a.id);
      await h.waitStatus(a.id, "idle");
      await h.handBack(a.id);
      const v = await until(async () => (await h.verifies())[0]);
      await h.waitStatus(v.id, "done");
      expect(h.events(a.id).find((e) => e.type === "verdict")).toMatchObject({ passed: false, failStreak: 2, blocked: false });
      const argv = h.argvOf(v.id);
      expect([flag(argv, "--model"), flag(argv, "--effort")]).toEqual(["opus", "high"]); // 岗位是轻档，无上限改用重档
      expect(JSON.parse(flag(argv, "--settings")!).ultracode).toBeUndefined();
      // 自动（没带预算）：同样第 2 次没过就受阻
      const b = await h.open(h.card("B"));
      await h.allow(b.id);
      await h.waitStatus(b.id, "idle");
      await h.handBack(b.id);
      const vb = await until(async () => (await h.verifies()).find((x) => x.subject.cardId === "B"));
      await h.waitStatus(vb.id, "done");
      expect(h.events(b.id).find((e) => e.type === "verdict")).toMatchObject({ passed: false, failStreak: 2, blocked: true });
      expect(flag(h.argvOf(vb.id), "--model")).toBe("haiku");
    } finally {
      await h.t.cleanup();
    }
  });

  it("要本人补（主循环第 61 条）：有一条要本人补就是等本人补，不计连续没过、不受阻、不给改法；没写 fixBy 的按执行方补", async () => {
    const h = await setup(3);
    try {
      // 已经连续没过 1 次：这次要是算没过就是受阻
      h.cloud.setBrief(() => ({ status: 200, body: { markdown: "# 验收交代", criteria: CRITERIA, role: REVIEWER, failStreak: 1 } }));
      h.fake({ verdict: {
        summary: "能登录了，截图要你登录后台截一张",
        criteria: [{ index: 1, verdict: "unmet", reason: "少一个按钮", fix: "补上按钮" }, { index: 2, verdict: "needs_person", reason: "后台要本人登录", fix: "登录后台截一张图贴回来", fixBy: "worker" }],
      } });
      const a = await h.open(h.card("A"));
      await h.allow(a.id);
      await h.waitStatus(a.id, "idle");
      await h.mcp(a.id, "hand_back", { summary: "做完了", criteria: [{ index: 1, result: "met", evidence: "hello.txt" }, { index: 2, result: "needs_person", evidence: "后台要登录", need: "登录后台截一张图贴回来" }] });
      const v = await until(async () => (await h.verifies())[0]);
      await h.waitStatus(v.id, "done");
      const ev = h.events(a.id).find((e) => e.type === "verdict");
      expect(ev).toMatchObject({ passed: false, needsPerson: true, failStreak: 1, blocked: false, returnText: null, summary: "能登录了，截图要你登录后台截一张" });
      expect(ev.criteria.map((c: any) => [c.verdict, c.fixBy])).toEqual([["unmet", "worker"], ["needs_person", "person"]]);
      const synced = await until(() => h.cloud.items.find((i) => i.type === "verdict"));
      expect(synced.data.criteria.map((c: any) => c.fixBy)).toEqual(["worker", "person"]);
      // 达到的不带 fixBy
      h.fake({ verdict: PASSING });
      const b = await h.open(h.card("B"));
      await h.allow(b.id);
      await h.waitStatus(b.id, "idle");
      await h.handBack(b.id);
      const vb = await until(async () => (await h.verifies()).find((x) => x.subject.cardId === "B"));
      await h.waitStatus(vb.id, "done");
      const pass = h.events(b.id).find((e) => e.type === "verdict");
      expect(pass.needsPerson).toBeUndefined();
      expect(pass.criteria.every((c: any) => !("fixBy" in c))).toBe(true);
    } finally {
      await h.t.cleanup();
    }
  });

  it("卡的约定（主循环第 60 条）：开工记下第几版；云端改了交回就退回、带上新标准；转话带了版本号就不再退；取不到不挡；执行方提议改约定报给云端", async () => {
    const h = await setup(3);
    try {
      const v1 = { revision: 1, brief: "做 A", standards: CRITERIA };
      let current: { revision: number; brief: string | null; standards: string[] } | "offline" = v1;
      h.cloud.setAgreement((id) => (id === "A" ? current : null));
      const a = await h.open(h.card("A"));
      await until(() => h.cloud.agreementAsked.includes("A")); // 开工时取一次
      await until(() => JSON.parse(readFileSync(join(h.t.dataDir, "sessions", a.id, "session.json"), "utf8")).agreementRevision === 1);
      expect((await h.session(a.id)).session.agreementRevision).toBeUndefined(); // 只记在本机，不进摘要

      // 本人在网页上改了完成标准（第 2 版），执行方没收到转话：交回退回，新标准原样告诉它，不报给云端
      current = { revision: 2, brief: null, standards: ["页面能登录", "近似商标由本人查"] };
      const back = await h.handBack(a.id);
      expect(back.isError).toBe(true);
      expect(back.content[0]!.text).toContain("现在是第 2 版");
      expect(back.content[0]!.text).toContain("1. 页面能登录\n2. 近似商标由本人查");
      expect(h.events(a.id).some((e) => e.type === "notice" && e.code === "agreement_changed")).toBe(true);
      expect(h.cloud.items.some((i) => i.type === "handback")).toBe(false);
      // 再交就照常（记成第 2 版了）
      expect((await h.handBack(a.id)).isError).toBe(false);

      // 云端登记的转话带了版本号（第 3 版）：网页说给执行方时带上，交回时不再退
      current = { revision: 3, brief: "做 A，商标不查", standards: ["页面能登录"] };
      expect((await h.call("POST", `/v1/sessions/${a.id}/messages`, { text: "约定改了：只要页面能登录", agreementRevision: 3 })).status).toBe(200);
      expect((await h.handBack(a.id)).isError).toBe(false);
      // 取不到（离线）不挡交回
      current = "offline";
      expect((await h.handBack(a.id)).isError).toBe(false);
      await until(() => h.cloud.items.filter((i) => i.type === "handback").length === 3);

      // 执行方提议改约定：不直接生效，事件和同步条目同一个 key
      const reason = "商标网拦自动访问";
      const tooLong = await h.mcp(a.id, "propose_agreement_change", { standards: ["页面能登录", "查".repeat(301)], reason });
      expect(tooLong.content[0]!.text).toContain("完成标准第 2 条有 301 字，每条不能超过 300 字");
      expect((await h.mcp(a.id, "propose_agreement_change", { standards: [], reason })).isError).toBe(true);
      const ok = await h.mcp(a.id, "propose_agreement_change", { standards: ["页面能登录", "近似商标由本人查"], reason });
      expect(ok.content[0]!.text).toContain("已经提给本人");
      const item = await until(() => h.cloud.items.find((i) => i.type === "agreement_proposal"));
      expect(item.data).toEqual({ standards: ["页面能登录", "近似商标由本人查"], reason });
      expect(item.subject).toMatchObject({ kind: "card", cardId: "A" });
      expect(h.events(a.id).find((e) => e.type === "agreement_proposal")).toMatchObject({ proposalKey: item.key, standards: ["页面能登录", "近似商标由本人查"], reason });
      expect(readFileSync(join(h.t.dataDir, "sessions", a.id, "system.md"), "utf8")).toContain("propose_agreement_change");
    } finally {
      await h.t.cleanup();
    }
  });

  it("卡的约定（主循环第 60 条）：离线开工、没取到版本号的，交回时和开工交代里的约定比内容，没改不退、改了退回", async () => {
    const h = await setup(3);
    try {
      let online = false;
      const same = { revision: 4, brief: "按设计稿改登录页", standards: CRITERIA };
      h.cloud.setAgreement((id) => (!online ? "offline" : id === "A" ? same : { ...same, standards: ["页面能登录", "有截图，标出按钮"] }));
      const md = (title: string) => [`# 执行事项：${title}`, "", "## 交代", "", "按设计稿改登录页", "", "## 完成标准（交回时逐条写证据）", "", "1. 页面能登录", "2. 有截图", "", "## 这次不包括", "", "- 注册页"].join("\n");
      const a = await h.open({ ...h.card("A"), firstMessage: md("A") });
      const b = await h.open({ ...h.card("B"), firstMessage: md("B") });
      await until(() => ["A", "B"].every((id) => h.cloud.agreementAsked.includes(id))); // 开工时取过，离线没取到
      online = true;
      // A：云端和开工交代一样（版本号是 4 也不退）
      expect((await h.handBack(a.id)).isError).toBe(false);
      // B：云端改了一条：退回，列出新标准
      const back = await h.handBack(b.id);
      expect(back.isError).toBe(true);
      expect(back.content[0]!.text).toContain("1. 页面能登录\n2. 有截图，标出按钮");
      expect((await h.handBack(b.id)).isError).toBe(false); // 记成第 4 版了，再交照常
    } finally {
      await h.t.cleanup();
    }
  });

  it("批准说人话（主循环第 64 条）：Bash 入参里的说明和会动的文件进批准请求，也进报给云端的「在等批准哪一步」", async () => {
    const h = await setup(3);
    try {
      h.fake({ bash: { command: "rm -rf out/build", description: "清掉旧的构建产物" } });
      const a = await h.open(h.card("A"));
      const s = await until(async () => { const x = await h.session(a.id); return x.pendingPermissions[0] ? x : null; });
      expect(s.pendingPermissions[0]).toMatchObject({ toolName: "Bash", description: "清掉旧的构建产物", paths: ["out/build"] });
      const status = await until(() => h.cloud.items.find((i) => i.type === "status" && i.sessionId === a.id && i.data.permission));
      expect(status.data.permission).toMatchObject({ toolName: "Bash", description: "清掉旧的构建产物", paths: ["out/build"] });
    } finally {
      await h.t.cleanup();
    }
  });

  it("本人原话（16.8）：带原话的验收交代能通过校验、原样作第一句话（本机不再拼一遍）；标准全过但漏了原话里明说的，判没过、写明是哪句；quote 要是原话；规划员的派活单带原话片段", async () => {
    const h = await setup(3);
    try {
      const WORDS = ["登录页要有忘记密码", "别动注册页"];
      // 云端：交代的 markdown 里已经有「本人原话」，sourceWords 另给一份（16.8）
      const MD = "## 本人原话\n\n> 登录页要有忘记密码\n\n> 别动注册页\n\n# 验收交代";
      let words: string[] | undefined = WORDS;
      h.cloud.setBrief(() => ({ status: 200, body: { markdown: MD, criteria: CRITERIA, role: REVIEWER, failStreak: 0, ...(words ? { sourceWords: words } : {}) } }));
      const missed = { ...PASSING, sourceWordIssues: [{ quote: "登录页要有忘记密码", kind: "missing", reason: "页面上没有忘记密码" }] };
      h.fake({ verdict: missed });
      const a = await h.open(h.card("A"));
      await h.allow(a.id);
      await h.waitStatus(a.id, "idle");
      expect(h.events(a.id).find((e) => e.type === "user_message").text).toBe("做 A"); // 开工交代里的原话云端放好了，本机不加

      await h.handBack(a.id);
      const v = await until(async () => (await h.verifies())[0]);
      await h.waitStatus(v.id, "done");
      expect(h.events(v.id).find((e) => e.type === "user_message").text).toBe(MD); // 带着 sourceWords 的交代过了校验，markdown 原样，不重复
      // 两条标准都 met，漏了原话里明说的：没过，改法里写明是哪句
      const verdict = h.events(a.id).find((e) => e.type === "verdict");
      expect(verdict).toMatchObject({ passed: false, failStreak: 1 });
      expect(verdict.returnText).toBe("验收没过：本人原话「登录页要有忘记密码」漏了：页面上没有忘记密码。改完再交回。");
      expect((await until(() => h.cloud.items.find((i) => i.type === "verdict"))).data).toMatchObject({ passed: false, sourceWordIssues: missed.sourceWordIssues });

      // quote 不是原话里的话：退回去重交；对得上就不写，照常过
      h.fake({});
      const b = await h.open(h.card("B"));
      await h.allow(b.id);
      await h.waitStatus(b.id, "idle");
      await h.handBack(b.id);
      const vb = await until(async () => (await h.verifies()).find((x) => x.subject.cardId === "B"));
      await until(async () => h.events(vb.id).some((e) => e.type === "user_message"));
      const bad = await h.mcp(vb.id, "submit_verdict", { ...PASSING, sourceWordIssues: [{ quote: "要有记住我", kind: "missing", reason: "x" }] });
      expect(bad.isError).toBe(true);
      expect(bad.content[0]!.text).toContain("不是本人原话里的话");
      expect((await h.mcp(vb.id, "submit_verdict", PASSING)).content[0]!.text).toBe("结论已交：过了。");
      // 交代里没有原话时不能写 sourceWordIssues
      words = undefined;
      const c = await h.open(h.card("C"));
      await h.allow(c.id);
      await h.waitStatus(c.id, "idle");
      await h.handBack(c.id);
      const vc = await until(async () => (await h.verifies()).find((x) => x.subject.cardId === "C"));
      await until(async () => h.events(vc.id).some((e) => e.type === "user_message"));
      expect((await h.mcp(vc.id, "submit_verdict", missed)).content[0]!.text).toContain("交代里没有本人原话");

      // 规划员：派活单带原话片段，原样报上去；不填就不带（云端用整条原话）
      const p = await h.open({ subject: { kind: "plan", taskId: "T-sw" }, title: "拆卡", firstMessage: "拆" });
      await h.waitStatus(p.id, "idle");
      await h.clarify(p.id);
      const cards = [{ ...PLAN.cards[0], sourceWords: ["登录页要有忘记密码", " "] }, PLAN.cards[1]];
      expect((await h.mcp(p.id, "propose_plan", { ...PLAN, cards })).content[0]!.text).toContain("已交第 1 次计划");
      const plan = await until(() => h.cloud.items.find((i) => i.type === "card_plan" && i.subject.taskId === "T-sw"));
      expect(plan.data.cards.map((x: any) => x.sourceWords ?? null)).toEqual([["登录页要有忘记密码"], null]);
    } finally {
      await h.t.cleanup();
    }
  });

  it("没过：卡的会话里有结论和改法，经「说一句」送回执行会话，改完再交回自动再验；第二次没过停在受阻；过了没有改法", async () => {
    const h = await setup(3);
    try {
      h.fake({ verdict: FAILING });
      let streak = 0;
      h.cloud.setBrief(() => ({ status: 200, body: { markdown: "# 验收交代", criteria: CRITERIA, role: REVIEWER, failStreak: streak } }));
      const a = await h.open(h.card("A"));
      await h.allow(a.id);
      await h.waitStatus(a.id, "idle");

      await h.handBack(a.id);
      const v1 = await until(async () => (await h.verifies())[0]);
      await h.waitStatus(v1.id, "done");
      const first = h.events(a.id).filter((e) => e.type === "verdict");
      expect(first).toHaveLength(1);
      expect(first[0]).toMatchObject({ passed: false, failStreak: 1, blocked: false });
      expect(first[0].returnText).toBe("验收没过：第 2 条「有截图」，没截图；怎么补：补一张登录后的截图。改完再交回。");
      expect(h.events(v1.id).find((e) => e.type === "verdict")).toEqual({ ...first[0], seq: expect.any(Number), at: expect.any(String), sessionId: v1.id });

      // 网页把改法经「说一句」送回执行会话（这条路原来就有）：执行方接着做、再交回，本机再起一个验收员
      const say = await h.call("POST", `/v1/sessions/${a.id}/messages`, { text: first[0].returnText });
      expect(say.body.delivery).toBe("new_turn");
      await h.allow(a.id);
      await h.waitStatus(a.id, "idle");
      streak = 1;
      await h.handBack(a.id);
      const v2 = await until(async () => (await h.verifies())[1]);
      expect(v2.subject.handbackKey).not.toBe(v1.subject.handbackKey);
      await h.waitStatus(v2.id, "done");
      const second = h.events(a.id).filter((e) => e.type === "verdict")[1];
      expect(second).toMatchObject({ passed: false, failStreak: 2, blocked: true });

      // 本人推翻或改好后又交回：这次过了，没有改法
      h.fake({ verdict: PASSING });
      streak = 0;
      await h.handBack(a.id);
      const v3 = await until(async () => (await h.verifies())[2]);
      await h.waitStatus(v3.id, "done");
      expect(h.events(a.id).filter((e) => e.type === "verdict")[2]).toMatchObject({ passed: true, failStreak: 0, blocked: false, returnText: null });
      // 验完的验收员，本人想问它，说一句会续上
      expect((await h.call("POST", `/v1/sessions/${v3.id}/messages`, { text: "为什么过了" })).body.delivery).toBe("resumed");
    } finally {
      await h.t.cleanup();
    }
  });

  it("取不到交代就排着等：没连天枢、连不上时不开始也不挡别人；连上后自动开始；天枢没有这次交回不验、已有结论不用验；重启后照样排着", async () => {
    const h = await setup(3, { link: false });
    let reuse: NonNullable<Parameters<typeof setup>[1]>["reuse"];
    try {
      h.fake({ verdict: PASSING });
      const a = await h.open(h.card("A"));
      await h.waitStatus(a.id, "waiting_permission");
      await h.handBack(a.id);
      const v1 = await until(async () => (await h.verifies())[0]);
      await until(() => h.events(v1.id).some((e) => e.type === "notice" && e.code === "verify_waiting" && e.text === "本机还没连上天枢，连上后开始验收"));
      // 有空位也不开始，后来的执行照常开
      const b = await h.open(h.card("B"));
      expect(b.status).toBe("running");
      expect(await h.status(v1.id)).toBe("queued");

      // 连上天枢：交回送上去，取到交代，开始验收
      await h.link();
      await h.waitStatus(v1.id, "done");
      // 结论经发件箱送上去（入队后 300 毫秒发），可能比验收员退出晚一点
      expect((await until(() => h.cloud.items.find((i) => i.type === "verdict"))).subject.handbackKey).toBe(v1.subject.handbackKey);

      // 天枢上没有这次交回（404）：不验；这次交回已有结论（409）：不用验
      h.cloud.setBrief(() => ({ status: 404 }));
      await h.handBack(a.id);
      const v2 = await until(async () => (await h.verifies())[1]);
      await h.waitStatus(v2.id, "failed");
      expect(h.events(v2.id).filter((e) => e.type === "status").at(-1).reason).toBe("天枢上没有这次交回（可能被拒收了），没法验收");
      h.cloud.setBrief(() => ({ status: 409 }));
      await h.handBack(a.id);
      const v3 = await until(async () => (await h.verifies())[2]);
      await h.waitStatus(v3.id, "exited");
      expect(h.events(v3.id).filter((e) => e.type === "status").at(-1).reason).toBe("这次交回天枢上已经有结论，不用再验");

      // 连不上天枢：排着，告诉网页在等什么
      h.cloud.setBrief(() => "offline");
      await h.handBack(a.id);
      const v4 = await until(async () => (await h.verifies())[3]);
      await until(() => h.events(v4.id).some((e) => e.type === "notice" && e.code === "verify_waiting" && e.text.startsWith("取验收交代没成")));
      expect(await h.status(v4.id)).toBe("queued");
      expect(h.started()).not.toContain(v2.id);
      expect(h.started()).not.toContain(v3.id);
      reuse = { dataDir: h.t.dataDir, work: h.work, token: h.token, cloud: h.cloud };
    } finally {
      await h.t.runner.close();
    }
    // 重启：还在等交代的验收员照样排着；天枢好了，启动后就取到交代开始验收
    h.cloud.setBrief(() => ({ status: 200, body: { markdown: "# 验收交代", criteria: CRITERIA, role: null, failStreak: 0 } }));
    const h2 = await setup(3, { reuse });
    try {
      const v4 = (await h2.verifies())[3];
      await h2.waitStatus(v4.id, "done");
      expect(h2.started()).toContain(v4.id);
      // 交代里没配验收员岗位：用内置规矩、普通档（Sonnet）
      expect(flag(h2.argvOf(v4.id), "--model")).toBe("sonnet");
    } finally {
      await h2.t.cleanup();
    }
  });

  it("网页不能开验收员；规划员要带 taskId、不给目录时用专用目录；结论要逐条判完、只交一次；一轮没交提醒一次", async () => {
    const h = await setup(3);
    try {
      const bad = await h.open({ subject: { kind: "verify", cardId: "A" }, title: "x", cwd: h.work, firstMessage: "x" });
      expect(bad.error).toMatchObject({ code: "validation" });
      expect((await h.open({ subject: { kind: "plan" }, title: "x", firstMessage: "x" })).error).toMatchObject({ code: "validation" });
      expect((await h.open({ subject: { kind: "card", cardId: "A", handbackKey: "k".repeat(20) }, title: "x", cwd: h.work, firstMessage: "x" })).error).toMatchObject({ code: "validation" });
      const p = await h.open({ subject: { kind: "plan", taskId: "T/2" }, title: "拆卡", firstMessage: "拆" });
      expect(p.cwd).toBe(join(h.t.dataDir, "plans", "T_2"));
      await h.waitStatus(p.id, "idle"); // 专用目录里没有假 claude 的配置：看完就停，没交计划
      // 没绑文件夹：先不收派活单，要它先问本人（设计 18.11）；本人说了一句以后才收
      const ask = await h.mcp(p.id, "propose_plan", PLAN);
      expect([ask.isError, ask.content[0]!.text]).toEqual([true, expect.stringContaining("先不交派活单：这个项目在这台电脑上还没绑文件夹")]);
      await h.clarify(p.id);
      expect((await h.mcp(p.id, "propose_plan", { summary: "x", cards: [] })).content[0]!.text).toContain("计划不合格");
      expect((await h.mcp(p.id, "propose_plan", { ...PLAN, cards: [{ ...PLAN.cards[0], modelTier: "max" }] })).isError).toBe(true);
      // 卡标题照 Claude Code 起会话名的规矩：太长、带括号冒号句号的退回重写（说清是第几件），不截断、这一次不算交了
      const longTitle = { ...PLAN.cards[0], title: "把本机程序的配对流程整个重新做一遍并补上所有测试" };
      const colonTitle = { ...PLAN.cards[1], title: "网页：派活单" };
      const rejected = await h.mcp(p.id, "propose_plan", { ...PLAN, cards: [longTitle, colonTitle] });
      expect(rejected.isError).toBe(true);
      expect(rejected.content[0]!.text).toContain("第 1 件的标题「把本机程序的配对流程整个重新做一遍并补上所有测试」太长");
      expect(rejected.content[0]!.text).toContain("第 2 件的标题「网页：派活单」不要带括号、冒号、句号");
      expect(readFileSync(join(h.t.dataDir, "sessions", p.id, "system.md"), "utf8")).toContain("中文 12 个字以内");
      // 完成标准每条 300 字以内（DONE_DEFINITION_LIMITS，契约写不出这条）：超了退回，说清第几件第几条；整份 2000 字以内
      const longLine = { ...PLAN.cards[1], doneDefinition: `有截图\n${"截".repeat(301)}` };
      const tooLong = await h.mcp(p.id, "propose_plan", { ...PLAN, cards: [PLAN.cards[0], longLine] });
      expect(tooLong.content[0]!.text).toContain("第 2 件的完成标准第 2 条有 301 字，每条不能超过 300 字");
      const tooMuch = await h.mcp(p.id, "propose_plan", { ...PLAN, cards: [{ ...PLAN.cards[0], doneDefinition: Array(8).fill("截".repeat(260)).join("\n") }] });
      expect(tooMuch.content[0]!.text).toContain("第 1 件的完成标准合起来有 2087 字，整份不能超过 2000 字");
      expect((await h.mcp(p.id, "propose_plan", PLAN)).content[0]!.text).toContain("已交第 1 次计划（2 件）");
      expect((await h.mcp(p.id, "propose_plan", PLAN)).content[0]!.text).toContain("已交第 2 次计划");
      expect((await h.mcp(p.id, "submit_verdict", PASSING)).isError).toBe(true); // 规划员没有交结论的工具

      // 验收员第一轮没交结论：本机提醒一次，第二轮交了才收工
      h.fake({ verdict: { ...FAILING, criteria: [FAILING.criteria[0]] }, verdictOnTurn: 2 });
      const a = await h.open(h.card("A"));
      await h.allow(a.id);
      await h.handBack(a.id);
      const v = await until(async () => (await h.verifies())[0]);
      await h.waitStatus(v.id, "idle");
      expect(h.events(v.id).filter((e) => e.type === "notice" && e.code === "verify_nudge")).toHaveLength(1);
      const calls = h.trace().filter((l) => l.readOnlyTurn === v.id);
      expect(calls.map((l) => l.called)).toEqual([null, "submit_verdict"]);
      expect(calls[1].result.content[0].text).toBe("第 2 条还没判（完成标准共 2 条）");
      // 判完整才收；多判、重判都不收；只交一次
      expect((await h.mcp(v.id, "submit_verdict", { ...PASSING, criteria: [...PASSING.criteria, { index: 3, verdict: "met", reason: "x" }] })).content[0]!.text).toBe("没有第 3 条（完成标准共 2 条）");
      expect((await h.mcp(v.id, "submit_verdict", { ...PASSING, criteria: [PASSING.criteria[0], PASSING.criteria[0]] })).content[0]!.text).toContain("第 1 条判了不止一次");
      expect((await h.mcp(v.id, "submit_verdict", PASSING)).content[0]!.text).toBe("结论已交：过了。");
      expect((await h.mcp(v.id, "submit_verdict", PASSING)).content[0]!.text).toContain("已经交过结论了");
      expect((await h.mcp(v.id, "hand_back", { summary: "x", criteria: [] })).isError).toBe(true); // 验收员没有交回的工具
      await until(() => h.cloud.items.filter((i) => i.type === "card_plan").length === 2 && h.cloud.items.some((i) => i.type === "verdict"));
      expect(h.cloud.items.filter((i) => i.type === "card_plan").map((i) => i.data.revision)).toEqual([1, 2]);
      expect(h.cloud.items.filter((i) => i.type === "verdict")).toHaveLength(1);
    } finally {
      await h.t.cleanup();
    }
  });

  it("派活单写等哪几件（只能等前面的）；规矩里写清：要用前面的结果才写 after、报告不留在仓库、验收员指出多出来的文件", async () => {
    const h = await setup(3);
    try {
      const p = await h.open({ subject: { kind: "plan", taskId: "T9" }, title: "拆卡：T9", firstMessage: "拆卡交代", role: PLANNER });
      await h.waitStatus(p.id, "idle");
      await h.clarify(p.id);
      const card = (title: string, after?: number[]) => ({ title, brief: "做", doneDefinition: "能检查", modelTier: "light", ...(after ? { after } : {}) });
      const bad = await h.mcp(p.id, "propose_plan", { summary: "拆三件", cards: [card("甲", [2]), card("乙")] });
      expect(bad.isError).toBe(true);
      expect(bad.content[0]!.text).toContain("第 1 件的 after 只能写排在它前面的件");
      const ok = await h.mcp(p.id, "propose_plan", { summary: "拆三件", cards: [card("甲"), card("乙"), card("总验收", [1, 2])] });
      expect(ok.isError).toBe(false);
      const item = await until(() => h.cloud.items.find((i) => i.type === "card_plan"));
      expect(item.data.cards.map((c: any) => c.after ?? null)).toEqual([null, null, [1, 2]]);
      expect(readFileSync(join(h.t.dataDir, "sessions", p.id, "system.md"), "utf8")).toContain("after 写上它要等的那几件的位置");
      expect(systemPrompt("card", null, [], null)).toContain("不要在仓库里留报告或输出文件");
      expect(systemPrompt("verify", null, [], null)).toContain("完成标准没要求的新增或改动的文件");
    } finally {
      await h.t.cleanup();
    }
  });

  it("规划员的规矩加了拆任务的五条（11/11 本人定，设计 17.2 第 59 条）：原来的一条不少；验收员、执行方的规矩不带", () => {
    const plan = systemPrompt("plan", null, [], null);
    for (const rule of [
      "summary 开头先复述三件事：这件事要达到什么、解决什么问题、最少做到哪一步算完",
      "能自己查到的不问本人", "只把要本人拿主意的事问出来",
      "小事不拆：一个 worker 一次能做完的，就只出一件",
      "最没把握的那件排前面", "别的件要用到的排前面，并在用它的那件的 after 里写上",
      "完成标准每行写成能在真东西上看到的结果，并写清拿什么证明",
      // 证明要执行方自己拿得到；只有本人给得了的写进交代末尾「要本人补：」，免得卡走到第 61 条的等你补（11/11 对比后主会话定）
      "证明要是执行方自己拿得到的（命令输出、文件、测试结果、链接）",
      "只有本人才给得了的（要在本人电脑的某个软件里打开看、要本人登录、要本人亲眼确认）不写进完成标准，写在这件交代的末尾，单独一行「要本人补：……」",
    ]) expect(plan).toContain(rule);
    // 原来的规矩还在
    for (const kept of ["你是规划员：只读", "不要怕问", "一件就是一个 worker 一次能交回的活", "after 写上它要等的那几件的位置", "交完就停"]) expect(plan).toContain(kept);
    for (const kind of ["card", "topic", "verify"] as const) expect(systemPrompt(kind, null, [], null)).not.toContain("小事不拆");
  });

  it("规划员交了计划这一轮做完就收工（done，不停在等你回复）；「改一改」对它说一句：续上原来的对话，改完再交一次，又收工", async () => {
    const h = await setup(3);
    try {
      h.fake({ plan: PLAN });
      const p = await h.open({ subject: { kind: "plan", taskId: "T1" }, title: "拆卡：T1", cwd: h.repo, firstMessage: "拆卡交代", role: PLANNER });
      await h.waitStatus(p.id, "done");
      const statuses = () => h.events(p.id).filter((e) => e.type === "status");
      expect(statuses().map((e) => e.status)).not.toContain("idle");
      expect(statuses().at(-1).reason).toBe("计划交了");
      expect((await h.session(p.id)).session.status).toBe("done");

      // 改一改：说一句，本机续上原来的对话（--resume），它改完再交一次（revision 2），又收工
      const first = statuses().length;
      const say = await h.call("POST", `/v1/sessions/${p.id}/messages`, { text: "改一改：补截图那件并进第一件" });
      expect(say.body.delivery).toBe("resumed");
      await until(() => statuses().length > first + 1 && statuses().at(-1).status === "done");
      expect(statuses().map((e) => e.status).slice(first)).not.toContain("idle");
      expect(h.trace().filter((l) => l.argv?.includes("--resume")).length).toBe(1);
      const plans = await until(() => { const x = h.cloud.items.filter((i) => i.type === "card_plan"); return x.length === 2 ? x : null; });
      expect(plans.map((i) => i.data.revision)).toEqual([1, 2]);
      expect(h.events(p.id).filter((e) => e.type === "user_message").map((e) => e.text)).toEqual(["拆卡交代", "改一改：补截图那件并进第一件"]);
    } finally {
      await h.t.cleanup();
    }
  });
});

describe("规矩和交代（不起进程）", () => {
  it("只改让改的那一处（主循环第 72 条）：卡和专题的规矩里有，规划员、验收员没有", () => {
    expect(EDIT_SCOPE_RULE).toContain("只改那一处");
    expect(EDIT_SCOPE_RULE).toContain("先说，不动手");
    expect(EDIT_SCOPE_RULE).toContain("改了哪几处");
    for (const kind of ["card", "topic"] as const) expect(systemPrompt(kind, null, [], null)).toContain(EDIT_SCOPE_RULE);
    for (const kind of ["plan", "verify"] as const) expect(systemPrompt(kind, null, [], null)).not.toContain(EDIT_SCOPE_RULE);
  });

  it("给本人看的话用中文（3700 卡 R、S、U）：卡、专题、自由子会话、规划员、验收员的规矩里都有；点名过程中的旁白、description 和「其他」", () => {
    expect(CHINESE_RULE).toContain("做事过程中写给本人看的每一句（工具之间的旁白、进度说明）");
    expect(CHINESE_RULE).toContain("description");
    expect(CHINESE_RULE).toContain("写「其他」，不写 Other");
    for (const kind of ["card", "topic", "plan", "verify"] as const) expect(systemPrompt(kind, null, [], null)).toContain(CHINESE_RULE);
    expect(systemPrompt("topic", null, [], null, null, [], [], true)).toContain(CHINESE_RULE);
  });

  it("做到一半本人提了要改约定的新事（3700 卡 R）：卡的规矩写先提、等本人定了再做，不先按旧约定交回", () => {
    const card = systemPrompt("card", null, [], null);
    expect(card).toContain("先提新的完成标准，等本人定了再动手做这件新事；不要先做，也不要先按旧约定交回");
    expect(card).not.toContain("定之前照原来的约定做");
  });

  it("从开工交代里认出约定：云端的交代、网页自己拼的、还没写标准的、认不出的", () => {
    const md = ["# 执行事项：A", "", "## 交代", "", "第一行", "第二行", "", "## 完成标准（交回时逐条写证据）", "", "1. 页面能登录", "2. 有截图", "", "## 这次不包括", "", "- 注册页"].join("\n");
    expect(agreementInBrief(md)).toEqual({ standards: ["页面能登录", "有截图"], brief: "第一行\n第二行" });
    expect(agreementInBrief("# A\n\n完成标准：\n1. 能登录\n2. 有截图")).toEqual({ standards: ["能登录", "有截图"] });
    expect(agreementInBrief("## 交代\n\n（没写交代，按标题和完成标准做）\n\n## 完成标准\n\n（还没写完成标准）")).toEqual({ standards: [], brief: null });
    expect(agreementInBrief("做 A")).toEqual({ standards: null });
  });
});
