import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { TPersonalMissionCardPayload } from "@warmap/contracts";
import { personalPayload } from "./personalMissionFixture";

const ui = vi.hoisted(() => ({ buttons: new Map<string, { onPress?: () => void; isDisabled?: boolean }>() }));
vi.mock("ts-design/primitives", () => ({ Button: ({ children, onPress, isDisabled, ...props }: { children?: ReactNode; onPress?: () => void; isDisabled?: boolean }) => {
  ui.buttons.set(String(children), { onPress, isDisabled }); return <button disabled={isDisabled} {...props}>{children}</button>;
} }));
import { MissionDraftStatus } from "./MissionWorkflowActions";

const retry = { actionId: "retry-signed", actionType: "mission-round.draft", label: "重试起草" };
const failures = [
  { ownerId: "owner", ownerName: "白田田", message: "成功 / 验收标准尚未明确，请补充依据后重试。" },
  { ownerId: "other", ownerName: "孙铭泽", message: "无法获取当前任务的原始依据。" },
];
const failedPayload: TPersonalMissionCardPayload = { ...personalPayload, draftFailure: failures[0].message, round: { ...personalPayload.round, phase: "draft", draftFailures: failures, retryDraftAction: retry } };
const onAction = vi.fn();
function render(payload = failedPayload, pending = false) { return renderToStaticMarkup(<MissionDraftStatus payload={payload} pending={pending} onAction={onAction} />); }
beforeEach(() => { ui.buttons.clear(); vi.clearAllMocks(); });

describe("当前流程的任务起草状态", () => {
  it("实际失败原因按人展示，DRI重试携带服务端操作，处理中停用重试", () => {
    const html = render(); expect(html).toContain("任务起草未完成");
    for (const failure of failures) { expect(html).toContain(failure.ownerName); expect(html).toContain(failure.message); }
    expect(html.split(failures[0].message)).toHaveLength(2);
    ui.buttons.get("重试起草")!.onPress!(); expect(onAction).toHaveBeenCalledExactlyOnceWith(retry);
    render(failedPayload, true); expect(ui.buttons.get("重试起草")!.isDisabled).toBe(true);
  });
  it("普通卡主人只看到自己的原因并等待DRI重试", () => {
    const html = render({ ...failedPayload, round: { ...failedPayload.round, approver: false } });
    expect(html).toContain(failures[0].message); expect(html).not.toContain(failures[1].message);
    expect(html).toContain("等待刘明华重试起草"); expect(ui.buttons.has("重试起草")).toBe(false);
  });
  it("正在起草保留明确进度，完成后移除起草状态且不提供旧流程操作", () => {
    const html = render({ ...failedPayload, round: { ...failedPayload.round, phase: "drafting", retryDraftAction: null } });
    expect(html).toContain("Co-Agent 正在起草任务"); expect(html).not.toContain("完成后，任务正文会在这里更新。"); expect(ui.buttons.has("重试起草")).toBe(false);
    ui.buttons.clear(); expect(render({ ...personalPayload, round: { ...personalPayload.round, phase: "draft" } })).toBe("");
    expect(ui.buttons.size).toBe(0);
  });
  it("仅个人卡投影包含失败时仍显示完整原因，并在服务端授予后允许重试", () => {
    const html = render({ ...failedPayload, round: { ...failedPayload.round, draftFailures: [] } });
    expect(html).toContain(failures[0].message);
    ui.buttons.get("重试起草")!.onPress!(); expect(onAction).toHaveBeenCalledExactlyOnceWith(retry);
  });
  it("没有重试授权时只显示真实原因，不根据身份自行生成操作", () => {
    const html = render({ ...failedPayload, round: { ...failedPayload.round, retryDraftAction: null } });
    expect(html).toContain("任务起草未完成"); expect(html).toContain("等待刘明华重试起草"); expect(ui.buttons.size).toBe(0);
  });
  it("长质量错误收为摘要，完整原因保留可展开；短错误不增加操作", () => {
    const message = "质量检查未通过。\n" + "成功 / 验收标准必须提供可复核的证据与明确完成条件；".repeat(12) + "最后一项：任务责任边界仍未明确。";
    const html = render({ ...failedPayload, draftFailure: message, round: { ...failedPayload.round, draftFailures: [{ ...failures[0], message }] } });
    expect(html).toContain(`${message.slice(0, 160).trimEnd()}…`); expect(html).toMatch(/<details[^>]*><summary>查看原因<\/summary><p>质量检查未通过/);
    expect(html).toContain(`<p>${message}</p></details>`); expect(html).not.toMatch(/<details[^>]*\bopen(?:=|\s|>)/); expect(render()).not.toContain("查看原因");
  });
});
