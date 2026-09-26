import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ComponentProps, type ReactElement, type ReactNode, type Ref } from "react";

// Node 测试里保留组件事件处理器，模拟 ref/state；输入节点只实现值与焦点。
const hooks = vi.hoisted(() => {
  const scopes = new Map<string, unknown[]>();
  let slots: unknown[] = [];
  let cursor = 0;
  return {
    begin(scope: string) { slots = scopes.get(scope) ?? []; scopes.set(scope, slots); cursor = 0; },
    reset() { scopes.clear(); },
    useRef<T>(initial: T) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index] as { current: T };
    },
    useState<T>(initial: T) {
      const local = slots;
      const index = cursor++;
      if (!(index in local)) local[index] = initial;
      return [local[index] as T, (value: T) => { local[index] = value; }] as const;
    },
    useImperativeHandle<T>(ref: Ref<T> | undefined, create: () => T) {
      if (typeof ref === "function") ref(create());
      else if (ref) ref.current = create();
    },
  };
});
vi.mock("react", async (original) => ({ ...await original<typeof import("react")>(), ...hooks }));

import { AccessScreen } from "./AccessScreen";
import { PinField, type PinFieldHandle } from "./PinField";

type Element = ReactElement<Record<string, unknown>>;
type InputProps = ComponentProps<"input">;
let focused: string;
let fetchMock: ReturnType<typeof vi.fn>;
let replace: ReturnType<typeof vi.fn>;

function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}

function renderAccess() {
  hooks.begin("access");
  return AccessScreen({});
}

function pinProps(tree: ReactNode, label: string) {
  return elements(tree).find((element) => element.type === PinField && element.props.label === label)!.props as ComponentProps<typeof PinField>;
}

function mountPin(scope: string, props: ComponentProps<typeof PinField>) {
  hooks.begin(scope);
  const tree = PinField(props);
  const inputs = elements(tree).filter((element) => element.type === "input").map((element, index) => {
    const input = { value: "", focus: () => { focused = `${scope}:${index}`; } } as HTMLInputElement;
    const props = element.props as InputProps;
    if (typeof props.ref === "function") props.ref(input);
    return { input, props };
  });
  return {
    paste(value: string) {
      inputs[0].props.onPaste?.({ clipboardData: { getData: () => value }, preventDefault: vi.fn() } as unknown as React.ClipboardEvent<HTMLInputElement>);
    },
    erase(index: number) {
      inputs[index].input.value = "";
      inputs[index].props.onChange?.({ target: inputs[index].input } as React.ChangeEvent<HTMLInputElement>);
    },
    values: () => inputs.map(({ input }) => input.value).join(""),
  };
}

async function reachNewPasscode() {
  let tree = renderAccess();
  const id = elements(tree).find((element) => element.props.id === "access-id")!.props as InputProps;
  id.onChange?.({ target: { value: "test-member" } } as React.ChangeEvent<HTMLInputElement>);
  tree = renderAccess();
  mountPin("login", pinProps(tree, "口令")).paste("5678");
  await vi.advanceTimersByTimeAsync(0);
  tree = renderAccess();
  const fresh = mountPin("new", pinProps(tree, "新口令"));
  const confirm = mountPin("confirm", pinProps(tree, "确认口令"));
  return { fresh, confirm };
}

beforeEach(() => {
  vi.useFakeTimers();
  focused = "";
  fetchMock = vi.fn().mockResolvedValue(Response.json({ mustChangePasscode: true }));
  replace = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => setTimeout(() => callback(0), 16));
  vi.stubGlobal("window", { setTimeout: globalThis.setTimeout, matchMedia: () => ({ matches: false }), location: { replace } });
});

afterEach(() => {
  hooks.reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("口令输入与首次设定的事件回归", () => {
  it("输满新口令后，确认口令保持焦点，不被延后的原输入焦点抢回", async () => {
    const { fresh } = await reachNewPasscode();
    fresh.paste("1234");
    expect(focused).toBe("confirm:0");
    await vi.advanceTimersByTimeAsync(100);
    expect(focused).toBe("confirm:0");
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("缺少 ID 时清空 PIN，但下一帧仍停在 ID 输入框", async () => {
    const tree = renderAccess();
    const id = elements(tree).find((element) => element.props.id === "access-id")!.props as InputProps;
    (id.ref as { current: HTMLInputElement | null }).current = { focus: () => { focused = "id"; } } as HTMLInputElement;
    const pin = mountPin("login", pinProps(tree, "口令"));
    pin.paste("5678");
    expect(pin.values()).toBe("");
    expect(focused).toBe("id");
    await vi.advanceTimersByTimeAsync(20);
    expect(focused).toBe("id");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("新口令删掉一位后，确认曾经填满的旧值不能提交", async () => {
    const { fresh, confirm } = await reachNewPasscode();
    fresh.paste("1234");
    fresh.erase(3);
    confirm.paste("1234");
    await vi.advanceTimersByTimeAsync(20);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(confirm.values()).toBe("");
    expect(elements(renderAccess()).find((element) => element.props.id === "access-error")?.props.children).toBe("两次输入的口令不一致");
  });

  it("确认连续触发只提交一次，返回后仅执行一次引导导航", async () => {
    const { fresh, confirm } = await reachNewPasscode();
    let finish: ((response: Response) => void) | undefined;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { finish = resolve; }));
    fresh.paste("1234");
    confirm.paste("1234");
    confirm.paste("1234");
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toBe("/api/auth/passcode");
    expect(JSON.parse(fetchMock.mock.calls[1][1].body)).toEqual({ loginId: "test-member", passcode: "5678", newPasscode: "1234" });
    finish?.(Response.json({ role: "member", onboarded: false }));
    await vi.advanceTimersByTimeAsync(240);
    expect(replace).toHaveBeenCalledExactlyOnceWith("/welcome");
  });

  it("显式静默清空不移动焦点，普通清空仍回到第一位", async () => {
    const ref = { current: null as PinFieldHandle | null };
    mountPin("pin", { ref, label: "测试口令", onComplete: vi.fn() }).paste("1234");
    focused = "outside";
    ref.current?.clear(false);
    await vi.advanceTimersByTimeAsync(20);
    expect(focused).toBe("outside");
    expect(ref.current?.value()).toBe("");
    ref.current?.clear();
    await vi.advanceTimersByTimeAsync(20);
    expect(focused).toBe("pin:0");
  });
});
