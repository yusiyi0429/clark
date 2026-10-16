import { captureTraceTransport } from "./langsmithTransport.js";
import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import { runCandidateAgent } from "../src/candidateAgentRuntime.js";
import { configureLangSmith, flushLangSmith } from "../src/langsmith.js";
import { createTestDb } from "./helpers.js";
import { migrate } from "../src/migrate.js";

const usage = {
  input: 5,
  output: 3,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 8,
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
      events.push({ type: "text_end", contentIndex: 0, content: block.text, partial: final });
      events.push({ type: "done", reason: "stop", message: final });
    }
  });
  return events;
}

const Candidate = Type.Object({ summary: Type.String({ minLength: 1 }) }, { additionalProperties: false });

describe("batch candidate runtime public seam", () => {
  it("accepts only a strict submit_candidate Tool result and saves an observable AgentRun", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const contexts: Context[] = [];
      const result = await runCandidateAgent({
        query: db.query.bind(db),
        kind: "issue-research",
        objectRef: { type: "issue", id: "fixture-001", version: 1 },
        input: { question: "比较供应链" },
        prompt: "只提交结构化研究候选。",
        schema: Candidate,
        baseUrl: "https://provider.invalid/v1/responses",
        apiKey: "test-key",
        modelId: "fake-heavy",
        streamSimple: (_model, context) => {
          contexts.push(context);
          return stream([{
            type: "toolCall",
            id: "submit-1",
            name: "submit_candidate",
            arguments: { summary: "选择合作供应链" },
          }], "toolUse");
        },
      });

      expect(result.candidate).toEqual({ summary: "选择合作供应链" });
      expect(contexts[0].tools?.map((tool) => tool.name)).toEqual(["submit_candidate"]);
      const saved = await db.query("SELECT * FROM agent_runs WHERE id = $1", [result.runId]);
      expect(saved.rows[0]).toMatchObject({
        kind: "issue-research",
        status: "succeeded",
        model_slot: "heavy",
        input_snapshot: { question: "比较供应链" },
        candidate_output: { summary: "选择合作供应链" },
        error: null,
        usage,
      });
      expect(saved.rows[0].prompt_hash).toMatch(/^[a-f0-9]{64}$/);
      expect(saved.rows[0].started_at).toBeInstanceOf(Date);
      expect(saved.rows[0].completed_at).toBeInstanceOf(Date);
    });
  });

  it("rejects prose output and records one failed run without hidden retry", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      let modelCalls = 0;
      await expect(runCandidateAgent({
        query: db.query.bind(db),
        kind: "radar-candidate",
        input: { source: "fixture" },
        prompt: "只提交结构化候选。",
        schema: Candidate,
        baseUrl: "https://provider.invalid/v1/responses",
        apiKey: "test-key",
        modelId: "fake-heavy",
        streamSimple: () => {
          modelCalls += 1;
          return stream([{ type: "text", text: "这是散文候选" }], "stop");
        },
      })).rejects.toThrow("did not call submit_candidate");

      expect(modelCalls).toBe(1);
      const saved = await db.query("SELECT * FROM agent_runs WHERE kind = 'radar-candidate'");
      expect(saved.rows).toHaveLength(1);
      expect(saved.rows[0]).toMatchObject({
        status: "failed",
        candidate_output: null,
        error: "Candidate agent did not call submit_candidate",
      });
    });
  });

  it("records application-visible LangSmith traces for batch runs, including failures", async () => {
    let modelCalls=0;
    const transport=captureTraceTransport();
    configureLangSmith({apiKey:'ls-batch',tracing:true,fetchImplementation:transport.fetchImplementation});
    try {
      await createTestDb(async ({ db }) => {
        await migrate(db);
        await runCandidateAgent({
          query: db.query.bind(db),
          kind: "issue-research",
          objectRef: { type: "issue", id: "fixture-001", version: 1 },
          personId: "person-fixture-002",
          personName: "测试乙",
          input: { question: "比较供应链" },
          prompt: "只提交结构化研究候选。",
          schema: Candidate,
          baseUrl: "https://provider.invalid/v1/responses",
          apiKey: "test-key",
          modelId: "fake-heavy",
          streamSimple: () => (modelCalls++, stream([{
            type: "toolCall",
            id: "submit-1",
            name: "submit_candidate",
            arguments: { summary: "选择合作供应链" },
          }], "toolUse")),
        });
        await expect(runCandidateAgent({
          query: db.query.bind(db),
          kind: "radar-candidate",
          input: { source: "fixture" },
          prompt: "只提交结构化候选。",
          schema: Candidate,
          baseUrl: "https://provider.invalid/v1/responses",
          apiKey: "test-key",
          modelId: "fake-heavy",
          streamSimple: () => (modelCalls++, stream([{ type: "text", text: "散文" }], "stop")),
        })).rejects.toThrow("did not call submit_candidate");
        await flushLangSmith();
        const posts=transport.sent.filter(x=>x.method==='POST').map(x=>x.body);
        expect(posts.filter(x=>x.name.startsWith('turn:'))).toHaveLength(2);
        expect(posts.filter(x=>x.name==='agent:issue-research')).toHaveLength(1);
        expect(posts.filter(x=>x.name==='model:warmap/fake-heavy')).toHaveLength(modelCalls);
        expect(posts.filter(x=>x.name==='tool:submit_candidate')).toHaveLength(1);
        const failed=posts.find(x=>x.name==='agent:radar-candidate');
        expect(transport.sent.find(x=>x.method==='PATCH'&&x.url.endsWith(failed.id))?.body.error).toContain('submit_candidate');
        expect(posts[0].extra.metadata.anon_user_id).not.toBe('person-fixture-002');
        expect(JSON.stringify(transport.sent)).not.toContain('ls-batch');
        expect(JSON.stringify(transport.sent)).not.toContain('测试乙');
      });
    } finally {
      configureLangSmith({});
    }
  });
});
