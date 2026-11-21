import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { THomePlanTask } from "@warmap/contracts";
import type { DeliverableNoteAgent, DeliverableReviewAgent, ReviewAgentInput, TReviewCandidate } from "../src/deliverableReview.js";
import { hashSecret } from "../src/session.js";
import { createTestApp, TEST_MEMBER } from "./helpers.js";

const PEOPLE_SEED = fileURLToPath(new URL("./fixtures/company-people-candidate.json", import.meta.url));
const THIRD = { personId: "person-fixture-003", loginId: "ceshib", passcode: "3579" } as const;
const NOW = new Date("2026-10-22T02:00:00.000Z");

const TASKS: THomePlanTask[] = [
  { taskId: "task-open", missionId: "mine", name: "对话质量达标", doneDefinition: "对话质量过 75 分", criteria: ["有题库打分结果", "有新人上手录屏"] },
  { taskId: "task-mine", missionId: "mine", name: "我负责的", doneDefinition: null, criteria: ["有方案"], responsibleId: TEST_MEMBER.personId },
  { taskId: "task-theirs", missionId: "mine", name: "别人负责的", doneDefinition: null, criteria: ["有方案"], responsibleId: THIRD.personId },
  { taskId: "task-definition", missionId: "mine", name: "只有完成定义", doneDefinition: "方案定稿", criteria: [] },
  { taskId: "task-bare", missionId: "mine", name: "什么都没写", doneDefinition: null, criteria: [] },
  { taskId: "task-other", missionId: "other", name: "别人 Mission 的", doneDefinition: null, criteria: ["有方案"] },
];

/** 判定：标准文字里的关键词出现在材料或那句话里算达到，否则部分达到。 */
function judge(input: ReviewAgentInput): TReviewCandidate {
  const corpus = [input.version.statement ?? "", ...input.version.items.map((item) => `${item.name} ${item.text ?? ""}`)].join("\n");
  const criteria = input.criteria.map(({ index, text }) => {
    const met = corpus.includes(text.slice(1, 3)) || input.dissent?.index === index && input.dissent.reason.includes("见附件");
    return met ? { index, verdict: "met" as const, reason: "材料里有", evidence: "方案.md 第 1 段", fix: null }
      : { index, verdict: "partial" as const, reason: "只有陈述", evidence: null, fix: `补上「${text}」的材料` };
  }).filter((item) => !input.dissent || item.index === input.dissent.index);
  const met = criteria.filter((item) => item.verdict === "met").length;
  return { headline: met === criteria.length ? `${met} 条都达到了` : "还差几条", summary: "按材料逐条看过", gain: input.previous ? "多达到了一条" : null, criteria };
}

async function fixture() {
  const storage = await mkdtemp(join(tmpdir(), "deliverables-"));
  const reviews: { input: ReviewAgentInput; images: { mimeType: string; data: string }[] }[] = [];
  const notes: unknown[] = [];
  const links: string[] = [];
  let now = NOW;
  let reviewImpl: DeliverableReviewAgent["review"] = async (input, { onProgress }) => { onProgress?.(input.criteria.length, true); return judge(input); };
  const review: DeliverableReviewAgent = { review: (input, options) => { reviews.push({ input, images: options.images }); return reviewImpl(input, options); } };
  const note: DeliverableNoteAgent = { async write(input) { notes.push(input); return { achieved: "v1 达成了：方案定稿", gain: "两条都有材料", why: null, lesson: "先拿题库打分" }; } };
  const t = await createTestApp({ companyPeopleSeed: PEOPLE_SEED, materialStorageDir: storage }, undefined, {
    monthlyNow: () => now,
    planTasks: async (missions) => TASKS.filter((task) => missions.some((mission) => mission.id === task.missionId)),
    deliverableAgents: { review, note },
    deliverableFetcher: async (url) => { links.push(url); return url.includes("broken") ? null : { text: `网页正文：有题库打分结果，来自 ${url}`, images: [] }; },
  });
  const mission = (id: string, owner: string) => t.sql(`INSERT INTO missions(id,version,code,period,title,owner_id,capability_id,battlefield_ids,outcome,milestones,
    source_ref,source_document_id,source_revision,source_title) VALUES($1,1,$1,'2026-10',$1,$2,'method','["growth"]','目标','[]','fixture://d','fixture',1,'fixture')`, [id, owner]);
  await mission("mine", TEST_MEMBER.personId);
  await mission("other", THIRD.personId);
  await t.sql("INSERT INTO member_access (person_id, login_id, passcode_hash, must_change) VALUES ($1, $2, $3, FALSE)", [THIRD.personId, THIRD.loginId, hashSecret(THIRD.passcode)]);
  const member = await t.memberCookie();
  const call = (method: "GET" | "POST" | "PATCH", url: string, payload?: unknown, cookie = member) =>
    t.app.inject({ method, url, headers: { cookie, origin: t.publicOrigin }, ...(payload === undefined ? {} : { payload: payload as Record<string, unknown> }) });
  /** 传一个版本：files 是 [文件名, 内容]，其余字段照 multipart 写。 */
  const upload = (taskId: string, parts: { files?: [string, Buffer | string][]; links?: string[]; statement?: string; keep?: string[] }, cookie = member) => {
    const boundary = "----deliverable-test";
    const chunks: Buffer[] = [];
    const field = (name: string, value: string) => chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    if (parts.links) field("links", JSON.stringify(parts.links));
    if (parts.statement !== undefined) field("statement", parts.statement);
    if (parts.keep) field("keep", JSON.stringify(parts.keep));
    for (const [name, content] of parts.files ?? []) {
      chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="files"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`));
      chunks.push(Buffer.isBuffer(content) ? content : Buffer.from(content), Buffer.from("\r\n"));
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return t.app.inject({ method: "POST", url: `/api/plan-tasks/${taskId}/deliverable/versions`, payload: Buffer.concat(chunks),
      headers: { cookie, origin: t.publicOrigin, "content-type": `multipart/form-data; boundary=${boundary}` } });
  };
  const read = async (taskId: string) => { await t.app.deliverables.idle(); const res = await call("GET", `/api/plan-tasks/${taskId}/deliverable`); expect(res.statusCode).toBe(200); return res.json(); };
  const status = async (taskId: string) => (await call("GET", "/api/me/home-plan")).json().tasks.find((task: { taskId: string }) => task.taskId === taskId);
  const third = async () => {
    const login = await t.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: t.publicOrigin }, payload: { loginId: THIRD.loginId, passcode: THIRD.passcode } });
    return (login.headers["set-cookie"] as string).split(";")[0];
  };
  return { t, call, upload, read, status, third, reviews, notes, links, setReview: (impl: typeof reviewImpl) => { reviewImpl = impl; },
    setNow: (value: Date) => { now = value; },
    close: async () => { await t.close(); await rm(storage, { recursive: true, force: true }); } };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;
const passing = (f: Fixture, taskId = "task-open") => f.upload(taskId, { files: [["方案.md", "# 方案\n\n有题库打分结果，也有新人上手录屏。"]], statement: "两条都做了" });

describe("Task 交付物", () => {
  it("传 Markdown、链接和一句话：201，后台评完，读回报告、达标度和能不能交付", async () => {
    const f = await fixture();
    try {
      const created = await f.upload("task-open", { files: [["方案.md", "# 方案\n\n有题库打分结果"]], links: ["https://example.com/a", "https://example.com/a"], statement: "  先交一版  " });
      expect(created.statusCode).toBe(201);
      expect(created.json()).toMatchObject({ number: 1, statement: "先交一版", review: { status: "queued", basis: "acceptance", expectedSeconds: 120 }, deliveredAt: null, note: null });
      expect(created.json().items).toMatchObject([{ kind: "file", name: "方案.md", mimeType: "text/markdown", read: "read" }, { kind: "link", url: "https://example.com/a", read: "pending" }]);
      const body = await f.read("task-open");
      expect(body).toMatchObject({ taskId: "task-open", responsibleId: null, responsibleName: null, canEdit: true, basis: "acceptance", criteria: ["有题库打分结果", "有新人上手录屏"] });
      expect(body.versions[0].review).toMatchObject({ status: "done", phase: null, headline: "还差几条", score: 75, met: 1, total: 2, ready: false, gain: null, error: null });
      expect(body.versions[0].review.criteria).toEqual([
        { index: 1, text: "有题库打分结果", verdict: "met", reason: "材料里有", evidence: "方案.md 第 1 段", fix: null, dissent: null },
        { index: 2, text: "有新人上手录屏", verdict: "partial", reason: "只有陈述", evidence: null, fix: "补上「有新人上手录屏」的材料", dissent: null },
      ]);
      expect(body.versions[0].items[1]).toMatchObject({ read: "read" });
      expect(f.links).toEqual(["https://example.com/a"]);
      expect(f.reviews[0].input).toMatchObject({ task: { name: "对话质量达标", doneDefinition: "对话质量过 75 分" }, version: { statement: "先交一版" }, unreadable: [] });
      expect(f.reviews[0].input.version.items.map((item) => item.kind)).toEqual(["file", "link"]);
      expect(await f.status("task-open")).toMatchObject({ responsibleId: null, deliverable: { status: "iterating", score: 75, version: 1 } });
      const file = await f.call("GET", `/api/plan-tasks/task-open/deliverable/items/${body.versions[0].items[0].id}`);
      expect(file.statusCode).toBe(200);
      expect(file.body).toContain("有题库打分结果");
      expect((await f.call("GET", `/api/plan-tasks/task-open/deliverable/items/${body.versions[0].items[1].id}`)).statusCode).toBe(404);
    } finally { await f.close(); }
  });

  it("读不出文字的 PDF 照样收下、标读不了；飞书链接不去读；打不开的链接标打不开；空版本、错类型、大图片被拦下", async () => {
    const f = await fixture();
    try {
      const created = await f.upload("task-open", { files: [["扫描件.pdf", "%PDF-1.4 不是真的 PDF"]], links: ["https://tokenking.feishu.cn/docx/abc", "https://broken.example.com/x"] });
      expect(created.statusCode).toBe(201);
      expect(created.json().items[0]).toMatchObject({ kind: "file", read: "unreadable", readNote: "这份 PDF 没有文字层，请导出可复制文字的版本" });
      const items = (await f.read("task-open")).versions[0].items;
      expect(items.slice(1)).toMatchObject([{ read: "unreadable", readNote: "飞书文档请导出后上传" }, { read: "unreadable", readNote: "打不开 · 请导出后上传" }]);
      expect(f.links).toEqual(["https://broken.example.com/x"]);
      expect(f.reviews[0].input.unreadable.map((item) => item.note)).toEqual(["这份 PDF 没有文字层，请导出可复制文字的版本", "飞书文档请导出后上传", "打不开 · 请导出后上传"]);
      expect(f.reviews[0].input.version.items).toEqual([]);
      const rejected = async (parts: Parameters<Fixture["upload"]>[1], code: string, message: string) => {
        const res = await f.upload("task-open", parts);
        expect(res.statusCode).toBe(400);
        expect(res.json()).toMatchObject({ code, message });
      };
      await rejected({ statement: "   " }, "EMPTY_VERSION", "这一版还是空的");
      await rejected({ files: [["表.xlsx", "x"]] }, "UNSUPPORTED_DELIVERABLE_TYPE", "支持 PDF、Word、Markdown、HTML 和图片");
      await rejected({ files: [["大图.png", Buffer.alloc(5 * 1024 * 1024 + 1)]] }, "IMAGE_TOO_LARGE", "图片不能超过 5 MB");
      await rejected({ links: ["ftp://example.com"] }, "INVALID_LINK", "链接要以 http:// 或 https:// 开头");
    } finally { await f.close(); }
  });

  it("图片随消息交给评审 Agent；评完标成读过", async () => {
    const f = await fixture();
    try {
      const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
      expect((await f.upload("task-open", { files: [["截图.png", png], ["照片.JPG", Buffer.from("jpg")]] })).statusCode).toBe(201);
      const version = (await f.read("task-open")).versions[0];
      expect(version.items).toMatchObject([{ kind: "image", mimeType: "image/png", read: "read" }, { kind: "image", mimeType: "image/jpeg", read: "read" }]);
      expect(f.reviews[0].images).toEqual([{ type: "image", mimeType: "image/png", data: png.toString("base64") }, { type: "image", mimeType: "image/jpeg", data: Buffer.from("jpg").toString("base64") }]);
      expect(f.reviews[0].input.version.items).toEqual([{ name: "截图.png", kind: "image", text: null }, { name: "照片.JPG", kind: "image", text: null }]);
    } finally { await f.close(); }
  });

  it("本体登记了别人做负责人：能看不能传、不能交付；别人 Mission 下的 Task 找不到", async () => {
    const f = await fixture();
    try {
      const theirs = await f.read("task-theirs");
      expect(theirs).toMatchObject({ responsibleId: THIRD.personId, responsibleName: "测试丙", canEdit: false, versions: [] });
      expect((await f.upload("task-theirs", { statement: "我来交" })).statusCode).toBe(403);
      expect((await f.call("POST", "/api/plan-tasks/task-theirs/deliverable/versions/00000000-0000-4000-8000-000000000000/deliver")).statusCode).toBe(403);
      expect((await f.read("task-mine")).canEdit).toBe(true);
      expect(await f.status("task-theirs")).toMatchObject({ responsibleId: THIRD.personId, deliverable: { status: "none", score: null, version: null } });
      expect((await f.call("GET", "/api/plan-tasks/task-other/deliverable")).statusCode).toBe(404);
      expect((await f.upload("task-other", { statement: "x" })).statusCode).toBe(404);
      expect((await f.call("GET", "/api/plan-tasks/task-other/deliverable", undefined, await f.third())).statusCode).toBe(200);
    } finally { await f.close(); }
  });

  it("交付：参考评审在跑 409；只能交最新一版；交付后写版本说明，可以改、可以不要，撤回清掉说明；首页状态跟着走", async () => {
    const f = await fixture();
    try {
      expect(await f.status("task-open")).toMatchObject({ deliverable: { status: "none", score: null, version: null } });
      let release!: () => void;
      f.setReview(async (input) => { await new Promise<void>((resolve) => { release = resolve; }); return judge(input); });
      const first = (await f.upload("task-open", { statement: "只有一句话" })).json();
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(await f.status("task-open")).toMatchObject({ deliverable: { status: "reviewing", score: null, version: 1 } });
      expect((await f.call("GET", "/api/plan-tasks/task-open/deliverable")).json().versions[0].review).toMatchObject({ status: "running", phase: { step: 2, total: 4, label: "对照第 1 条" } });
      const reviewing = await f.call("POST", `/api/plan-tasks/task-open/deliverable/versions/${first.id}/deliver`);
      expect(reviewing.statusCode).toBe(409);
      expect(reviewing.json()).toMatchObject({ code: "REVIEWING", message: "参考评审还在跑，稍等几秒" });
      release();
      await f.read("task-open");
      expect(await f.status("task-open")).toMatchObject({ deliverable: { status: "iterating", score: 50, version: 1 } });

      f.setReview(async (input) => judge(input));
      const second = (await passing(f)).json();
      const ready = (await f.read("task-open")).versions[0];
      expect(ready).toMatchObject({ number: 2, review: { status: "done", score: 100, ready: true, headline: "2 条都达到了", gain: "多达到了一条" } });
      expect(f.reviews.at(-1)!.input.previous).toEqual([
        { index: 1, text: "有题库打分结果", verdict: "partial", reason: "只有陈述" }, { index: 2, text: "有新人上手录屏", verdict: "partial", reason: "只有陈述" }]);
      expect(await f.status("task-open")).toMatchObject({ deliverable: { status: "ready", score: 100, version: 2 } });
      const older = await f.call("POST", `/api/plan-tasks/task-open/deliverable/versions/${first.id}/deliver`);
      expect(older.statusCode).toBe(409);
      expect(older.json()).toMatchObject({ code: "NOT_LATEST", message: "只能交付最新的一版" });

      const delivered = await f.call("POST", `/api/plan-tasks/task-open/deliverable/versions/${second.id}/deliver`);
      expect(delivered.statusCode).toBe(200);
      expect(delivered.json()).toMatchObject({ deliveredAt: NOW.toISOString(), note: { status: "writing" } });
      const note = (await f.read("task-open")).versions[0].note;
      expect(note).toEqual({ status: "done", achieved: "v1 达成了：方案定稿", gain: "两条都有材料", why: null, lesson: "先拿题库打分", edited: false, dismissed: false });
      expect(f.notes[0]).toMatchObject({ task: { name: "对话质量达标", criteria: ["有题库打分结果", "有新人上手录屏"] }, version: { number: 2, items: ["方案.md"] } });
      expect(await f.status("task-open")).toMatchObject({ deliverable: { status: "delivered", score: 100 } });

      const edited = await f.call("PATCH", `/api/plan-tasks/task-open/deliverable/versions/${second.id}/note`, { why: "换成题库打分", lesson: null });
      expect(edited.statusCode).toBe(200);
      expect(edited.json().note).toMatchObject({ why: "换成题库打分", lesson: null, edited: true, dismissed: false });
      const dismissed = await f.call("PATCH", `/api/plan-tasks/task-open/deliverable/versions/${second.id}/note`, { dismissed: true });
      expect(dismissed.json().note).toMatchObject({ why: "换成题库打分", edited: true, dismissed: true });

      const withdrawn = await f.call("POST", `/api/plan-tasks/task-open/deliverable/versions/${second.id}/withdraw`);
      expect(withdrawn.json()).toMatchObject({ deliveredAt: null, note: null });
      expect(await f.status("task-open")).toMatchObject({ deliverable: { status: "ready", score: 100 } });
      expect((await f.call("PATCH", `/api/plan-tasks/task-open/deliverable/versions/${second.id}/note`, { dismissed: true })).statusCode).toBe(409);
      expect((await f.call("POST", `/api/plan-tasks/task-open/deliverable/versions/${second.id}/withdraw`)).statusCode).toBe(409);
    } finally { await f.close(); }
  });

  it("评审只作参考：没都达到、评审没评完，都能交付；首页写已交付", async () => {
    const f = await fixture();
    try {
      const partial = (await f.upload("task-open", { statement: "只有一句话" })).json();
      expect((await f.read("task-open")).versions[0].review).toMatchObject({ status: "done", met: 0, total: 2, ready: false });
      const delivered = await f.call("POST", `/api/plan-tasks/task-open/deliverable/versions/${partial.id}/deliver`);
      expect(delivered.statusCode).toBe(200);
      expect(delivered.json()).toMatchObject({ deliveredAt: NOW.toISOString(), note: { status: "writing" } });
      expect(await f.status("task-open")).toMatchObject({ deliverable: { status: "delivered", version: 1 } });

      f.setReview(async () => { throw new Error("模型挂了"); });
      const failed = (await f.upload("task-mine", { statement: "方案在这" })).json();
      expect((await f.read("task-mine")).versions[0].review).toMatchObject({ status: "failed" });
      expect((await f.call("POST", `/api/plan-tasks/task-mine/deliverable/versions/${failed.id}/deliver`)).statusCode).toBe(200);
      expect((await f.read("task-mine")).versions[0].note).toMatchObject({ status: "done" });
    } finally { await f.close(); }
  });

  it("材料像是别的 Task 的：评审拿到本人这个月别的 Task 名字，对不上的那句话存进报告", async () => {
    const f = await fixture();
    try {
      f.setReview(async (input) => ({ ...judge(input), mismatch: "这份材料像是「我负责的」的交付物" }));
      await f.upload("task-open", { statement: "招聘流程初稿" });
      expect((await f.read("task-open")).versions[0].review).toMatchObject({ status: "done", mismatch: "这份材料像是「我负责的」的交付物" });
      expect(f.reviews[0].input.otherTasks).toEqual(["我负责的", "别人负责的", "只有完成定义", "什么都没写"]);
    } finally { await f.close(); }
  });

  it("不同意某一条：带着理由只重评那一条，改判记下 upheld；达到的那条不能再提异议", async () => {
    const f = await fixture();
    try {
      const version = (await f.upload("task-open", { files: [["方案.md", "有题库打分结果"]] })).json();
      await f.read("task-open");
      const url = (index: number) => `/api/plan-tasks/task-open/deliverable/versions/${version.id}/criteria/${index}/dissent`;
      expect((await f.call("POST", url(1), { reason: "已经有了" })).statusCode).toBe(409);
      const started = await f.call("POST", url(2), { reason: "录屏见附件第 2 页" });
      expect(started.statusCode).toBe(200);
      expect(started.json().review).toMatchObject({ status: "running", phase: { step: 1, total: 1, label: "重评第 2 条" } });
      expect(started.json().review.criteria[1].dissent).toEqual({ reason: "录屏见附件第 2 页", upheld: null });
      const after = (await f.read("task-open")).versions[0].review;
      expect(f.reviews.at(-1)!.input).toMatchObject({ dissent: { index: 2, reason: "录屏见附件第 2 页" } });
      expect(f.reviews.at(-1)!.input.current).toHaveLength(2);
      expect(after).toMatchObject({ status: "done", ready: true, score: 100, headline: "1 条都达到了" });
      expect(after.criteria[0]).toMatchObject({ verdict: "met", dissent: null });
      expect(after.criteria[1]).toMatchObject({ verdict: "met", dissent: { reason: "录屏见附件第 2 页", upheld: true } });
    } finally { await f.close(); }
  });

  it("不同意以后重评：用时从点「我不同意」那一刻算，不接着第一次评审（PR #80 走查）", async () => {
    const f = await fixture();
    try {
      const version = (await f.upload("task-open", { files: [["方案.md", "有题库打分结果"]] })).json();
      const first = (await f.read("task-open")).versions[0].review;
      expect(first).toMatchObject({ status: "done", startedAt: NOW.toISOString(), finishedAt: NOW.toISOString() });
      const later = new Date(NOW.getTime() + 2 * 60 * 60_000);
      f.setNow(later);
      const started = await f.call("POST", `/api/plan-tasks/task-open/deliverable/versions/${version.id}/criteria/2/dissent`, { reason: "录屏见附件第 2 页" });
      expect(started.json().review).toMatchObject({ status: "running", startedAt: later.toISOString(), finishedAt: null });
      expect((await f.read("task-open")).versions[0].review).toMatchObject({ status: "done", startedAt: later.toISOString(), finishedAt: later.toISOString() });
    } finally { await f.close(); }
  });

  it("评审 Agent 出错：评审失败、可以重试；重试评完；沿用上一版的东西（同一份文件）", async () => {
    const f = await fixture();
    try {
      f.setReview(async () => { throw new Error("模型挂了"); });
      const first = (await f.upload("task-open", { files: [["方案.md", "有题库打分结果"], ["截图.png", "png"]], links: ["https://example.com/a"] })).json();
      const failed = (await f.read("task-open")).versions[0].review;
      expect(failed).toMatchObject({ status: "failed", error: "评审没做完，可以重试", score: null, criteria: [] });
      expect(await f.status("task-open")).toMatchObject({ deliverable: { status: "iterating", score: null } });
      f.setReview(async (input) => judge(input));
      expect((await f.call("POST", `/api/plan-tasks/task-open/deliverable/versions/${first.id}/review`)).json().review).toMatchObject({ status: "queued", error: null });
      expect((await f.read("task-open")).versions[0].review).toMatchObject({ status: "done", score: 75 });
      expect((await f.call("POST", `/api/plan-tasks/task-open/deliverable/versions/${first.id}/review`)).statusCode).toBe(409);

      const items = (await f.read("task-open")).versions[0].items as { id: string; name: string }[];
      const second = await f.upload("task-open", { keep: [items[0].id, items[2].id], statement: "录屏补上了" });
      expect(second.statusCode).toBe(201);
      expect(second.json().items.map((item: { name: string }) => item.name)).toEqual(["方案.md", "https://example.com/a"]);
      const keptId = second.json().items[0].id;
      expect(keptId).not.toBe(items[0].id);
      expect((await f.call("GET", `/api/plan-tasks/task-open/deliverable/items/${keptId}`)).body).toBe("有题库打分结果");
      const stale = await f.upload("task-open", { keep: [items[1].id] });
      expect(stale.statusCode).toBe(400);
      expect(stale.json()).toMatchObject({ code: "INVALID_KEEP" });
    } finally { await f.close(); }
  });

  it("没有验收标准时按完成定义评一条；两样都没有不评，评审直接完成、不收交付", async () => {
    const f = await fixture();
    try {
      expect((await f.read("task-definition"))).toMatchObject({ basis: "definition", criteria: ["方案定稿"] });
      const bare = await f.upload("task-bare", { statement: "做完了" });
      expect(bare.statusCode).toBe(201);
      const body = await f.read("task-bare");
      expect(body).toMatchObject({ basis: "none", criteria: [] });
      expect(body.versions[0].review).toMatchObject({ status: "done", basis: "none", headline: null, mismatch: null, score: null, met: 0, total: 0, ready: false });
      expect(f.reviews).toHaveLength(0);
      expect((await f.call("POST", `/api/plan-tasks/task-bare/deliverable/versions/${body.versions[0].id}/deliver`)).json()).toMatchObject({ code: "NO_CRITERIA" });
    } finally { await f.close(); }
  });
});
