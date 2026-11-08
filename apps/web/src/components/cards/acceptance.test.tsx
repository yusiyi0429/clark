import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TCardHandbackView } from "@warmap/contracts";
import { Acceptance } from "./CardSession";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const handback = (patch: Partial<TCardHandbackView>) => ({
  id: "00000000-0000-4000-8000-0000000000e1", attempt: 1, status: "done", outcome: "fail", met: 1, total: 2, headline: null, returnText: null, returnedAt: null,
  overruled: false, createdAt: "2026-11-08T01:00:00Z", finishedAt: "2026-11-08T01:02:00Z", git: null, sourceWordIssues: [], runId: null, criteria: [], claims: [],
  summary: null, outputIds: [], error: null, startedAt: null, expectedSeconds: 60, overrule: null, verifier: null,
  result: { criteria: [{ index: 1, text: "能登录", verdict: "met", reason: null, fix: null }, { index: 2, text: "有 404", verdict: "unmet", reason: "没处理", fix: "补上" }], beyondScope: [] },
  ...patch,
}) as TCardHandbackView;

describe("卡详情的验收结论（16.8 原话对不上）", () => {
  it("没过的标准后面列出原话对不上的几处：原话、「漏了 / 多做了」、为什么；met/total 只算标准", () => {
    const html = renderToStaticMarkup(<Acceptance cardId="c1" canOverrule={false} deliverable={null} onChanged={() => undefined}
      handback={handback({ sourceWordIssues: [{ quote: "别动登录", kind: "extra", reason: "改了登录页" }, { quote: "要有 404", kind: "missing", reason: "没处理 404" }] })} />);
    expect(text(html)).toMatch(/未通过 · 1\/2 条达到.*有 404.*别动登录 多做了 改了登录页 .*要有 404 漏了 没处理 404/);
  });

  it("没有对不上的不画那一段", () => {
    expect(renderToStaticMarkup(<Acceptance cardId="c1" canOverrule={false} deliverable={null} onChanged={() => undefined} handback={handback({})} />))
      .not.toContain('data-testid="source-word-issues"');
  });
});
