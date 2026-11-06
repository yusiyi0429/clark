// 拆卡和验收改在本机（V2 设计第 21 节）：规划员、验收员两种会话，交回后本机自己起验收员，结论报给云端和卡的会话。
// 假 claude：执行会话每轮要一次写文件的权限；只读会话（--disallowedTools 里有 Write）不来要权限，照会话 MCP 给的工具交计划或结论（内容在 .fake-claude.json）。
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { api, pair, raw, startTestRunner, tempDir, ORIGIN } from "./helpers.js";

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
    return new Response("{}", { status: 404 });
  }) as unknown as typeof fetch;
  return { impl, items, asked, setBrief(fn: typeof brief) { brief = fn; } };
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
  return { t, token, work, cloud, call, link, fake, session, list, status, waitStatus, card, open, allow, mcp, events, trace, started, argvOf, verifies, handBack };
}
const flagList = (argv: string[], name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1]!.split(",") : []);
const flag = (argv: string[], name: string) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);

// 每条要拉起几个假 claude 进程，机器忙时单条要好几秒：显式给 30 秒，不靠 vitest 默认的 5 秒或 package.json 里的参数
describe("规划员和验收员", { timeout: 30_000 }, () => {
  it("排队先后验收员 → 规划员 → 执行；两者只读、各用自己的工具；验收员按岗位档位挑模型、交完结论就收工", async () => {
    const h = await setup(1);
    try {
      h.fake({ verdict: FAILING, plan: PLAN });
      const a = await h.open(h.card("A"));
      await h.waitStatus(a.id, "waiting_permission");
      const b = await h.open(h.card("B"));
      const p = await h.open({ subject: { kind: "plan", taskId: "T1" }, title: "拆卡：T1", cwd: h.work, firstMessage: "拆卡交代", role: PLANNER });
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
      await until(async () => (await h.session(v.id)).session.status === "exited");
      await h.waitStatus(p.id, "idle");
      await h.waitStatus(b.id, "waiting_permission");
      expect(h.started()).toEqual([a.id, v.id, p.id, b.id]);
      expect(h.events(v.id).filter((e) => e.type === "status").at(-1)).toMatchObject({ status: "exited", reason: "验收完了" });

      // 参数：验收员、规划员不给改东西的工具（子 agent 也不给），只给自己的那个工具和读 Task 上下文；验收员用 Haiku，执行用默认的订阅
      const [av, vv, pv] = [h.argvOf(a.id), h.argvOf(v.id), h.argvOf(p.id)];
      for (const argv of [vv, pv]) expect(flagList(argv, "--disallowedTools")).toEqual(expect.arrayContaining(["Edit", "MultiEdit", "Write", "NotebookEdit", "Bash", "PowerShell", "Agent", "Task"]));
      expect(flagList(av, "--disallowedTools")).not.toContain("Write");
      expect(flagList(vv, "--allowedTools")).toEqual(["mcp__tianshu-session__submit_verdict", "mcp__tianshu__get_task_context"]);
      expect(flagList(pv, "--allowedTools")).toEqual(["mcp__tianshu-session__propose_plan", "mcp__tianshu__get_task_context"]);
      expect(flagList(av, "--allowedTools")).toEqual(expect.arrayContaining(["mcp__tianshu-session__hand_back", "mcp__tianshu__get_task_context"]));
      expect([flag(vv, "--model"), flag(av, "--model")]).toEqual(["haiku", null]);
      // 验收员的提示词：验收规矩 + 交代里的验收员岗位
      const vPrompt = readFileSync(flag(vv, "--append-system-prompt-file")!, "utf8");
      expect(vPrompt).toContain("你是验收员：只读");
      expect(vPrompt).toContain("## 你的岗位：验收员");
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
      await h.waitStatus(v1.id, "exited");
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
      await h.waitStatus(v2.id, "exited");
      const second = h.events(a.id).filter((e) => e.type === "verdict")[1];
      expect(second).toMatchObject({ passed: false, failStreak: 2, blocked: true });

      // 本人推翻或改好后又交回：这次过了，没有改法
      h.fake({ verdict: PASSING });
      streak = 0;
      await h.handBack(a.id);
      const v3 = await until(async () => (await h.verifies())[2]);
      await h.waitStatus(v3.id, "exited");
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
      await h.waitStatus(v1.id, "exited");
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
      await h2.waitStatus(v4.id, "exited");
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
      expect((await h.mcp(p.id, "propose_plan", { summary: "x", cards: [] })).content[0]!.text).toContain("计划不合格");
      expect((await h.mcp(p.id, "propose_plan", { ...PLAN, cards: [{ ...PLAN.cards[0], modelTier: "max" }] })).isError).toBe(true);
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
});
