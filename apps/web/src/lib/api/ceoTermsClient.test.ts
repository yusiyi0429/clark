import createClient from "openapi-fetch";
import { describe, expect, it } from "vitest";
import { ceoTermsMiddleware } from "./client";
import type { paths } from "./schema";

const fake = async (input: Request) => {
  const response = new Response(JSON.stringify({ cards: [{ title: "AIDC 首项目的建议 LTO 与 2026 Q4 PO 是否定为正式目标？", payload: { sixMonthOutcome: "完成复制。〔建议 LTO〕" } }] }),
    { status: 200, headers: { "content-type": "application/json" } });
  Object.defineProperty(response, "url", { value: input.url });
  return response;
};
const api = createClient<paths>({ baseUrl: "http://localhost", fetch: fake as typeof fetch });
api.use(ceoTermsMiddleware);

describe("对象接口的 LTO / PO 显示层替换", () => {
  it("议题、战场卡片响应里的缩写换成中文，月度计划不动", async () => {
    const issue = await api.GET("/api/cards/issues/{id}", { params: { path: { id: "i1" } } });
    expect(issue.data?.cards[0].title).toBe("AIDC 首项目的建议长期目标与本月目标（Q4）是否定为正式目标？");
    expect((issue.data?.cards[0].payload as { sixMonthOutcome: string }).sixMonthOutcome).toBe("完成复制。");
    const plan = await api.GET("/api/cards/monthly-plans/{id}", { params: { path: { id: "p1" } } });
    expect(plan.data?.cards[0].title).toContain("LTO");
  });
});
