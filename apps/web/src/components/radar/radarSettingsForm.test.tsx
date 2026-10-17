import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// 编辑器容器照 welcome.test 的办法：保留真实的保存与扫描逻辑，只代替状态、ref 与 effect。
const hooks = vi.hoisted(() => {
  let active = false;
  let slots: unknown[] = [];
  let cursor = 0;
  return {
    get active() { return active; },
    begin() { active = true; cursor = 0; },
    reset() { active = false; slots = []; cursor = 0; },
    useState<T>(initial: T | (() => T)) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [slots[index] as T, (value: T | ((previous: T) => T)) => {
        slots[index] = typeof value === "function" ? (value as (previous: T) => T)(slots[index] as T) : value;
      }] as const;
    },
    useRef<T>(initial: T) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index] as { current: T };
    },
  };
});
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial?: unknown) => hooks.active ? hooks.useState(initial) : react.useState(initial),
    useRef: (...args: Parameters<typeof react.useRef>) => hooks.active ? hooks.useRef(args[0]) : react.useRef(...args),
    useCallback: (...args: Parameters<typeof react.useCallback>) => hooks.active ? args[0] : react.useCallback(...args),
    useEffect: (...args: Parameters<typeof react.useEffect>) => hooks.active ? undefined : react.useEffect(...args),
    useId: () => (hooks.active ? ":t:" : react.useId()),
  };
});
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
const api = vi.hoisted(() => ({ GET: vi.fn(), PUT: vi.fn(), POST: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ browserApi: api }));

import {
  DIRECTION_PLACEHOLDER,
  RadarSettingsForm,
  SOURCE_PLACEHOLDER,
  draftFrom,
  type RadarDraft,
  type RadarSettingsView,
} from "./RadarSettingsForm";
import { RadarSettingsEditor } from "./RadarSettingsEditor";

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
const find = (tree: ReactNode, predicate: (element: Element) => boolean) => {
  const match = elements(tree).find(predicate);
  expect(match).toBeDefined();
  return match!;
};

const feed = (value: string, name: string) => ({ value, name, kind: "feed" as const, note: "订阅源" });
const SITE_NOTE = "全网检索后按域名筛，结果可能很少";
const view: RadarSettingsView = {
  enabled: false,
  directions: [],
  sources: [],
  saved: false,
  webSearch: true,
  suggestions: {
    directions: [{ text: "灯塔客户的首次经营判断", from: "灯塔项目" }, { text: "Agent 定价", from: "10 月讨论候选" }],
    sources: [feed("ft.com", "金融时报"), feed("qbitai.com", "量子位"), { value: "36kr.com", name: "36氪", kind: "site", note: SITE_NOTE }],
  },
  automatic: [],
};
const idle = { loading: false, loadError: null, saving: false, saveError: null, saved: null, scan: null };

function props(overrides: Partial<Parameters<typeof RadarSettingsForm>[0]> = {}) {
  return {
    mode: "person" as const,
    idPrefix: "t",
    view,
    draft: draftFrom(view),
    onDraft: vi.fn(),
    errors: {},
    status: idle,
    submitLabel: "保存",
    onSubmit: vi.fn(),
    onReload: vi.fn(),
    ...overrides,
  };
}
const draft = (patch: Partial<RadarDraft>): RadarDraft => ({ ...draftFrom(view), enabled: true, ...patch });
const html = (overrides: Partial<Parameters<typeof RadarSettingsForm>[0]> = {}) => renderToStaticMarkup(<RadarSettingsForm {...props(overrides)} />);
const submit = (markup: string) => markup.slice(markup.lastIndexOf("<button", markup.indexOf("data-radar-submit")), markup.indexOf(">", markup.indexOf("data-radar-submit")));
/** 把表单交给 onDraft 的更新函数作用到当前草稿上。 */
function applied(onDraft: ReturnType<typeof vi.fn>, current: RadarDraft): RadarDraft {
  return onDraft.mock.calls.reduce((next, [update]) => (update as (value: RadarDraft) => RadarDraft)(next), current);
}
function keyEvent(key: string, patch: { isComposing?: boolean; keyCode?: number } = {}) {
  return { key, keyCode: patch.keyCode ?? 13, repeat: false, nativeEvent: { isComposing: Boolean(patch.isComposing) }, preventDefault: vi.fn(), stopPropagation: vi.fn() };
}

afterEach(() => {
  hooks.reset();
  vi.unstubAllGlobals();
});

describe("雷达设置表单（spec §4.2）", () => {
  it("先方向、后来源；占位只给例子；来源写明可不填，不写全网检索的说明", () => {
    expect(DIRECTION_PLACEHOLDER).toBe("比如「1 号位产品的设计」");
    expect(SOURCE_PLACEHOLDER).toBe("粘贴网址，或选常用来源");
    const markup = html({ draft: draft({}) });
    expect(markup).toContain(`placeholder="${DIRECTION_PLACEHOLDER}"`);
    expect(markup).toContain(`placeholder="${SOURCE_PLACEHOLDER}"`);
    expect(markup.indexOf(DIRECTION_PLACEHOLDER)).toBeLessThan(markup.indexOf(SOURCE_PLACEHOLDER));
    expect(markup).toContain("可不填");
    expect(markup).not.toContain("不填时，按你的方向在全网检索。");
  });

  it("成员最上面是「开启雷达」开关，关着只露一句说明、两栏收起；CEO 没有开关，写明改的是公司雷达", () => {
    const off = html();
    expect(off).toContain('role="switch"');
    expect(off).toContain('aria-checked="false"');
    expect(off).toContain("开启雷达");
    expect(off).toContain("仅你可见");
    expect(off).not.toContain("我每天按你的方向替你看一遍");
    expect(off).toMatch(/data-open="false" inert=""/);
    const on = html({ draft: draft({}) });
    expect(on).toContain('aria-checked="true"');
    expect(on).not.toContain("inert");
    const company = html({ mode: "company", view: { ...view, enabled: true, saved: true, automatic: ["完成灯塔客户验证", "复议：定价是否下调"] }, draft: draftFrom({ ...view, enabled: true }) });
    expect(company).not.toContain('role="switch"');
    expect(company).toContain("这里改的是公司雷达");
    expect(company).toContain("完成灯塔客户验证");
    expect(company).toContain("只读");
  });

  it("开着但没有方向：保存键按不下去并说明；输入框里写了一句就能保存", () => {
    const blocked = html({ draft: draft({}) });
    expect(submit(blocked)).toContain("disabled");
    expect(blocked).toContain("开启雷达至少要写一条方向");
    expect(submit(html({ draft: draft({ directionText: "1 号位产品的设计" }) }))).not.toContain("disabled");
    expect(submit(html())).not.toContain("disabled"); // 关着也可以保存（记下「不开」）
    expect(submit(html({ view: null, status: { ...idle, loading: true } }))).toContain("disabled");
  });

  it("方向按字符显示 n/40，超了标红；满 5 条方向、满 10 个来源时输入框禁用并说明", () => {
    const over = html({ draft: draft({ directionText: "字".repeat(41) }) });
    expect(over).toContain("41/40");
    expect(over).toContain("每条最多 40 个字，现在 41 个");
    expect(html({ draft: draft({ directionText: "🙂".repeat(3) }) })).toContain("3/40");
    const full = html({ draft: draft({ directions: ["一", "二", "三", "四", "五"], sources: Array.from({ length: 10 }, (_, index) => `site${index}.com`) }) });
    expect(full).toContain("最多 5 条方向；删掉一条才能再加");
    expect(full).toContain("最多 10 个来源；删掉一个才能再加");
    expect(full.match(/<(?:input|textarea)[^>]*disabled=""/g)).toHaveLength(2);
    expect(full).not.toContain("可能相关");
  });

  it("选中的是胶囊、建议是另一行；已选中的建议不再出现；来源建议按读法分组写明", () => {
    const markup = html({ draft: draft({ directions: ["灯塔客户的首次经营判断"], sources: ["ft.com"] }) });
    expect(markup).toContain('aria-label="删除方向：灯塔客户的首次经营判断"');
    expect(markup).not.toContain("加上方向：灯塔客户的首次经营判断");
    expect(markup).toContain("加上方向：Agent 定价（来自10 月讨论候选）");
    expect(markup).not.toContain("加上来源：金融时报");
    expect(markup).toContain("加上来源：量子位（订阅源）");
    expect(markup).toContain(SITE_NOTE);
    // 胶囊下一行写服务端给的读法
    expect(markup).toContain("金融时报 · 订阅源");
  });

  it("点建议就加上；回车加方向但不提交；中文输入法组词时的回车不算", () => {
    const onDraft = vi.fn();
    const onSubmit = vi.fn();
    const current = draft({ directionText: "大模型应用的定价" });
    const tree = RadarSettingsForm(props({ draft: current, onDraft, onSubmit }));
    const input = find(tree, (element) => element.type === "textarea" && element.props["aria-label"] === "写一条方向");
    const composing = keyEvent("Enter", { isComposing: true, keyCode: 229 });
    (input.props.onKeyDown as (event: unknown) => void)(composing);
    const legacyIme = keyEvent("Enter", { keyCode: 229 });
    (input.props.onKeyDown as (event: unknown) => void)(legacyIme);
    expect(onDraft).not.toHaveBeenCalled();
    expect(composing.preventDefault).not.toHaveBeenCalled();
    const enter = keyEvent("Enter");
    (input.props.onKeyDown as (event: unknown) => void)(enter);
    expect(enter.preventDefault).toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(applied(onDraft, current)).toMatchObject({ directions: ["大模型应用的定价"], directionText: "" });
    onDraft.mockClear();
    const suggestion = find(tree, (element) => element.type === "button" && element.props["aria-label"] === "加上来源：量子位（订阅源）");
    (suggestion.props.onClick as () => void)();
    expect(applied(onDraft, current).sources).toEqual(["qbitai.com"]);
    onDraft.mockClear();
    // 点建议不动输入框里正在写的那句
    const idea = find(tree, (element) => element.type === "button" && element.props["aria-label"] === "加上方向：Agent 定价（来自10 月讨论候选）");
    (idea.props.onClick as () => void)();
    expect(applied(onDraft, current)).toMatchObject({ directions: ["Agent 定价"], directionText: "大模型应用的定价" });
  });

  it("来源：认出网址或域名才变成胶囊；粘贴几个网址直接变成几个胶囊", () => {
    const onDraft = vi.fn();
    const words = draft({ sourceText: "金融时报" });
    let input = find(RadarSettingsForm(props({ draft: words, onDraft })), (element) => element.props["aria-label"] === "加一个来源网址");
    (input.props.onKeyDown as (event: unknown) => void)(keyEvent("Enter"));
    expect(onDraft).not.toHaveBeenCalled();
    expect(html({ draft: words })).toContain("写成网址或域名，比如 ft.com");
    const url = draft({ sourceText: "https://www.ft.com/world?x=1" });
    input = find(RadarSettingsForm(props({ draft: url, onDraft })), (element) => element.props["aria-label"] === "加一个来源网址");
    (input.props.onKeyDown as (event: unknown) => void)(keyEvent("Enter"));
    expect(applied(onDraft, url).sources).toEqual(["https://www.ft.com/world?x=1"]);
    onDraft.mockClear();
    const paste = { currentTarget: { value: "" }, clipboardData: { getData: () => "ft.com\n36kr.com/p/1" }, preventDefault: vi.fn() };
    (input.props.onPaste as (event: unknown) => void)(paste);
    expect(paste.preventDefault).toHaveBeenCalled();
    expect(applied(onDraft, draft({})).sources).toEqual(["ft.com", "36kr.com/p/1"]);
  });

  it("fieldErrors 标在对应胶囊上；全部来源都暂不支持时当场提示；全网检索没开通时不写说明，来源也不再标可不填", () => {
    const markup = html({
      view: { ...view, sources: [{ value: "github.com/trending", name: "GitHub Trending", kind: "unsupported", note: "榜单读取器还在开发，暂不支持" }] },
      draft: draft({ directions: ["!!!"], sources: ["github.com/trending"] }),
      errors: { "directions:!!!": "方向要写成一句话" },
    });
    expect(markup).toMatch(/data-invalid="true"[^]*方向要写成一句话/);
    expect(markup).toContain("GitHub Trending · 榜单读取器还在开发，暂不支持");
    expect(markup).toContain("这些来源暂时都读不了");
    const noWeb = html({ view: { ...view, webSearch: false }, draft: draft({}) });
    expect(noWeb).not.toContain("全网检索暂未开通");
    expect(noWeb).not.toContain("可不填");
  });

  it("「设置已保存」与扫描状态分两行；引导传「稍后」时才有它", () => {
    const markup = html({ draft: draft({ directions: ["方向"] }), status: { ...idle, saved: "设置已保存", scan: { tone: "info", text: "已在后台扫描" } } });
    expect(markup).toMatch(/<p[^>]*>.*设置已保存<\/p><p[^>]*>已在后台扫描<\/p>/);
    expect(markup).not.toContain("稍后");
    expect(html({ onLater: vi.fn() })).toContain("稍后");
  });
});

describe("雷达设置编辑器：保存与扫描", () => {
  const myRadar = {
    enabled: false, directions: [], sources: [], updatedAt: null, lastRun: null, unreadCount: 0, webSearch: true,
    suggestions: { directions: [], sources: [feed("ft.com", "金融时报")] },
  };
  const savedRadar = { ...myRadar, enabled: true, directions: [{ id: "d_1", text: "1 号位产品的设计" }], sources: [feed("ft.com", "金融时报")], updatedAt: "2026-09-27T02:00:00.000Z" };
  const ok = (data: unknown, status = 200) => ({ data, response: { ok: status < 300, status } });
  const failure = (status: number, error: unknown) => ({ error, response: { ok: false, status } });

  function render(editorProps: Parameters<typeof RadarSettingsEditor>[0]) {
    hooks.begin();
    return RadarSettingsEditor(editorProps) as unknown as ReactElement<Parameters<typeof RadarSettingsForm>[0]>;
  }
  async function loaded(editorProps: Parameters<typeof RadarSettingsEditor>[0]) {
    await render(editorProps).props.onReload();
    await vi.waitFor(() => expect(render(editorProps).props.view).not.toBeNull());
    return render(editorProps);
  }
  async function saveWith(editorProps: Parameters<typeof RadarSettingsEditor>[0], change: (current: RadarDraft) => RadarDraft) {
    const form = await loaded(editorProps);
    form.props.onDraft(change);
    render(editorProps).props.onSubmit();
  }

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("window", { dispatchEvent: vi.fn(), location: { assign: vi.fn(), pathname: "/welcome", search: "" } });
  });

  it("成员：先存设置、马上回调（引导不等扫描），再在后台扫一次；202 写「已在后台扫描」，与「设置已保存」分开", async () => {
    api.GET.mockResolvedValue(ok(myRadar));
    api.PUT.mockResolvedValue(ok(savedRadar));
    let release!: (value: unknown) => void;
    api.POST.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const onSaved = vi.fn();
    const editorProps = { mode: "person" as const, submitLabel: "保存并继续", onSaved };
    await saveWith(editorProps, (current) => ({ ...current, enabled: true, directionText: "1 号位产品的设计 " }));
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledExactlyOnceWith({ enabled: true, directions: 1, sources: 1 }));
    expect(api.PUT).toHaveBeenCalledExactlyOnceWith("/api/me/radar", { body: { enabled: true, directions: ["1 号位产品的设计"], sources: [] } });
    expect(api.POST).toHaveBeenCalledExactlyOnceWith("/api/me/radar/scan");
    const saved = render(editorProps).props;
    expect(saved.status.saved).toBe("设置已保存");
    expect(saved.status.scan).toBeNull();
    // 胶囊换成服务端返回的规范值
    expect(saved.draft.sources).toEqual(["ft.com"]);
    release(ok({ queued: true }, 202));
    await vi.waitFor(() => expect(render(editorProps).props.status.scan).toEqual({ tone: "info", text: "已在后台扫描" }));
    expect(router.refresh).not.toHaveBeenCalled();
  });

  it.each([
    [409, "今天已经收满 10 条"],
    [429, "10 分钟内只能手动扫描一次，请 6 分钟后再试"],
  ])("扫描返回 %s：原样写服务端的话，不当成错误", async (status, message) => {
    api.GET.mockResolvedValue(ok(myRadar));
    api.PUT.mockResolvedValue(ok(savedRadar));
    api.POST.mockResolvedValue(failure(status, { code: "X", message }));
    const editorProps = { mode: "person" as const };
    await saveWith(editorProps, (current) => ({ ...current, enabled: true, directions: ["1 号位产品的设计"] }));
    await vi.waitFor(() => expect(render(editorProps).props.status.scan).toEqual({ tone: "info", text: message }));
    expect(render(editorProps).props.status.saveError).toBeNull();
  });

  it("做过这一步、没有改动：不重复保存也不重复扫描，直接往下走（引导里「一下就能过」）", async () => {
    api.GET.mockResolvedValue(ok(savedRadar));
    const onSaved = vi.fn();
    const editorProps = { mode: "person" as const, submitLabel: "保存并继续", onSaved };
    await saveWith(editorProps, (current) => current);
    expect(onSaved).toHaveBeenCalledExactlyOnceWith({ enabled: true, directions: 1, sources: 1 });
    expect(api.PUT).not.toHaveBeenCalled();
    expect(api.POST).not.toHaveBeenCalled();
  });

  it("从「我的雷达」的「打开」进来：开关先拨到开，写一句方向就能保存", async () => {
    api.GET.mockResolvedValue(ok(myRadar));
    const form = await loaded({ mode: "person", enable: true });
    expect(form.props.draft.enabled).toBe(true);
    expect(form.props.view?.enabled).toBe(false);
    hooks.reset();
    expect((await loaded({ mode: "person" })).props.draft.enabled).toBe(false);
  });

  it("关着保存：只存设置，不扫描", async () => {
    api.GET.mockResolvedValue(ok(myRadar));
    api.PUT.mockResolvedValue(ok({ ...myRadar, updatedAt: "2026-09-27T02:00:00.000Z" }));
    const onSaved = vi.fn();
    const editorProps = { mode: "person" as const, onSaved };
    await saveWith(editorProps, (current) => current);
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledWith({ enabled: false, directions: 0, sources: 0 }));
    expect(api.POST).not.toHaveBeenCalled();
  });

  it("fieldErrors 按提交时的下标对回胶囊；保存失败不回调", async () => {
    api.GET.mockResolvedValue(ok(myRadar));
    api.PUT.mockResolvedValue(failure(400, { code: "RADAR_SOURCE_INVALID", message: "有来源读不了", fieldErrors: { "sources/1": "请填公开网站的域名" } }));
    const onSaved = vi.fn();
    const editorProps = { mode: "person" as const, onSaved };
    await saveWith(editorProps, (current) => ({ ...current, enabled: true, directions: ["方向"], sources: ["ft.com", "localhost.localdomain"] }));
    await vi.waitFor(() => expect(render(editorProps).props.errors).toEqual({ "sources:localhost.localdomain": "请填公开网站的域名" }));
    expect(render(editorProps).props.status.saveError).toBe("有来源读不了");
    expect(onSaved).not.toHaveBeenCalled();
    expect(api.POST).not.toHaveBeenCalled();
  });

  it("CEO：改的是公司雷达；保存后刷新页面数据，不触发扫描", async () => {
    const company = { directions: [], sources: [], automatic: ["完成灯塔客户验证"], webSearch: true, suggestions: { sources: [feed("theinformation.com", "The Information")] } };
    api.GET.mockResolvedValue(ok(company));
    api.PUT.mockResolvedValue(ok({ ...company, directions: [{ id: "manual:1", text: "大模型定价" }], sources: [feed("theinformation.com", "The Information")] }));
    const onSaved = vi.fn();
    const editorProps = { mode: "company" as const, onSaved };
    await saveWith(editorProps, (current) => ({ ...current, directions: ["大模型定价"], sources: ["theinformation.com"] }));
    await vi.waitFor(() => expect(onSaved).toHaveBeenCalledWith({ enabled: true, directions: 1, sources: 1 }));
    expect(api.GET).toHaveBeenCalledWith("/api/config/radar");
    expect(api.PUT).toHaveBeenCalledWith("/api/config/radar", { body: { directions: ["大模型定价"], sources: ["theinformation.com"] } });
    expect(router.refresh).toHaveBeenCalled();
    expect(api.POST).not.toHaveBeenCalled();
  });

  it("没登录（401）回锁屏并带上当前页面", async () => {
    api.GET.mockResolvedValue(failure(401, { code: "UNAUTHORIZED", message: "请先登录" }));
    await render({ mode: "person" }).props.onReload();
    expect(window.location.assign).toHaveBeenCalledWith("/access?next=%2Fwelcome");
  });
});
