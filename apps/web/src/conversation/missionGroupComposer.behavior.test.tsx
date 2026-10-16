import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps, ReactNode } from "react";
import type { ConversationData } from "./useConversation";

// A persistent hook frame plus captured real event callbacks: no DOM dependency is needed.
const harness = vi.hoisted(() => ({
  state: [] as unknown[], refs: [] as { current: unknown }[], effects: [] as (readonly unknown[] | undefined)[],
  queued: [] as (() => unknown)[], stateIndex: 0, refIndex: 0, effectIndex: 0, dirty: false,
  field: {} as {
    value: string; disabled?: boolean; placeholder: string;
    onChange: (event: { target: { value: string } }) => void;
    onCompositionStart: () => void; onCompositionEnd: () => void;
  },
  submit: (() => {}) as () => void,
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = harness.stateIndex++;
      if (!(index in harness.state)) harness.state[index] = typeof initial === "function" ? initial() : initial;
      return [harness.state[index], (update: unknown) => {
        const next = typeof update === "function" ? update(harness.state[index]) : update;
        if (!Object.is(next, harness.state[index])) harness.dirty = true;
        harness.state[index] = next;
      }];
    },
    useRef: (initial: unknown) => {
      const index = harness.refIndex++;
      return harness.refs[index] ??= { current: initial };
    },
    useEffect: (effect: () => unknown, dependencies?: readonly unknown[]) => {
      const index = harness.effectIndex++;
      const previous = harness.effects[index];
      if (!previous || !dependencies || dependencies.some((value, offset) => !Object.is(value, previous[offset]))) {
        harness.effects[index] = dependencies;
        harness.queued.push(effect);
      }
    },
  };
});
vi.mock("@heroui/react", () => ({ TextArea: (props: typeof harness.field) => {
  harness.field = props;
  return <textarea value={props.value} disabled={props.disabled} placeholder={props.placeholder} onChange={() => {}} />;
} }));
vi.mock("@/components/HeroButton", () => ({ HeroButton: ({ children, "aria-label": label }: { children?: ReactNode; "aria-label"?: string }) => <button aria-label={label}>{children}</button> }));
vi.mock("./ComposerPill", () => ({
  ComposerPill: (props: { onSubmit: () => void; references?: ReactNode; leading?: ReactNode; field: ReactNode; action: ReactNode }) => {
    harness.submit = props.onSubmit;
    return <form>{props.references}{props.leading}{props.field}{props.action}</form>;
  },
  ComposerAction: () => <button>发送</button>, ChannelSwitch: () => <span>频道</span>, usePillRows: () => 1, pillStyles: {},
}));
vi.mock("./ConversationColumn", () => ({ columnComposerClass: "composer", pressChannel: () => {} }));
vi.mock("./ConversationAttachments", () => ({ AttachButton: () => null }));

import { MissionGroupComposer } from "./MissionGroupComposer";
import { ColumnComposer } from "./ColumnComposer";

const storage = new Map<string, string>();
function remount() { harness.state = []; harness.refs = []; harness.effects = []; }
function render(element: ReactNode) {
  let html = "";
  for (let renders = 0; renders < 5; renders++) {
    harness.stateIndex = 0; harness.refIndex = 0; harness.effectIndex = 0;
    harness.queued = []; harness.dirty = false;
    html = renderToStaticMarkup(element);
    harness.queued.forEach((effect) => effect());
    if (!harness.dirty) return html;
  }
  throw new Error("Composer did not settle");
}
const reference = { missionId: "mission-01", field: "why", quote: "关键依据", sourceVersion: 1, nonce: 1 } as const;
function groupProps(overrides: Partial<ComponentProps<typeof MissionGroupComposer>> = {}): ComponentProps<typeof MissionGroupComposer> {
  return { cardId: "card-01", viewerId: "member", phase: "open", channels: [], channel: "group", onChannel: vi.fn(), narrow: false, mobileOpen: false, onMobileOpen: vi.fn(), onHeightChange: vi.fn(), reference: null, onRemoveReference: vi.fn(), busy: false, onSend: vi.fn().mockResolvedValue(false), ...overrides };
}
function group(props: ComponentProps<typeof MissionGroupComposer>) { return render(<MissionGroupComposer {...props} />); }
function type(text: string) { harness.field.onChange({ target: { value: text } }); }
function agent(viewerId = "member") {
  const data = { scope: "mission-card:card-01", streaming: false, attachments: [], send: vi.fn().mockResolvedValue(false), stop: vi.fn() } as unknown as ConversationData;
  return render(<ColumnComposer data={data} label="任务卡" channels={[]} channel="agent" onChannel={() => {}} narrow={false} mobileOpen={false} onMobileOpen={() => {}} references={[]} onHeightChange={() => {}} draftOwnerId={viewerId} allowAttachments={false} />);
}

beforeEach(() => {
  remount(); storage.clear(); vi.clearAllMocks();
  vi.stubGlobal("localStorage", { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value), removeItem: (key: string) => storage.delete(key) });
  vi.stubGlobal("requestAnimationFrame", (callback: () => void) => { callback(); return 1; });
  vi.stubGlobal("cancelAnimationFrame", () => {});
});
afterEach(() => vi.unstubAllGlobals());

describe("任务卡群组输入行为", () => {
  it("按人和卡恢复草稿，切换身份或卡片看不到另一份输入", () => {
    const mine = groupProps(); group(mine); type("成员在第一张卡的意见");
    remount(); group(groupProps({ viewerId: "ceo" })); expect(harness.field.value).toBe(""); type("CEO 的草稿");
    remount(); group(groupProps({ cardId: "card-02" })); expect(harness.field.value).toBe(""); type("第二张卡的草稿");
    remount(); group(mine); expect(harness.field.value).toBe("成员在第一张卡的意见");
    remount(); group(groupProps({ viewerId: "ceo" })); expect(harness.field.value).toBe("CEO 的草稿");
  });

  it("同一人同一卡在事项群组与天枢间切换，分别保留公开与私聊草稿", () => {
    const props = groupProps(); group(props); type("准备公开讨论");
    remount(); agent(); expect(harness.field.value).toBe(""); type("仅自己梳理风险");
    remount(); group(props); expect(harness.field.value).toBe("准备公开讨论");
    remount(); agent(); expect(harness.field.value).toBe("仅自己梳理风险");
    remount(); agent("ceo"); expect(harness.field.value).toBe("");
  });

  it("发送失败保留原输入与引用，重新挂载后仍可恢复草稿", async () => {
    const props = groupProps({ reference }); group(props); type("  引用这段再核对一次  "); group(props);
    harness.submit(); await Promise.resolve();
    expect(props.onSend).toHaveBeenCalledExactlyOnceWith("引用这段再核对一次", reference);
    const html = group(props);
    expect(harness.field.value).toBe("  引用这段再核对一次  ");
    expect(html).toContain("关键依据"); expect(props.onRemoveReference).not.toHaveBeenCalled();
    remount(); group(props); expect(harness.field.value).toBe("  引用这段再核对一次  ");
  });

  it("服务端接收后清空输入与引用，等待期间连续提交只发一次", async () => {
    let accepted!: (ok: boolean) => void;
    const props = groupProps({ reference, onSend: vi.fn().mockImplementation(() => new Promise<boolean>((resolve) => { accepted = resolve; })) });
    group(props); type("请一起核对"); group(props);
    harness.submit(); harness.submit();
    expect(props.onSend).toHaveBeenCalledTimes(1);
    group(props); expect(harness.field.value).toBe("请一起核对");
    accepted(true); await Promise.resolve();
    group(props); expect(harness.field.value).toBe(""); expect(props.onRemoveReference).toHaveBeenCalledOnce();
    remount(); group(props); expect(harness.field.value).toBe("");
  });

  it("草稿和已确定阶段即使触发表单也拒绝发送，开放与截止后可以发送", async () => {
    for (const phase of ["draft", "open", "closed", "reviewing", "confirmed"] as const) {
      remount(); const props = groupProps({ phase }); group(props); type("需要保留的意见"); group(props);
      const allowed = phase !== "draft" && phase !== "confirmed";
      expect(Boolean(harness.field.disabled)).toBe(!allowed);
      harness.submit(); await Promise.resolve();
      expect(props.onSend).toHaveBeenCalledTimes(allowed ? 1 : 0);
      group(props); expect(harness.field.value).toBe("需要保留的意见");
      if (phase === "closed" || phase === "reviewing") expect(harness.field.placeholder).toContain("汇总后留言");
    }
  });

  it("中文组词尚未结束时不发送，组词结束后才能提交", async () => {
    const props = groupProps(); group(props); type("中文意见"); group(props);
    harness.field.onCompositionStart(); harness.submit();
    expect(props.onSend).not.toHaveBeenCalled();
    harness.field.onCompositionEnd(); harness.submit(); await Promise.resolve();
    expect(props.onSend).toHaveBeenCalledExactlyOnceWith("中文意见", null);
  });
});
