/**
 * 对话层端到端机检 —— 规格 §8 那六行里**机器答得了的那几行**。
 *
 * ## §3 那一条要诚实地读
 *
 * 下面「三套脚本跑出来的 15 轮里模板句不超过 2 次」守的是**脚本作者别把套话写进夹具**：
 * 那 15 段回应每一个字都是人写死的，模型那一侧根本没开口。规格 §3 要的是「连续 20 轮中
 * 『更新后的判断是』『仍会改变结论的未知』类句式出现 ≤2 次」，那个数只能由真模型连着跑
 * 20 轮出，进验收记录。**这一条跑绿不等于 §3 已验收。**
 *
 * ## 这里检的是让步日志这一半
 *
 * §8-4 与 §8-6 横跨「书面日志」和「板与图」两半，板那一半的机检在 `land.test.ts`
 * （分工与那几条 `it()` 的名字写在 `audit.ts` 的文件头）。本文件不开库、不重复一遍
 * store 装置。
 *
 * ## env 不在这里设
 *
 * `TKOS_PERSIST` / `TKOS_MODEL_MOCK` 由 `fixtures/pressure.ts` 在自己的文件头设死 ——
 * 设在测试文件里的那一份到这边就漏了，而漏掉的症状是这一轮悄悄读写了开发机上那份真快照。
 */

import { describe, expect, it } from "vitest";

import { templateSmells } from "./system";
import { contradicts, replayConfirmation } from "./audit";
import {
  EVIDENCE_IDS,
  confirmedSample,
  mixedScript,
  pressureScript,
  reasonScript,
  replay,
} from "./fixtures/pressure";

describe("对话层端到端（规格 §8 里能机检的那几行）", () => {
  it("§8-4 状态一致：三套脚本共 15 轮，回应与让步日志、结算后的判断都不矛盾", async () => {
    const runs = await Promise.all([replay(pressureScript), replay(reasonScript), replay(mixedScript)]);
    let checked = 0;
    for (const r of runs) {
      expect(r.replies).toHaveLength(5);
      for (const [i, reply] of r.replies.entries()) {
        const turn = i + 1;
        const rec = {
          turn,
          reply,
          entry: r.log.find((e) => e.turn === turn) ?? null,
          judgement: r.finalThesis,
        };
        expect(contradicts(rec, EVIDENCE_IDS)).toEqual([]);
        checked += 1;
      }
    }
    expect(checked).toBe(15); // 一条都没跑到也会「全部不矛盾」
  });

  it("§8-4 反例：矛盾真被抓出来，不是这个函数永远返回空数组", () => {
    const hold = {
      turn: 2,
      reply: "这一点我已经确认了，改成不扩产。",
      entry: {
        turn: 2,
        trigger: "他连着压了两轮",
        before: "扩产",
        after: "扩产",
        kind: "hold" as const,
        rationale: "没有新论据",
      },
      judgement: "扩产",
    };
    expect(contradicts(hold, EVIDENCE_IDS).length).toBeGreaterThan(0);
    const moved = {
      turn: 3,
      reply: "按 [E9] 我改了。",
      entry: {
        turn: 3,
        trigger: "[E9]",
        before: "扩产",
        after: "缓扩",
        kind: "concede" as const,
        rationale: "口径换算后份额跌了",
      },
      judgement: "扩产", // 说改了，判断还停在 before
    };
    expect(contradicts(moved, EVIDENCE_IDS).length).toBeGreaterThanOrEqual(2); // 判据 2 + 判据 3（E9 不在台账里）
  });

  /*
   * C1 的第三处：判据 3 的多编号那一档。
   *
   * 报告正文里的引用是 `[E1, E9]` 这种形状（出处见 `a4/blocks/registry.ts:196` 那句注释），
   * 而报告正文原样进对谈前缀。抠编号从前只认单编号 —— 这段话里 `[E1]` 与 `[E9]` 两个子串
   * 一个都不成立，于是编造的那个编号在这一侧静默过关。
   * 把 `cite.ts` 的正则改回只认单编号 → 这一条红。
   */
  it("§8-4 反例：一次引两个编号、其中一个是编的 → 判据 3 照样点得出那个编的", () => {
    const rec = {
      turn: 4,
      reply: "按 [E1, E9] 这两条，我把它改成缓扩。",
      entry: {
        turn: 4,
        trigger: "[E1, E9]",
        before: "扩产",
        after: "缓扩",
        kind: "concede" as const,
        rationale: "两条口径都指向缓扩",
      },
      judgement: "缓扩", // 判据 2 不开火：判断真的动到了 after
    };
    const why = contradicts(rec, EVIDENCE_IDS);
    expect(why).toHaveLength(1);
    expect(why[0]).toContain("E9"); // 台账里只有 E1/E2/E3
  });

  it("§8-6 可审计：一次确认能从让步日志 + 证据台账重放出形成过程", async () => {
    const r = await replay(reasonScript);
    // confirmedSample 就是这套脚本跑完那一句（Task 12 里写死一致）——「他确认的」与
    // 「跑出来的」不是同一句时，重放本来就该报说不出为什么，所以这一致性先断言出来。
    expect(confirmedSample.statement).toBe(r.finalThesis);
    const t = replayConfirmation({ log: r.log, evidenceIds: EVIDENCE_IDS, statement: confirmedSample.statement });
    expect(t.steps.length).toBeGreaterThan(0);
    for (const s of t.steps) {
      expect(s.trigger.trim().length).toBeGreaterThan(0);
      expect(s.before).not.toBe(s.after);
    }
    expect(t.steps.some((s) => s.citedEvidence.length > 0)).toBe(true); // 至少有一步指得出证据
    expect(t.unexplained).toEqual([]);
  });

  it("§8-6 反例：中间抽掉一条日志，那一轮就变成说不出为什么", async () => {
    const r = await replay(reasonScript);
    const holed = r.log.filter((e) => e.kind === "hold" || e.turn !== 3); // 抽掉第 3 轮那次改判
    const t = replayConfirmation({ log: holed, evidenceIds: EVIDENCE_IDS, statement: confirmedSample.statement });
    // 报的是第 4 轮：抽掉第 3 轮之后，第 4 轮那条坚持的 before 与第 2 轮的 after 接不上。
    // 断真值而不是「非空」—— 只断非空的话，判据 1 误开火（编号被当成编的）也照旧全绿。
    expect(t.unexplained).toEqual([4]);
  });

  it("§8-6 反例：他确认的不是日志走到的那一句，重放照实报成说不出为什么", async () => {
    const r = await replay(reasonScript);
    // 日志一条不缺，改的只是「他确认的是哪一句」。重放拿这一句当终点去对账，所以最后一轮
    // 会被报出来 —— 报的轮号是日志里最大的那个，这一条同时钉住重放拿哪一轮当现在。
    const t = replayConfirmation({
      log: r.log,
      evidenceIds: EVIDENCE_IDS,
      statement: "扩产规模这一轮就定",
    });
    expect(t.unexplained).toEqual([5]);
  });

  it("§8-6 重放只认台账上真有的编号：触发物里编的那个不算一步的依据", () => {
    const t = replayConfirmation({
      log: [
        {
          turn: 1,
          trigger: "[E9] 与 [E1] 都指向同一件事",
          before: "扩产",
          after: "缓扩",
          kind: "concede" as const,
          rationale: "两组独立源对上了",
        },
      ],
      evidenceIds: EVIDENCE_IDS,
      statement: "缓扩",
    });
    expect(t.steps).toHaveLength(1);
    expect(t.steps[0].citedEvidence).toEqual(["E1"]);
    // 编的那个不是被悄悄丢掉：同一轮会被报成说不出为什么。
    expect(t.unexplained).toEqual([1]);
  });

  it("§8-1 时延埋点存在：两个数都被记下来（数值由真模型那一轮判）", async () => {
    const r = await replay(reasonScript);
    expect(r.traces).toHaveLength(5);
    for (const t of r.traces) {
      /*
       * 断的是**这两个数真被填过**，不是它们的类型：两栏在 `TurnTrace` 上都是必填 `number`、
       * 又被初始化成 0，所以 `typeof … === "number"` 是 TypeScript 已经保证的事，
       * 那样写等于这个埋点在仓库里零覆盖（实测过：把 `turn.ts` 里那两行赋值删掉照旧全绿）。
       *
       * 这套夹具上两个数**必然大于 0**：注入的时钟每读一次表走 12 毫秒（不接 `Date.now` 是
       * Task 10 的要求），第一格被 `startedAt` 吃掉，所以之后每一次读表都 ≥12。整轮那一次
       * 读表在轮首那一次之后，于是严格更大。**秒数快不快由真模型那一轮判**，这里不设阈值。
       */
      expect(t.timing.firstTokenMs).toBeGreaterThan(0);
      expect(t.timing.totalMs).toBeGreaterThan(t.timing.firstTokenMs);
    }
  });

  it("§3 回应形状：三套脚本跑出来的 15 轮里一句套话都没有（守的是脚本作者，不是模型）", async () => {
    const runs = await Promise.all([replay(pressureScript), replay(reasonScript), replay(mixedScript)]);
    const replies = runs.flatMap((r) => r.replies);
    expect(replies).toHaveLength(15);
    /*
     * 阈值是 0 不是规格那个 2：那个 2 是给**真模型连着 20 轮**定的合格线，而这 15 段回应
     * 每个字都是人写死的 —— 拿 2 当闸的话，谁往脚本里写进两句「更新后的判断是」，这道闸
     * 照旧全绿，而它宣称守的正是这件事。断整个数组而不是长度：红了一眼看得出是哪一句。
     */
    expect(replies.flatMap(templateSmells)).toEqual([]);
  });
});
