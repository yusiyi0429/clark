import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TWorkIntakeEntry } from "@warmap/contracts";
import { WorkIntakeQueueView } from "./WorkIntake";

const entry = (id: string, state: TWorkIntakeEntry["state"], extra: Partial<TWorkIntakeEntry> = {}): TWorkIntakeEntry => ({
  id, scope: "global", message: "请继续核对会议材料", state, priority: false, error: null,
  createdAt: "2026-11-15T00:00:00Z", updatedAt: "2026-11-15T00:00:00Z", ...extra,
});
const render = (items: TWorkIntakeEntry[], error = "", busyId: string | null = null) => renderToStaticMarkup(
  <WorkIntakeQueueView items={items} error={error} busyId={busyId} onReload={() => {}} onChange={() => {}} />,
).replace(/<!-- -->/g, "");

describe("输入附近的待发需求", () => {
  it("空队列不占空间；正常待发收起，递送状态不能被称为完成", () => {
    expect(render([])).toBe("");
    const html = render([entry("a", "queued"), entry("b", "sending")]);
    expect(html).toContain("待发需求 2");
    expect(html).toContain("1 排队中");
    expect(html).toContain("1 递送中");
    expect(html).not.toContain(" open");
    expect(html).not.toContain("已完成");
    expect(html.match(/>撤回</g)).toHaveLength(1);
    expect(html.match(/>优先发送</g)).toHaveLength(1);
  });

  it("失败展开并显示原因和重试；优先项不重复提供优先操作", () => {
    const html = render([entry("a", "failed", { error: "尚未收到服务端回执" }), entry("b", "queued", { priority: true })]);
    expect(html).toContain('open=""');
    expect(html).toContain("1 发送失败");
    expect(html).toContain("尚未收到服务端回执");
    expect(html).toContain("重试发送");
    expect(html).toContain("优先待发");
    expect(html).not.toContain(">优先发送<");
  });

  it("长正文保留全文且原文转义，不把正文作为HTML执行", () => {
    const text = "<script>throw 1</script>\n" + "会议资料".repeat(500);
    const html = render([entry("a", "queued", { message: text })]);
    expect(html).toContain("&lt;script&gt;throw 1&lt;/script&gt;");
    expect(html).toContain("会议资料".repeat(500));
    expect(html).toContain("全文");
    expect(html).not.toContain("<script>");
  });

  it("读取失败没有伪造需求数量，更新期间按钮被禁用", () => {
    const error = render([], "网络中断，待发需求未能读取");
    expect(error).toContain('role="status"');
    expect(error).toContain("重新读取");
    expect(error).not.toContain("待发需求 0");
    const html = render([entry("a", "failed"), entry("b", "queued")], "", "a");
    expect(html).toContain('aria-busy="true"');
    expect(html.match(/disabled=""/g)?.length).toBe(4);
  });
});
