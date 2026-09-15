/**
 * A10 上了 harness 之后也归三态管：本体连不上就**就地失败**，不许降级成纯外部。
 *
 * 这条链路的产出是要改写本体的（判断 +1 版、陈述换新、重开条件挂成靶点）。
 * 悄悄降级的后果不是「这次报告差一点」，是半年后翻这条判断的来历，看到的是一份
 * 没有任何公司上下文却写得格式完整的提案。
 *
 * 不打桩，跑真链路：地址指到一个连不上的端口（同 `a1a/run.unavailable.test.ts`），
 * 并且**两个源各跑一遍**（理由同那个文件的文件头）。
 */
import { afterEach, describe, expect, it } from "vitest";

import { AgentRunFailed } from "@/lib/agent/harness";
import { GraphKnowledgeUnavailable } from "@/lib/graphknowledge";
import { isOntologyUnavailable, OntologyUnavailable } from "@/lib/ontology/errors";

import { runWriteBack } from "./run";

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

describe.each(SOURCES)("runWriteBack 第三态 · $name", ({ setup, cause }) => {
  it("本体不可达：就地失败，异常上挂着一条可入账的 failed 记录", async () => {
    setup();

    const err = await runWriteBack({
      issueId: "ISS-001",
      title: "把 To B 的销售与交付合并成行业线",
      research: null,
      question: null,
      dialogue: [],
      judgments: [{ id: "01-J2", statement: "公司先做深一个行业再横向复制", standing: "confirmed" }],
    }).then(
      (r) => {
        throw new Error(`不该跑成功：拿到了 ${r.attempts} 轮的结果`);
      },
      (e: unknown) => e
    );

    expect(err).toBeInstanceOf(AgentRunFailed);
    const failed = err as AgentRunFailed;
    // 原始异常留着：调用方要分「连不上」和别的错就靠它。
    expect(failed.cause).toBeInstanceOf(cause);
    expect(isOntologyUnavailable(failed.cause)).toBe(true);

    const run = failed.run;
    expect(run.agent).toBe("A10");
    expect(run.status).toBe("failed");
    expect(run.id.startsWith("RUN-A10-")).toBe(true);
    // 一次模型都没调到：四个零，产出为 null。写回提案最贵，不该为一次连不上花钱。
    expect(run.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
    });
    expect(run.output).toBeNull();
    expect(run.contextMode).toBe("");
    // 连不上时也答得出「这次试的是哪个配方」。
    expect(run.contextRecipe).toBe("S03");
  });
});
