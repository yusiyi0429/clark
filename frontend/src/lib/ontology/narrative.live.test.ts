/**
 * 本体叙述接口的一次真调用。**默认整条跳过**，打开：`TKOS_ONTOLOGY_LIVE=1`。
 *
 * ## 它验的是罐头验不到的那两件事
 *
 * 离线那一批（`narrative.test.ts`）喂的是我照实测回包造的帧，所以它证明的是「**如果**回包
 * 长成那样，这段代码接得住」。两件事只有真调用答得了：
 *
 * 一、**字段名有没有对上。** 猜错一个下划线的表现不是报错，是那一格恒为 0 或空串 ——
 *     `hitPaths` 一直是 0、`model` 一直是空的，而报告照常出稿。所以这里把整份回包打出来
 *     并逐格断言。
 * 二、**这个端点给的是不是仍然只有公司层。** 下面那条用例拿一句跟公司毫无关系的话去问，
 *     断言它**照样**回一段 —— 因为它回的是语义记忆（愿景 / Outcome / Mission / 经营原则），
 *     那一层跟问什么无关。这不是缺陷，是分层的结果；而整套接入的措辞
 *     （`wrapCompanyNarrative`、对谈的工具说明、`anchorChecks` 那一档）全都建立在它之上。
 *     哪天工作记忆（议题 + 判断 + 共识）也进来了，这条会开始不稳 —— 那时那三处话该改，
 *     而**没有一处会因此变红**，只有这条用例会。
 *
 * 一次调用几秒钱可以忽略（上游只跑一遍 flash 压缩），但它要网，所以不进常规跑批。
 */
import { describe, expect, it } from "vitest";

import { NarrativeClient, narrativeSettings } from "./narrative";

const ON = process.env.TKOS_ONTOLOGY_LIVE === "1";
const run = ON ? it : it.skip;
const LONG = 60_000;

describe("本体叙述接口 · 真调用", () => {
  run(
    "拿一句公司自己的问题去问，回包每一格都对得上",
    async () => {
      const s = narrativeSettings();
      expect(s.baseUrl, "没配 TKOS_MEMORY_API_BASE_URL").not.toBe("");
      expect(s.apiKey, "没配 TKOS_MEMORY_API_KEY").not.toBe("");

      const r = await new NarrativeClient().narrative("TKOS 是什么", { includeRaw: true });

      console.log(
        [
          `耗时 ${r.ms}ms · 压缩模型 ${r.model}`,
          `hit_paths ${r.hitPaths} · lateral_nodes ${r.lateralNodes}`,
          `原文 ${r.rawChars} 字 → 压缩 ${r.compressedChars} 字`,
          `正文开头：${r.text.slice(0, 80)}…`,
        ].join("\n")
      );

      expect(r.text.length).toBeGreaterThan(50);
      // 猜错字段名的样子就是这几格恒为 0 / 空串，而正文照样有 —— 所以要逐格断言。
      expect(r.model).not.toBe("");
      expect(r.compressedChars).toBeGreaterThan(0);
      expect(r.rawChars).toBeGreaterThan(0);
      // 要了原文就该拿到原文，而且它比压缩版长。拿不到时客户端会回落，那一档由离线用例锁着。
      expect(r.raw).not.toBe("");
      expect(r.rawChars).toBeGreaterThan(r.compressedChars);
    },
    LONG
  );

  run(
    "**拿一句跟公司毫无关系的话去问，它照样回一段** —— 它给的是公司层，跟问什么无关",
    async () => {
      const r = await new NarrativeClient().narrative("日本北海道的滑雪场雪质如何");
      console.log(`无关问句：hit_paths ${r.hitPaths} · 正文 ${r.text.length} 字`);
      /*
       * 它一旦不成立（上游开始按问句判相关、或者工作记忆进来了会说「这条没记过」），
       * `wrapCompanyNarrative`、`renderMembers`、`tools.ts` 里那三段「这一轮只有公司层、
       * 没有议题自己的历史」就该一起改写，而那时候除了这条用例没有一处会提醒我们。
       * 红了不是坏事，是本体往前走了一步。
       */
      expect(r.text.length).toBeGreaterThan(50);
    },
    LONG
  );

  run(
    "/healthz 通",
    async () => {
      expect(await new NarrativeClient().health()).toMatchObject({ ok: true });
    },
    LONG
  );
});
