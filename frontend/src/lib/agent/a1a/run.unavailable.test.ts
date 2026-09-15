/**
 * 第三态：本体服务连不上。
 *
 * 这条要的是两件事同时成立 —— **停下来**（不许降级成纯外部照样出一份议题），
 * 而且**台账上留下一条**（只在服务器日志里留一行的话，屏幕上表现成「点了没
 * 反应」，运营台里也数不到这次失败）。
 *
 * 不打桩，跑真链路：把地址指到一个连不上的端口。打桩会把要验的那段
 * （客户端抛什么 → harness 怎么落账）替换掉，剩下的只是在验桩本身。
 *
 * **两个源各跑一遍。** 换源之后这条性质最容易悄悄丢：叙述那一支是另一个客户端、
 * 另一个异常类，只验其中一支的话，另一支哪天改成「取不到就当没有上下文继续跑」，
 * 这里一个字都不会红 —— 而那正是本文件在防的那件事。
 */
import { afterEach, describe, expect, it } from "vitest";

import { AgentRunFailed } from "@/lib/agent/harness";
import { GraphKnowledgeUnavailable } from "@/lib/graphknowledge";
import { isOntologyUnavailable, OntologyUnavailable } from "@/lib/ontology/errors";

import { runA1a } from "./run";

const KEYS = [
  "TKOS_ONTOLOGY_SOURCE",
  "TKOS_GRAPHKNOWLEDGE_BASE_URL",
  "TKOS_MEMORY_API_BASE_URL",
  "TKOS_MEMORY_API_KEY",
] as const;
const original = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
});

/** 9 号端口是 discard，连不上。 */
const SOURCES = [
  {
    name: "本体叙述接口（默认这一支）",
    setup: () => {
      delete process.env.TKOS_ONTOLOGY_SOURCE;
      process.env.TKOS_MEMORY_API_BASE_URL = "http://127.0.0.1:9";
      process.env.TKOS_MEMORY_API_KEY = "x";
    },
    cause: OntologyUnavailable,
  },
  {
    name: "GraphKnowledge（TKOS_ONTOLOGY_SOURCE=graph）",
    setup: () => {
      process.env.TKOS_ONTOLOGY_SOURCE = "graph";
      process.env.TKOS_GRAPHKNOWLEDGE_BASE_URL = "http://127.0.0.1:9/graph";
    },
    cause: GraphKnowledgeUnavailable,
  },
] as const;

describe.each(SOURCES)("runA1a 第三态 · $name", ({ setup, cause }) => {
  it("本体不可达：就地失败，但异常上挂着一条可入账的 failed 记录", async () => {
    setup();

    const err = await runA1a({
      cardId: "CARD-01",
      headline: "大厂把 To B 的销售与交付合并成行业线",
      source: "公开报道",
    }).then(
      (rec) => {
        throw new Error(`不该跑成功：拿到了 ${rec.status} 的记录`);
      },
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(AgentRunFailed);
    const failed = err as AgentRunFailed;
    // 原始异常留着：调用方要分「连不上」和别的错就靠它。
    expect(failed.cause).toBeInstanceOf(cause);
    // 两支共用的判据 —— 门上面那两处就是按它写「本体服务不可达」那句话的。
    expect(isOntologyUnavailable(failed.cause)).toBe(true);

    const run = failed.run;
    expect(run.agent).toBe("A1a");
    expect(run.status).toBe("failed");
    expect(run.id.startsWith("RUN-A1a-")).toBe(true);
    // 一次模型都没调到：token 是四个零，产出为 null。
    expect(run.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    });
    expect(run.output).toBeNull();
    expect(run.contextMode).toBe("");
    // 连不上时也答得出「这次试的是哪个配方」。
    expect(run.contextRecipe).toBe("S01");
  });
});
