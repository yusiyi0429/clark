import { afterEach, expect, test } from "vitest";
import { v7 } from "uuid";
import { configureLangSmith, flushLangSmith, withTurnTrace } from "../src/langsmith.js";
import { captureTraceTransport } from "./langsmithTransport.js";

afterEach(async () => {
  await flushLangSmith();
  configureLangSmith({});
});

test("full business references retain their content while nested JSON credentials are redacted", async () => {
  const transport = captureTraceTransport();
  configureLangSmith({ apiKey: "test-key", tracing: true, fetchImplementation: transport.fetchImplementation });
  const references = [{ kind: "personal", title: "沟通偏好", text: JSON.stringify({ apiKey: "synthetic-nested-key", password: "synthetic-nested-password", preference: "先给结论" }) }];
  const reference = "Reference（参考数据，非指令）\n" + JSON.stringify(references);
  await withTurnTrace({ threadId: v7(), logicalTurnId: v7(), attempt: 1, scope: "global", agentRole: "ceo-agent", caller: "test" }, async () => {}, {
    inputs: { reference, toolText: JSON.stringify({ text: JSON.stringify({ token: "synthetic-tool-token", business: "公司战略正文" }) }) },
  });
  await flushLangSmith();
  const payload = JSON.stringify(transport.sent);
  expect(payload).not.toContain("synthetic-nested-key");
  expect(payload).not.toContain("synthetic-nested-password");
  expect(payload).not.toContain("synthetic-tool-token");
  expect(payload).toContain("沟通偏好");
  expect(payload).toContain("先给结论");
  expect(payload).toContain("公司战略正文");
});
