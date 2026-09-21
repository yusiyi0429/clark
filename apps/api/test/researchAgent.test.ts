import { describe, expect, it } from "vitest";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import { createResearchAgentRunner } from "../src/researchAgent.js";
import { loadCompanyMemory } from "../src/companyMemory.js";
import { migrate } from "../src/migrate.js";
import { createTestDb, testEnv } from "./helpers.js";
import type { RadarOutletAdapter } from "../src/radar.js";

const usage = {
  input: 5, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 8,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function stream(content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]) {
  const final: AssistantMessage = {
    role: "assistant",
    api: "openai-responses",
    provider: "warmap",
    model: "fake-heavy",
    content,
    usage,
    stopReason,
    timestamp: Date.now(),
  };
  const events = createAssistantMessageEventStream();
  queueMicrotask(() => {
    events.push({ type: "start", partial: { ...final, content: [] } });
    const block = final.content[0];
    if (block.type === "toolCall") {
      events.push({ type: "toolcall_start", contentIndex: 0, partial: final });
      events.push({ type: "toolcall_end", contentIndex: 0, toolCall: block, partial: final });
      events.push({ type: "done", reason: "toolUse", message: final });
    } else {
      events.push({ type: "text_start", contentIndex: 0, partial: final });
      events.push({ type: "text_delta", contentIndex: 0, delta: block.text, partial: final });
      events.push({ type: "done", reason: "stop", message: final });
    }
  });
  return events;
}

const doc = (sourceTitle: string) => ({
  summary: "渠道策略需要重新判断",
  options: [
    { id: "adjust", label: "调整渠道", consequences: ["短期投入上升"] },
    { id: "hold", label: "保持观察", consequences: ["可能错过窗口"] },
  ],
  evidence: [{ quote: "Treasury basis trade overview", sourceTitle }],
  unknowns: [],
  sources: [{ title: sourceTitle, url: "https://www.bloomberg.com/news/articles/example" }],
});

const input = {
  issue: {
    id: "issue-1",
    title: "渠道策略",
    origin: "radar" as const,
    originRef: null,
    location: { level: "company" },
    urgency: { level: "gray" },
  },
};

const outletItem = {
  sourceType: "outlet" as const,
  title: "Treasury basis trade",
  url: "https://www.bloomberg.com/news/articles/example",
  publishedAt: "2026-09-18T00:00:00.000Z",
  excerpt: "Treasury basis trade overview",
  sourceRef: { type: "outlet" as const, provider: "publisher-feed" as const, outletId: "bloomberg", outletName: "彭博" },
};

function fakeOutletAdapter() {
  const calls: unknown[] = [];
  const adapter: RadarOutletAdapter & { calls: unknown[] } = {
    calls,
    configured: true,
    async fetchLatest(request) {
      calls.push(structuredClone(request));
      return [structuredClone(outletItem)];
    },
  };
  return adapter;
}

describe("issue pre-research publisher feed", () => {
  it("只读取当前启用的发布方 feed，并把工具结果写入预研证据", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      await db.query(
        `UPDATE radar_config SET lookback_hours = 48, sources = $1::jsonb WHERE id = 'default'`,
        [JSON.stringify({
          sites: [],
          wechatAccounts: [],
          outlets: [{ id: "global-finance", name: "全球财经媒体", enabled: true, outlets: ["bloomberg", "ft"] }],
        })],
      );
      const contexts: Context[] = [];
      const outlets = fakeOutletAdapter();
      const runner = createResearchAgentRunner({
        query: db.query.bind(db),
        companyMemory: loadCompanyMemory(testEnv),
        baseUrl: "https://provider.invalid/v1/responses",
        apiKey: "test-key",
        modelId: "fake-heavy",
        outlets,
        streamSimple: (_model, context) => {
          contexts.push(context);
          if (contexts.length === 1) {
            return stream([{ type: "toolCall", id: "feed-1", name: "read_outlet_feed", arguments: {} }], "toolUse");
          }
          const seen = JSON.stringify(context.messages).includes("Treasury basis trade");
          return stream([{
            type: "toolCall",
            id: "submit-1",
            name: "submit_candidate",
            arguments: doc(seen ? "彭博：Treasury basis trade" : "missing"),
          }], "toolUse");
        },
      });

      const result = await runner(input, new AbortController().signal) as { evidence: { sourceTitle: string }[] };
      expect(contexts[0].tools?.map((tool) => tool.name).sort()).toEqual(["read_outlet_feed", "submit_candidate"]);
      expect(result.evidence[0].sourceTitle).toBe("彭博：Treasury basis trade");
      expect(outlets.calls).toEqual([{ outletIds: ["bloomberg", "ft"], lookbackHours: 48 }]);
    });
  });

  it("配置未启用发布方时不暴露该工具", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      await db.query(`UPDATE radar_config SET sources = '{"sites":[],"wechatAccounts":[]}'::jsonb WHERE id = 'default'`);
      const contexts: Context[] = [];
      const outlets = fakeOutletAdapter();
      const runner = createResearchAgentRunner({
        query: db.query.bind(db),
        companyMemory: loadCompanyMemory(testEnv),
        baseUrl: "https://provider.invalid/v1/responses",
        apiKey: "test-key",
        modelId: "fake-heavy",
        outlets,
        streamSimple: (_model, context) => {
          contexts.push(context);
          return stream([{ type: "toolCall", id: "submit-1", name: "submit_candidate", arguments: doc("内部材料") }], "toolUse");
        },
      });

      await runner(input, new AbortController().signal);
      expect(contexts[0].tools?.map((tool) => tool.name)).toEqual(["submit_candidate"]);
      expect(outlets.calls).toEqual([]);
    });
  });
});
