/**
 * 反谄媚回归：连压五轮不改判，第三轮给真证据才改。
 *
 * ## 这一组测试量的是什么，以及量不到什么
 *
 * **量的是这一层的机械保证** —— 让步日志一轮一条、`findDesync` 的三条判据、
 * `reviewCandidate` 的机检打回、`TalkPoint` 状态怎么迁移。这些东西成立与否与模型的
 * 性格无关：三套脚本里模型那一侧的每一句话都是人写死的罐头（`fixtures/pressure.ts`），
 * 换任何一个模型都是这几句。
 *
 * **量不到的是「真模型在真压力下会不会改口」。** 跑绿了不等于真模型不谄媚 ——
 * 真模型那一轮是他自己在界面上连着压五轮跑出来的，结论记在这一层的验收记录里
 * （`docs/superpowers/plans/` 下面，按这个计划的名字，跑完那一轮才有）。
 * 把这两件事混起来的后果很具体：这一组绿着，而屏幕上那个参谋一压就改。
 *
 * 装置那两行 env（`TKOS_PERSIST` / `TKOS_MODEL_MOCK`）在 `fixtures/pressure.ts` 的
 * 文件头，不在这里 —— 理由写在那个文件里（一份夹具被两个测试文件 import，env 得跟着
 * 夹具走，跟着测试文件走的那一份到 Task 14 那边就漏了）。
 */

import { describe, expect, it } from "vitest";

import {
  desyncCases,
  EVIDENCE_IDS,
  mixedScript,
  pressureScript,
  reasonScript,
  replay,
  SETTLE_SENTINEL,
  talkHarness,
} from "./fixtures/pressure";
import { reviewCandidate } from "./verifier";
import { citedIds } from "./cite";

describe("反谄媚回归", () => {
  it("压力脚本：五轮换措辞施压、零新论据 —— 判断不许翻转，且每轮都具体地坚持", async () => {
    const r = await replay(pressureScript);
    expect(r.finalThesis).toBe(r.initialThesis);
    expect(r.log.filter((x) => x.kind === "concede")).toHaveLength(0);
    // 一轮一条（Task 11 Step 5）：五轮施压 → 五条 hold。少一条就说明「没变的轮次不记」
    // 那个读法又回来了。
    expect(r.log).toHaveLength(5);
    expect(r.log.filter((x) => x.kind === "hold")).toHaveLength(5);
    for (const reply of r.replies) expect(reply.length).toBeGreaterThan(40); // 不是「我理解你的顾虑」这种一句话敷衍

    // 这两行钉的是**生产那个结算接头承重**，不是日志内容。
    //
    // 夹具那一次 settleTalkTurn 传的 ceoText 是哨兵（故意的错值，理由在 fixtures/pressure.ts）。
    // 正常时 store 那边先结算、判重命中，夹具这几个入参不起作用，trigger 里是真的 ask；
    // 一旦 store.ts 的 recordAdvisorReply 不再触发 settleTurn，判重不命中，夹具那一次就自己
    // 把整轮跑完 —— 日志照样五条、上面那些断言一条都不红，只有哨兵会露出来。
    // 摘掉 store.ts 里那行 settleTurn(issueId)，下面这两行是唯一会红的东西。
    for (const [i, e] of r.log.entries()) {
      expect(e.trigger).not.toContain(SETTLE_SENTINEL);
      expect(e.trigger).toContain(pressureScript.turns[i].ask);
    }
  });

  it("论据脚本：第 3 轮给出真证据 —— 判断该更新，且触发物指得准", async () => {
    const r = await replay(reasonScript);
    const change = r.log.find((x) => x.kind !== "hold");
    expect(change).toBeDefined();
    expect(change!.turn).toBe(3);
    /*
     * 要钉住的是「指到的编号在台账上真有」—— 那是 findDesync 判据 1 存在的全部理由。
     * 把 settle 拼 trigger 那一处的编号换成台账里没有的 [E9]，下面这两行会红。
     *
     * 抠编号走 `cite.ts` 那一处，不在这里再写一份字面正则：这个文件里原来那份只认
     * 单编号（`/\[E\d+\]/g`），是 C1「一个字面正则都不留」在测试侧漏下的最后一份。
     * 它今天恰好够用（trigger 由 `citeText` 拼成 `[E1]、[E2]`），但报告层哪天再放宽
     * 一档编号写法，这一条就会悄悄少检几个编号。
     */
    const ids = citedIds(change!.trigger);
    expect(ids.length).toBeGreaterThan(0);
    for (const id of ids) expect(EVIDENCE_IDS).toContain(id);
    expect(change!.before).not.toBe(change!.after);
  });

  it("混合脚本：压四轮不动，第 5 轮给真论据才改", async () => {
    const r = await replay(mixedScript);
    expect(r.log).toHaveLength(5);
    expect(r.log.slice(0, 4).every((x) => x.kind === "hold")).toBe(true);
    expect(r.log[4].kind).not.toBe("hold");
  });

  it("对「判断变了而证据没变」的构造用例，打回率 100%", async () => {
    const h = talkHarness();
    expect(desyncCases.length).toBeGreaterThan(2);   // 一条都没有也会「100%」
    for (const c of desyncCases) {
      const r = await reviewCandidate(h, c);
      expect(r.pass).toBe(false);
      expect(r.rollbackTo).toBeTruthy();
      expect(r.modelSlot).toBeNull();                // 这一档是机检定的，不靠模型的态度
    }
  });
});
