import { describe, expect, it } from "vitest";
import { Type } from "@sinclair/typebox";
import {
  createAssistantMessageEventStream,
  type AssistantMessage,
  type Context,
} from "@earendil-works/pi-ai";
import { runCandidateAgent } from "../src/candidateAgentRuntime.js";
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

  it("带图片：图片随用户消息发出，模型注册成能看图；不带图片时只认文字", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const seen: { input: string[]; content: unknown }[] = [];
      const run = (images?: { type: "image"; data: string; mimeType: string }[]) => runCandidateAgent({
        query: db.query.bind(db), kind: "deliverable_review", input: { task: "fixture" }, prompt: "只提交结构化候选。", schema: Candidate,
        baseUrl: "https://provider.invalid/v1/responses", apiKey: "test-key", modelId: "fake-heavy", images,
        streamSimple: (model, context) => {
          seen.push({ input: [...model.input], content: context.messages[0]?.content });
          return stream([{ type: "toolCall", id: `submit-${seen.length}`, name: "submit_candidate", arguments: { summary: "看过了" } }], "toolUse");
        },
      });
      await run([{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]);
      await run();
      expect(seen[0].input).toEqual(["text", "image"]);
      expect(seen[0].content).toEqual(expect.arrayContaining([{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]));
      expect(seen[1].input).toEqual(["text"]);
      expect(JSON.stringify(seen[1].content)).not.toContain("image/png");
    });
  });

  it("业务校验不通过时把说明回给模型，改好重交才收下", async () => {
    await createTestDb(async ({ db }) => {
      await migrate(db);
      const contexts: Context[] = [];
      const result = await runCandidateAgent({
        query: db.query.bind(db),
        kind: "meeting_preflight",
        input: { meeting: "fixture" },
        prompt: "只提交结构化候选。",
        schema: Candidate,
        baseUrl: "https://provider.invalid/v1/responses",
        apiKey: "test-key",
        modelId: "fake-heavy",
        maxModelCalls: 3,
        validate: (candidate) => candidate.summary.includes("而是") ? "summary 用了「不是……而是……」句式，改成正面直接陈述" : null,
        streamSimple: (_model, context) => {
          contexts.push(context);
          const summary = contexts.length === 1 ? "不是渠道问题，而是窗口问题" : "华南窗口还有六周";
          return stream([{ type: "toolCall", id: `submit-${contexts.length}`, name: "submit_candidate", arguments: { summary } }], "toolUse");
        },
      });

      expect(result.candidate).toEqual({ summary: "华南窗口还有六周" });
      expect(contexts).toHaveLength(2);
      expect(JSON.stringify(contexts[1].messages)).toContain("未通过校验：summary 用了「不是……而是……」句式");
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
});
