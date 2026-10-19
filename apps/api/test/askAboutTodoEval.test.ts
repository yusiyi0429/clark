import { randomUUID } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TConversationCard } from "@warmap/contracts";
import { createConversationEntries } from "../src/conversationEntries.js";
import type { RequestAgent } from "../src/delivery/requestAgent.js";
import { createTestApp, type TestApp } from "./helpers.js";

/**
 * 「帮我问问」评测集（H11 的雏形）：本人手上有 9 件别人发来的待办，30 句说法覆盖相对时间（含「上周五」两种理解）、昵称、语音错字、
 * 两个候选、找不到、已有人问过。每句走完整的工具流程（定位 → 查有没有人问过 → 整理问题），看最后交给本人的是哪张卡。
 * 硬指标：发错人 = 0（定位到一件、但发起人不是本人说的那位）。「查有没有人问过」用确定性替身（问题和已答问题有相同的词就算问过），
 * 真实模型的这一步另做冒烟。现在是 2026-10-18（周日）北京时间 10:00。
 */
const NOW = new Date("2026-10-18T02:00:00Z");
const VIEWER = "sun-mingze";
const PEOPLE: [string, string][] = [["liu-minghua", "刘明华"], ["bai-tiantian", "白田田"], ["liu-renhao", "刘人豪"], ["sun-mingze", "孙铭泽"], ["chen-xinan", "陈溪南"],
  ["wang-chuangfeng", "王创峰"], ["qin-mengyi", "秦梦怡"], ["tang-jujie", "唐巨杰"], ["yu-siyi", "于斯一"]];

/** 本人手上的待办：key → [发起人, 标题, 北京时间, 说明]。王创峰、白田田没给本人发过。 */
const TODOS: Record<string, [string, string, string, string]> = {
  form: ["tang-jujie", "填备案信息表", "2026-10-17T16:20", "财务在收集备案信息，请在备案信息表里填产品介绍和产品截图。"],
  contract: ["tang-jujie", "补合同扫描件", "2026-10-13T11:00", "法务要归档，请补齐合同扫描件。"],
  deck: ["tang-jujie", "改路演 PPT", "2026-10-09T17:00", "下周路演用的 PPT 请按新数据改一版。"],
  weekly: ["liu-renhao", "更新周报数据表", "2026-10-17T09:30", "周报数据表里本周的数据请更新。"],
  purchase: ["qin-mengyi", "确认采购清单", "2026-10-15T14:00", "采购清单在共享表格里，请确认数量。"],
  interview: ["yu-siyi", "整理客户访谈记录", "2026-10-16T18:00", "把上周三场客户访谈整理成记录。"],
  invoice: ["yu-siyi", "提交报销发票", "2026-10-16T10:00", "九月的报销请把发票交上来。"],
  poster: ["chen-xinan", "补充海报文案", "2026-10-08T15:00", "活动海报还差两段文案。"],
  review: ["liu-minghua", "准备复盘材料", "2026-10-17T20:00", "周一复盘会前把材料准备好。"],
};
/** 已有人问过、发起人答过的问题。 */
const ANSWERED: { todo: keyof typeof TODOS; question: string; answer: string }[] = [
  { todo: "purchase", question: "清单里的数量按箱还是按件？", answer: "按件填" },
];

type Expect =
  | { found: "preview" | "answered"; todo: keyof typeof TODOS }
  | { found: "choose"; todos: (keyof typeof TODOS)[] }
  | { found: "none" };
/** now 不写就是周日（NOW）。 */
type Case = { say: string; tags: string[]; hints?: { person?: string; about?: string }; now?: Date; expect: Expect };
const MONDAY = new Date("2026-10-19T02:00:00Z");

const CASES: Case[] = [
  { say: "昨天巨杰拜托我填的那个表，截图要直接贴进表格还是贴链接，你帮我问问", tags: ["相对时间"], expect: { found: "preview", todo: "form" } },
  { say: "昨天居杰让我填的表，截图怎么放，帮我问问", tags: ["语音错字", "相对时间"], expect: { found: "preview", todo: "form" } },
  { say: "昨天聚洁发的备案表帮我问问截图放哪", tags: ["语音错字"], expect: { found: "preview", todo: "form" } },
  { say: "杰哥昨天发的那个表格要填到什么时候，帮我问一下", tags: ["昵称"], expect: { found: "preview", todo: "form" } },
  { say: "帮我问问巨杰，昨天那个表截图怎么放", tags: ["相对时间"], expect: { found: "preview", todo: "form" } },
  { say: "老唐周二发的合同扫描件，要原件还是复印件，帮我问问", tags: ["昵称", "相对时间"], expect: { found: "preview", todo: "contract" } },
  { say: "唐总让我补的合同，问问他要扫几页", tags: ["昵称"], expect: { found: "preview", todo: "contract" } },
  { say: "人豪昨天那个周报数据表，口径按自然周还是按工作日，帮我问问", tags: ["相对时间"], expect: { found: "preview", todo: "weekly" } },
  { say: "刘人好昨天发的周报表帮我问问口径", tags: ["语音错字"], expect: { found: "preview", todo: "weekly" } },
  { say: "老刘昨天发的那个表帮我问问", tags: ["昵称", "相对时间"], expect: { found: "preview", todo: "weekly" } },
  { say: "明华昨晚发的复盘材料，要不要带数据，帮我问问", tags: ["相对时间"], expect: { found: "preview", todo: "review" } },
  { say: "梦怡周四发的采购清单，数量按箱还是按件，帮我问问", tags: ["已有人问过", "相对时间"], expect: { found: "answered", todo: "purchase" } },
  { say: "秦梦一那个采购清单数量单位是啥，帮我问问", tags: ["已有人问过", "语音错字"], expect: { found: "answered", todo: "purchase" } },
  { say: "三天前梦怡发的清单，数量按箱填还是按件填", tags: ["已有人问过", "相对时间"], expect: { found: "answered", todo: "purchase" } },
  { say: "斯一前天发的东西，帮我问问截止时间", tags: ["两个候选", "相对时间"], expect: { found: "choose", todos: ["interview", "invoice"] } },
  { say: "斯一前天发的报销发票要纸质的吗，帮我问问", tags: ["相对时间"], expect: { found: "preview", todo: "invoice" } },
  { say: "思义周五让我整理的访谈记录，要不要附录音，帮我问问", tags: ["语音错字", "相对时间"], expect: { found: "preview", todo: "interview" } },
  { say: "昨天那个表你帮我问问", tags: ["两个候选", "相对时间"], expect: { found: "choose", todos: ["form", "weekly"] } },
  { say: "财务那个表昨天发的，帮我问问截图要几张", tags: ["两个候选"], expect: { found: "choose", todos: ["form", "weekly"] } },
  { say: "上周溪南发的海报文案，尺寸多大，帮我问问", tags: ["相对时间"], expect: { found: "preview", todo: "poster" } },
  { say: "昨天王创峰发的表帮我问问", tags: ["找不到"], expect: { found: "none" } },
  { say: "小王昨天让我填的表，帮我问问格式", tags: ["找不到", "昵称"], expect: { found: "none" } },
  { say: "溪南前天发的海报文案帮我问问", tags: ["找不到", "相对时间"], expect: { found: "none" } },
  { say: "巨杰10月1号发的那个表帮我问问", tags: ["找不到", "相对时间"], expect: { found: "none" } },
  // 「上周五」两种理解（日历周往前一周的周五 / 最近的周五）：只有一种找得到就定位，两种都找得到就让选。
  { say: "溪南上周五发的海报文案，尺寸多大，帮我问问", tags: ["上周X", "周日"], expect: { found: "preview", todo: "poster" } },
  { say: "斯一上周五让我整理的访谈记录，要不要附录音，帮我问问", tags: ["上周X", "周日"], expect: { found: "preview", todo: "interview" } },
  { say: "巨杰上周五发的东西，帮我问问截止时间", tags: ["上周X", "周日", "两个候选"], expect: { found: "choose", todos: ["deck", "form"] } },
  { say: "斯一上周五发的报销发票要纸质的吗，帮我问问", tags: ["上周X", "周一"], now: MONDAY, expect: { found: "preview", todo: "invoice" } },
  { say: "溪南上周五发的海报文案，帮我问问尺寸", tags: ["上周X", "周一", "找不到"], now: MONDAY, expect: { found: "none" } },
  { say: "对，就是那个，帮我问问截图怎么放", tags: ["追问"], hints: { person: "巨杰", about: "备案信息表" }, expect: { found: "preview", todo: "form" } },
];

const FILLER = new Set([..."我你他的了吗呢吧那这个帮问下一还是要按"]);
const bigrams = (text: string) => { const chars = [...text]; return chars.slice(1).map((char, index) => chars[index] + char).filter((pair) => !FILLER.has(pair[0]) || !FILLER.has(pair[1])); };
/** 「查有没有人问过」的确定性替身：问题和已答问题有相同的两字词就算问过；整理问题原样带上标题。 */
const agent: RequestAgent = {
  async draft() { throw new Error("评测不起草请求"); },
  async lookup(input) {
    const hit = input.answered.find((item) => bigrams(input.question).some((pair) => item.question.includes(pair)));
    return { match: hit ? "question" : "none", quote: null, questionId: hit?.questionId ?? null, question: `${input.title}：${input.question}` };
  },
  async answer() { throw new Error("评测不起草回答"); },
};

let t: TestApp;
let dir: string;
const ids = new Map<string, string>();
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "ask-eval-"));
  const seed = join(dir, "people.json");
  await writeFile(seed, JSON.stringify({ schemaVersion: "company-people.v1",
    people: PEOPLE.map(([personId, displayName]) => ({ personId, displayName, roles: personId === "liu-minghua" ? ["ceo"] : ["dri", "participant"] })) }));
  t = await createTestApp({ companyPeopleSeed: seed });
  for (const [key, [initiator, title, at, body]] of Object.entries(TODOS)) {
    const id = randomUUID();
    ids.set(key, id);
    await t.sql(`INSERT INTO requests (id, kind, initiator_id, prompt, title, body, status, created_at, sent_at) VALUES ($1, 'relay', $2, $3, $3, $4, 'open', $5, $5)`,
      [id, initiator, title, body, new Date(`${at}:00+08:00`)]);
    await t.sql("INSERT INTO request_recipients (request_id, person_id) VALUES ($1, $2)", [id, VIEWER]);
  }
  for (const item of ANSWERED) {
    await t.sql(`INSERT INTO request_questions (id, request_id, asker_id, question, answer, answered_at, fingerprint) VALUES ($1, $2, 'bai-tiantian', $3, $4, now(), $5)`,
      [randomUUID(), ids.get(item.todo), item.question, item.answer, randomUUID()]);
  }
}, 60_000);
afterAll(async () => { await t?.close(); await rm(dir, { recursive: true, force: true }); });

async function ask(item: Case) {
  const cards: TConversationCard[] = [];
  const entries = createConversationEntries({
    pool: t.pool, agent, secret: "eval", viewer: { personId: VIEWER, role: "member" }, message: item.say,
    names: new Map(PEOPLE), people: PEOPLE.map(([personId, displayName]) => ({ personId, displayName })),
    directory: PEOPLE.map(([personId, displayName]) => ({ personId, displayName })), now: () => item.now ?? NOW, fingerprint: "eval",
    onStep: () => undefined, onCard: (card) => cards.push(card),
  });
  const result = await entries.askAboutTodo({ question: item.say, ...item.hints });
  return { found: result.found as string, cards };
}

describe("「帮我问问」评测集", () => {
  it(`${CASES.length} 句全部定位正确，发错人为 0`, async () => {
    expect(CASES.length).toBeGreaterThanOrEqual(20);
    const initiatorOf = (requestId: string) => TODOS[[...ids].find(([, id]) => id === requestId)![0]][0];
    const rows: string[] = [];
    let wrongPerson = 0, correct = 0;
    for (const item of CASES) {
      const { found, cards } = await ask(item);
      const card = cards[0];
      const located = card && (card.kind === "todo_ask" || card.kind === "todo_answer") ? card.requestId : null;
      const expected = item.expect;
      // 发错人：最后要发出（或给出答案）的那一件，发起人不是本人说的那位；该说没有、该让选的却直接定位了，也算。
      if (located && initiatorOf(located) !== ("todo" in expected ? TODOS[expected.todo][0] : null)) wrongPerson += 1;
      const ok = found === expected.found && ("todo" in expected ? located === ids.get(expected.todo)
        : expected.found === "choose" ? card?.kind === "todo_pick" && card.candidates.map((candidate) => candidate.requestId).sort().join() === expected.todos.map((key) => ids.get(key)).sort().join()
        : cards.length === 0);
      if (ok) correct += 1;
      rows.push(`${ok ? "✓" : "✗"} [${item.tags.join("/")}] ${item.say} → ${found}${located ? ` ${TODOS[[...ids].find(([, id]) => id === located)![0]][1]}` : ""}`);
    }
    console.log(`「帮我问问」评测：${correct}/${CASES.length} 正确，发错人 ${wrongPerson}\n${rows.join("\n")}`);
    expect(wrongPerson).toBe(0);
    expect(rows.filter((row) => row.startsWith("✗"))).toEqual([]);
  }, 60_000);
});
