import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactPortal } from "react";
import ReactDOM from "react-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { useUNSAFE_PortalContext } from "react-aria/PortalProvider";
import type { TTranscriptCandidateProjection } from "@warmap/contracts";
import { TranscriptCandidateDialog } from "./MeetingCard";

const portals = vi.hoisted(() => ({ targets: [] as unknown[], getters: [] as (null | undefined | (() => HTMLElement | null))[] }));

// 无 DOM 的测试：保留 React Aria 的真实容器选择，只替换 createPortal 的渲染边界。
// 这能验证目标与作用域，不能替代浏览器对原生 dialog 顶层、焦点和点击的验证。
vi.mock("@/components/ui/Select", async () => {
  const { createElement } = await import("react");
  const { Overlay } = await import("react-aria/Overlay");
  const { useUNSAFE_PortalContext } = await import("react-aria/PortalProvider");
  return { Select: () => {
    portals.getters.push(useUNSAFE_PortalContext().getContainer);
    // 桌面 Popover 与手持 ModalOverlay 的门户都经过同一个 Overlay。
    return createElement(Overlay, { disableFocusManagement: true, children: createElement("span", null, "人员选项") });
  } };
});

const candidate: TTranscriptCandidateProjection = {
  source: { format: "volc_asr", fileName: "会议录音.mp3", sizeBytes: 10, sha256: "123456789012", parserVersion: "volc-asr.v1", timeAnchor: null },
  createdAt: "2026-11-13T00:00:00Z",
  turnCount: 1, speakerCount: 1, durationSeconds: 0, firstOffsetSeconds: 7, lastOffsetSeconds: 7,
  speakers: [{ speakerName: "说话人 1", turnCount: 1, suggestedPersonId: null, suggestedDisplayName: null }],
  sampleTurns: [{ speakerName: "说话人 1", offsetSeconds: 7, text: "讨论网站内容。" }],
  warnings: [],
};
const dialogProps = {
  candidate, participants: [], directory: [], directoryError: null, pending: false, state: { status: "idle" as const },
  hasConfirm: true, hasDiscard: true,
  onRetry: () => undefined, onClose: () => undefined, onConfirm: () => undefined, onDiscard: () => undefined,
};

beforeEach(() => {
  portals.targets = []; portals.getters = [];
  vi.spyOn(ReactDOM, "createPortal").mockImplementation((children, target) => {
    portals.targets.push(target);
    return children as ReactPortal;
  });
});
afterEach(() => vi.restoreAllMocks());

describe("会议记录候选的局部门户", () => {
  it("把下拉的真实 Overlay 路由到本场 dialog，且不改变外部的门户上下文", () => {
    const dialog = {} as HTMLDialogElement;
    let outside: unknown = "not rendered";
    function OutsideProbe() {
      outside = useUNSAFE_PortalContext().getContainer;
      return null;
    }
    renderToStaticMarkup(<>
      <TranscriptCandidateDialog {...dialogProps} dialogRef={{ current: dialog }} />
      <OutsideProbe />
    </>);
    expect(portals.targets).toEqual([dialog]);
    expect(outside).toBeUndefined();
  });

  it("打开前容器可为空；回调读取当前 ref，卸载后不退回 document.body", () => {
    const dialogRef = { current: null as HTMLDialogElement | null };
    renderToStaticMarkup(<TranscriptCandidateDialog {...dialogProps} dialogRef={dialogRef} />);
    const getContainer = portals.getters[0];
    expect(getContainer).toBeTypeOf("function");
    expect(getContainer!()).toBeNull();
    expect(portals.targets).toEqual([]);
    const dialog = {} as HTMLDialogElement;
    dialogRef.current = dialog;
    expect(getContainer!()).toBe(dialog);
    dialogRef.current = null;
    expect(getContainer!()).toBeNull();
  });
});
