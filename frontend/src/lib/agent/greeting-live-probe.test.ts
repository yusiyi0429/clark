/**
 * **他打一句「你好」，参谋该回什么。默认整条跳过 —— 它会真的调模型、真的花钱。**
 *
 * 打开：`TKOS_GREETING_LIVE=1`。
 *
 * ## 为什么这一条只能真跑
 *
 * 2026-08-31 的事故是：他在分诊那一栏只打了「你好」，回来的是一整屏预研结论加一段反问。
 * 修的是提示词。而提示词改对没改对，罐头一律验不到 —— `system.test.ts` /
 * `instructions.test.ts` 那两份钉的是「这句话写进去了」，钉不了「模型照做了」。
 * 一句写进去了却压不住别的话的规矩，和没写是一样的，而它在测试里看起来完全正常。
 *
 * ## 两份提示词都要跑
 *
 * 这一栏走哪一份由「这条议题手上有没有深研报告」决定（`api/chat/route.ts` 的 `talkGate`）：
 * 有报告走 `TALK_SYSTEM`，没有走 `SYSTEM_INSTRUCTIONS`。分诊那一整页永远是后者。
 * 事故发在后者上，而先修的是前者 —— 所以这里两份一起跑，只跑一份等于把同一个洞留半个。
 *
 * ## 判据
 *
 * 不判「答得好不好」（那要人看）。判两件机器判得了的、而且事故那一次两件都中了的：
 * 回得长、开口就报结论。他打招呼那一轮这两样都不该有。
 *
 * ## 已经跑过的那两轮
 *
 * 2026-08-31 在真模型上跑到第三轮时，账号 403 欠费（方舟的 `AccountOverdueError`）
 * 跑不动了。前两轮的结果记在这里，免得下一个人以为这条从来没验过：
 *
 *   一轮三条全过；另一轮分诊那条回了 83 字「您好。我是您的参谋，现在在 ISS-201
 *   议题页上。…」—— 短、不报结论，只是被上一版那条「不许出现议题编号」的断言拦下，
 *   而那条断言已经撤掉（理由写在 `looksLikeAGreeting` 上）。
 *
 * 事故那一次是 300 字上下的一整屏，两轮都离它很远。但**两个样本还不够说这条稳**：
 * 账号充上之后要再跑几轮，尤其是分诊那一条。
 */

import { beforeAll, describe, expect, it } from "vitest";

import { SYSTEM_INSTRUCTIONS, wrapContext } from "./instructions";
import { buildTalkSystem } from "./talk/system";

const ON = process.env.TKOS_GREETING_LIVE === "1";
const run = ON ? it : it.skip;
const LONG = 3 * 60 * 1000;

let context = "";
let model: { baseUrl: string; apiKey: string; model: string };

const loadEnvLocal = async () => {
  const { readFileSync, existsSync } = await import("node:fs");
  if (!existsSync(".env.local")) return;
  for (const raw of readFileSync(".env.local", "utf8").split(String.fromCharCode(10))) {
    const line = raw.replace(String.fromCharCode(13), "").trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq < 0) continue;
    const k = line.slice(0, eq).trim();
    let v = line.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(k in process.env)) process.env[k] = v;
  }
};

beforeAll(async () => {
  if (!ON) return;
  await loadEnvLocal();
  process.env.TKOS_PERSIST = "0";
  delete process.env.TKOS_MODEL_MOCK;

  const { api } = await import("@/lib/data/store");
  const { resolveModel } = await import("@/lib/models/slots");

  const cfg = resolveModel("pro");
  if (!cfg) throw new Error("没有可用的 pro 槽位模型，这一条跑不了。");
  model = { baseUrl: cfg.baseUrl, apiKey: cfg.apiKey, model: cfg.model };

  /*
   * 上下文取真的那一份 —— 和屏幕上那一栏走的是同一个函数。自己编一段短上下文是没有意义
   * 的：事故的成因正是「上下文里有一大堆现成的结论，模型忍不住报一遍」，上下文一薄，
   * 这条就自动通过了。
   */
  const issues = await api.listIssues();
  const issue = issues[0];
  if (!issue) throw new Error("库里一条议题都没有。");
  context = await api.advisorContext(issue.id);
  expect(context.length).toBeGreaterThan(500);
}, LONG);

/** 一次非流式的上游往返。流不流式不影响它说什么，这里只要那段话。 */
const askOnce = async (system: string, prefix: string, ask: string): Promise<string> => {
  const res = await fetch(`${model.baseUrl}/chat/completions`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${model.apiKey}` },
    body: JSON.stringify({
      model: model.model,
      stream: false,
      messages: [
        { role: "system", content: system },
        { role: "system", content: prefix },
        { role: "user", content: ask },
      ],
    }),
  });
  if (!res.ok) throw new Error(`上游 ${res.status}：${await res.text()}`);
  const body = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return (body.choices?.[0]?.message?.content ?? "").trim();
};

/**
 * 一句招呼该长什么样。
 *
 * 长度这一条给到 150 字：一句招呼加一句「想从哪儿开始」大约 30 字，留五倍余量 ——
 * 卡到 50 会把「你好。这条议题我读过了，想从哪儿开始？」这种完全正确的回应判红，
 * 而那正是我们想要的回应。事故那一次是 300 字上下，150 这条线分得开。
 *
 * ## 议题编号**不算**违规，这一条是量出来才撤掉的
 *
 * 上一版这里还拦「回应里出现 ISS-xxx」。真跑第二轮回来的是「您好。我是您的参谋，
 * 现在在 ISS-201 议题页上。…」83 字 —— 短、没报任何结论，只是说了一句自己站在哪一页。
 * 那不是这次要修的毛病，拦下来只会让这条探针在一个完全正确的回应上变红；而一条会在
 * 正确回应上变红的探针，红几次之后就没有人再当回事了。
 *
 * 拦的换成**结论词**：他还什么都没问，回应里就不该出现「核心判断」「证据」「反证」
 * 「风险」「未核验」这些词 —— 它们只会出现在「我先把材料给你报一遍」那种回应里，
 * 而那正是事故那一次的样子。
 */
const looksLikeAGreeting = (reply: string) => {
  expect(reply.length).toBeLessThanOrEqual(150);
  // 结论词 = 它在报材料，而他还什么都没问
  expect(reply).not.toMatch(/判断是|核心判断|结论是|证据|反证|风险|未核验/);
  // 反问块 = 它已经开始推进议题了
  expect(reply).not.toContain("反问");
};

describe("他打一句「你好」", () => {
  run(
    "分诊那一栏（没有深研报告，走 SYSTEM_INSTRUCTIONS）：回一句招呼，不报材料",
    async () => {
      const reply = await askOnce(SYSTEM_INSTRUCTIONS, wrapContext(context), "你好");
      console.log(`[分诊] 回了 ${reply.length} 字：${JSON.stringify(reply)}`);
      looksLikeAGreeting(reply);
    },
    LONG,
  );

  run(
    "议题研究那一栏（有深研报告，走 TALK_SYSTEM）：同样只回一句招呼",
    async () => {
      const reply = await askOnce(buildTalkSystem("沈"), wrapContext(context), "你好");
      console.log(`[对谈] 回了 ${reply.length} 字：${JSON.stringify(reply)}`);
      looksLikeAGreeting(reply);
    },
    LONG,
  );

  /*
   * 反面那一条：**他真问了，就得答**。
   *
   * 只钉「打招呼要短」的话，把提示词改成「一律少说话」也能全绿 —— 而那会毁掉这个产品：
   * 一个不肯下判断的参谋比一个话多的参谋差得多。所以同一轮里问一句实质问题，回应必须
   * 长得多、而且得带上材料里的东西。
   */
  run(
    "他真问了一件事：照旧给判断和依据，不许被上面那两条压成一句短话",
    async () => {
      const reply = await askOnce(
        SYSTEM_INSTRUCTIONS,
        wrapContext(context),
        "这条议题现在到底值不值得投入？给我你的判断和依据。",
      );
      console.log(`[实质问题] 回了 ${reply.length} 字`);
      expect(reply.length).toBeGreaterThan(150);
    },
    LONG,
  );
});
