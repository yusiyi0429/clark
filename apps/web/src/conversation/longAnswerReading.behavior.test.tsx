import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps, ReactElement, ReactNode } from "react";
import type { ConversationData, Message } from "./useConversation";

/**
 * 第 24 项验收（长回答阅读）：气泡 → 完整记录 → 收起，同一对话与输入草稿都在。
 * 环境里没有 jsdom：用和其他行为测试一样的 hook 桩，按真实组件渲染，按钮的 onPress 直接调用。
 */
const h = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as { current: unknown }[], dependencies: [] as (readonly unknown[] | undefined)[],
  stateIndex: 0, refIndex: 0, effectIndex: 0, queued: [] as (() => unknown)[], dirty: false,
  buttons: new Map<string, { onPress?: () => void }>(),
  field: null as { value: string; onChange: (event: { target: { value: string } }) => void } | null,
  storage: new Map<string, string>(),
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
    useState: (initial: unknown) => {
      const index = h.stateIndex++;
      if (!(index in h.states)) h.states[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [h.states[index], (update: unknown) => {
        const next = typeof update === "function" ? (update as (value: unknown) => unknown)(h.states[index]) : update;
        if (!Object.is(next, h.states[index])) h.dirty = true;
        h.states[index] = next;
      }];
    },
    useRef: (initial: unknown) => h.refs[h.refIndex++] ??= { current: initial },
    useLayoutEffect: () => {},
    useEffect: (effect: () => unknown, deps?: readonly unknown[]) => {
      const index = h.effectIndex++, previous = h.dependencies[index];
      if (!previous || !deps || deps.some((value, offset) => !Object.is(value, previous[offset]))) {
        h.dependencies[index] = deps; h.queued.push(effect);
      }
    },
  };
});
vi.mock("@heroui/react", () => ({ TextArea: (props: NonNullable<typeof h.field>) => {
  h.field = props; return <textarea value={props.value} readOnly />;
} }));
vi.mock("@/components/HeroButton", () => ({ HeroButton: (props: { children?: ReactNode; onPress?: () => void; "aria-label"?: string }) => {
  if (props["aria-label"]) h.buttons.set(props["aria-label"], props);
  return <button aria-label={props["aria-label"]}>{props.children}</button>;
} }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/TianshuMark", () => ({ TianshuMark: () => null }));
vi.mock("./references", () => ({ ReferenceTray: () => null }));
vi.mock("./ConversationAttachments", () => ({ AttachButton: () => null, AttachmentStatus: () => null }));

import { ConversationDock } from "./ConversationDock";
import { ConversationHistorySheet } from "./ConversationHistorySheet";
import { ConversationHistoryState } from "./ConversationHistoryState";

const LONG_ANSWER = [
  "先说结论：本月应先保灯塔交付，再推 TokenOps。",
  "",
  "理由有三点：",
  "",
  "1. 灯塔已签约，延期会直接影响回款。",
  "2. TokenOps 仍在验证付费意愿。",
  "3. 交付团队只有一组可调。",
  "",
  "待一号位确认的事：",
  "",
  "- 是否同意把两名工程师调往灯塔",
  "- 是否接受 TokenOps 演示推迟两周",
  "",
  "如果都同意，我会把调整写进本周议题。",
].join("\n");
const DRAFT_KEY = "tianshu-conversation-draft-v1:global";

function conversation(patch: Partial<ConversationData> = {}): ConversationData {
  const messages: Message[] = [
    { sequence: 1, role: "user", content: "本月交付力量先给谁？" },
    { sequence: 2, role: "assistant", content: LONG_ANSWER },
  ];
  return { scope: "global", messages, status: "complete", streaming: false, partial: "", stage: "answering", startedAt: 0, error: null,
    lastReply: { text: LONG_ANSWER, ms: 9000 }, historyStatus: "ready", historyError: null, retryHistory: vi.fn(),
    attachments: [{ id: "att-1", fileName: "交付排期.pdf", mimeType: "application/pdf" }], uploading: false, attachmentError: null,
    uploadFiles: vi.fn(), removeAttachment: vi.fn(), send: vi.fn().mockResolvedValue(true), stop: vi.fn(), viewingMaterialEditable: false,
    ...patch } as unknown as ConversationData;
}

/** 渲染到状态稳定（effect 改了状态就再渲染一遍）。 */
function settle(element: () => ReactElement) {
  for (let pass = 0; pass < 6; pass++) {
    h.stateIndex = 0; h.refIndex = 0; h.effectIndex = 0; h.queued = []; h.dirty = false; h.buttons.clear();
    const html = renderToStaticMarkup(element());
    h.queued.forEach((effect) => effect());
    if (!h.dirty) return html;
  }
  throw new Error("did not settle");
}

beforeEach(() => {
  h.states = []; h.refs = []; h.dependencies = []; h.storage.clear(); h.field = null;
  vi.stubGlobal("localStorage", { getItem: (key: string) => h.storage.get(key) ?? null, setItem: (key: string, value: string) => h.storage.set(key, value), removeItem: (key: string) => h.storage.delete(key) });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe("长回答：对话层里读完整回答 → 收起（第 24 项，D6 之后没有外置气泡）", () => {
  it("回答只在对话层里，按 Markdown 显示段落与列表；收起后输入条回到胶囊，草稿和待发附件都在", () => {
    h.storage.set(DRAFT_KEY, "我还想追问回款节奏");
    const data = conversation();
    const props: ComponentProps<typeof ConversationDock> = { data, label: "天枢", global: true, detail: false, keyboard: true, onKeyboardChange: vi.fn(),
      historyOpen: true, references: [], onRemoveReference: vi.fn(), onClearReferences: vi.fn(), onRestoreReferences: vi.fn() };
    const dock = () => <ConversationDock {...props} />;

    // 1. 打字面（对话层开着）：输入框里是这条对话的草稿；输入条上方不再有气泡。
    let html = settle(dock);
    expect(html).not.toContain("先说结论");
    expect(html).not.toContain("关闭本次对话气泡");
    expect(h.field!.value).toBe("我还想追问回款节奏");

    // 2. 对话层：同一份消息，段落、有序列表、无序列表都按格式显示。
    const close = vi.fn();
    const dockSlots = { states: h.states, refs: h.refs, dependencies: h.dependencies };
    h.states = []; h.refs = []; h.dependencies = [];
    const sheet = settle(() => <ConversationHistorySheet data={data} label="天枢" global onClose={close} />);
    Object.assign(h, dockSlots);
    expect(sheet).not.toContain("仅你可见");
    expect(sheet).toContain('data-conversation-owner="global"');
    expect(sheet).toContain("<p>先说结论：本月应先保灯塔交付，再推 TokenOps。</p>");
    expect(sheet).toMatch(/<ol>[\s\S]*<li>灯塔已签约，延期会直接影响回款。<\/li>[\s\S]*<li>交付团队只有一组可调。<\/li>[\s\S]*<\/ol>/);
    expect(sheet).toMatch(/<ul>[\s\S]*<li>是否同意把两名工程师调往灯塔<\/li>[\s\S]*<\/ul>/);
    expect(sheet).toContain("如果都同意，我会把调整写进本周议题。");
    expect(sheet).not.toContain("<header");
    expect(h.buttons.get("收起对话记录")?.onPress).toBe(close);

    // 3. 收起：输入条回到胶囊，草稿与本地存储都还在，待发附件没被清，没有发出任何东西。
    props.historyOpen = false; props.keyboard = false;
    html = settle(dock);
    expect(html).toContain('data-composer="entry"');
    expect(html).not.toContain("先说结论");
    expect(h.field!.value).toBe("我还想追问回款节奏");
    expect(h.storage.get(DRAFT_KEY)).toBe("我还想追问回款节奏");
    expect(data.removeAttachment).not.toHaveBeenCalled();
    expect(data.send).not.toHaveBeenCalled();
  });
});

describe("历史没读到时的重试入口", () => {
  it("重试键调用 retryHistory，不碰发送", () => {
    const data = conversation({ messages: [], historyStatus: "error", historyError: "没有连上天枢服务，对话记录没读出来，可以点重试。" });
    const html = settle(() => <ConversationHistoryState data={data} empty={<p>暂无消息</p>} />);
    expect(html).toContain("对话记录没有载入，这不代表没有记录。");
    expect(html).not.toContain("暂无消息");
    h.buttons.get("重试载入对话记录")!.onPress!();
    expect(data.retryHistory).toHaveBeenCalledOnce();
    expect(data.send).not.toHaveBeenCalled();
  });
});
