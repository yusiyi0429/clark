import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TMissionCardAnnotationView } from "@warmap/contracts";
import type { ReactNode } from "react";
import { personalPayload } from "./personalMissionFixture";

const ui = vi.hoisted(() => ({ state: [] as unknown[], cursor: 0, refs: [] as { current: unknown }[], refCursor: 0,
  callbacks: [] as { value: unknown; deps: readonly unknown[] }[], callbackCursor: 0,
  effects: [] as (readonly unknown[] | undefined)[], effectCursor: 0,
  queued: [] as { index: number; run: () => void | (() => void) }[], cleanups: [] as (undefined | (() => void))[],
  writes: [] as { index: number; value: unknown }[],
}));
vi.mock("react", async (original) => {
  const actual = await original<typeof import("react")>();
  return { ...actual, useEffect: (effect: () => void | (() => void), deps?: readonly unknown[]) => {
    const index = ui.effectCursor++, previous = ui.effects[index];
    if (!previous || !deps || deps.some((dep, offset) => !Object.is(dep, previous[offset]))) {
      ui.effects[index] = deps; ui.queued.push({ index, run: effect });
    }
  }, useState: (initial: unknown) => {
    const index = ui.cursor++;
    if (!(index in ui.state)) ui.state[index] = initial;
    return [ui.state[index], (next: unknown) => { ui.state[index] = typeof next === "function" ? next(ui.state[index]) : next; ui.writes.push({ index, value: ui.state[index] }); }];
  }, useRef: (current: unknown) => ui.refs[ui.refCursor++] ??= { current }, useCallback: (callback: unknown, deps: readonly unknown[]) => {
    const index = ui.callbackCursor++, previous = ui.callbacks[index];
    if (!previous || deps.some((dep, offset) => !Object.is(dep, previous.deps[offset]))) ui.callbacks[index] = { value: callback, deps };
    return ui.callbacks[index].value;
  } };
});
vi.mock("react-dom", () => ({ createPortal: (children: ReactNode) => children }));
import { SelectionPopover, useMissionAnnotations, type AnnotationSelection } from "./MissionAnnotations";

const selection: AnnotationSelection = { mission: personalPayload.card.missions[0], field: "outcome", sourceText: "当前正文", sourceRound: 2, quote: "正文", prefix: "当前", suffix: "", startOffset: 2, range: {} as Range };
const note = { id: "annotation-one", status: "queued", body: "补上依据" } as TMissionCardAnnotationView;
const response = (annotation = note) => ({ ok: true, json: async () => ({ annotation }) });
beforeEach(() => {
  ui.state = []; ui.cursor = 0; ui.refs = []; ui.refCursor = 0; ui.callbacks = []; ui.callbackCursor = 0;
  ui.effects = []; ui.effectCursor = 0; ui.queued = []; ui.cleanups = []; ui.writes = [];
  vi.useFakeTimers();
  vi.stubGlobal("window", { innerHeight: 800, innerWidth: 390, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("document", { body: {}, visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() });
});
afterEach(() => { ui.cleanups.forEach((cleanup) => cleanup?.()); vi.useRealTimers(); vi.unstubAllGlobals(); });

function renderHook(cardId = "card", round = 1) {
  ui.cursor = 0; ui.refCursor = 0; ui.callbackCursor = 0; ui.effectCursor = 0;
  const hook = useMissionAnnotations(cardId, round);
  const queued = ui.queued.splice(0);
  queued.forEach(({ index, run }) => { ui.cleanups[index]?.(); const cleanup = run(); ui.cleanups[index] = typeof cleanup === "function" ? cleanup : undefined; });
  return hook;
}
const tick = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}
const snapshot = (annotations: TMissionCardAnnotationView[] = [], revisions: unknown[] = []) => ({ ok: true, json: async () => ({ annotations, revisions }) });

describe("直接批注的阶段与审核权限", () => {
  it("选区冻结来源审核编号，之后页面重开也不能改用新编号；不向会话发送", async () => {
    const fetchMock = vi.fn().mockResolvedValue(response()); vi.stubGlobal("fetch", fetchMock);
    const annotations = useMissionAnnotations("card", 3);
    expect(await annotations.save(selection, "补上依据", "client-id")).toBeNull();
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/mission-cards/card/annotations");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toMatchObject({ sourceRound: 2, sourceVersion: 1, body: "补上依据", quote: "正文" });
    expect(ui.state[0]).toEqual([note]);
  });
  it("保留备注提交完整原因，成功更新为no_change，不删除原批注", async () => {
    const saved = { ...note, status: "no_change", note: "范围暂未确认，下月核验", canResolve: false } as TMissionCardAnnotationView;
    const fetchMock = vi.fn().mockResolvedValueOnce(response(saved)).mockResolvedValue({ ok: true, json: async () => ({ annotations: [saved], revisions: [] }) });
    vi.stubGlobal("fetch", fetchMock);
    const annotations = useMissionAnnotations("card"); ui.state[0] = [note];
    expect(await annotations.resolve(note.id, saved.note!)).toBeNull();
    expect(fetchMock.mock.calls[0][0]).toBe("/api/mission-cards/card/annotations/annotation-one/resolve");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({ reason: "范围暂未确认，下月核验" });
    expect(ui.state[0]).toEqual([saved]);
  });
  it("保存前开始的旧轮询不能覆盖刚保存的批注", async () => {
    let finish!: (value: unknown) => void;
    const fetchMock = vi.fn().mockReturnValueOnce(new Promise((resolve) => { finish = resolve; })).mockResolvedValueOnce(response());
    vi.stubGlobal("fetch", fetchMock);
    const annotations = useMissionAnnotations("card");
    const old = annotations.refresh();
    await annotations.save(selection, "补上依据", "client-id");
    finish({ ok: true, json: async () => ({ annotations: [], revisions: [] }) }); await old;
    expect(ui.state[0]).toEqual([note]);
  });
  it("POST期间开始的旧GET在保存完成后返回，也不能删除刚保存的批注", async () => {
    const post = deferred<ReturnType<typeof response>>(), duringWrite = deferred<ReturnType<typeof snapshot>>();
    const fetchMock = vi.fn().mockReturnValueOnce(post.promise).mockReturnValueOnce(duringWrite.promise);
    vi.stubGlobal("fetch", fetchMock);
    const annotations = useMissionAnnotations("card");
    const save = annotations.save(selection, "补上依据", "client-id");
    const poll = annotations.refresh();
    expect(ui.state[3]).toBe(true);
    post.resolve(response()); await save;
    duringWrite.resolve(snapshot([], [{ id: "old-revision" }])); await poll;
    expect(ui.state[0]).toEqual([note]);
    expect(ui.state[1]).toEqual([]);
    expect(ui.state[3]).toBe(false);
  });
  it.each(["answer", "retry", "resolve"] as const)("%s成功后不能被写入期间的旧快照覆盖，原批注与新状态都保留", async (action) => {
    const post = deferred<ReturnType<typeof response>>(), duringWrite = deferred<ReturnType<typeof snapshot>>();
    const changed = { ...note, status: "no_change", note: "保留范围备注" } as TMissionCardAnnotationView;
    const fetchMock = vi.fn().mockReturnValueOnce(post.promise).mockReturnValueOnce(duringWrite.promise).mockResolvedValue(snapshot([changed], [{ id: "latest-revision" }]));
    vi.stubGlobal("fetch", fetchMock);
    const annotations = useMissionAnnotations("card"); ui.state[0] = [note];
    const mutation = action === "retry" ? annotations.retry(note.id) : action === "answer" ? annotations.answer(note.id, "按截图核验") : annotations.resolve(note.id, "保留范围备注");
    const poll = annotations.refresh();
    post.resolve(response(changed)); expect(await mutation).toBeNull(); await tick();
    duringWrite.resolve(snapshot([note], [{ id: "old-revision" }])); await poll;
    expect(ui.state[0]).toEqual([changed]);
    expect(ui.state[1]).toEqual([{ id: "latest-revision" }]);
    expect(ui.state[3]).toBe(false);
  });
  it.each([false, true])("后发GET已更新后，较早GET的%s结果不能回退批注、记录或错误", async (fails) => {
    const first = deferred<ReturnType<typeof snapshot>>(), second = deferred<ReturnType<typeof snapshot>>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));
    const annotations = useMissionAnnotations("card");
    const earlier = annotations.refresh(), later = annotations.refresh();
    const applied = { ...note, status: "applied" } as TMissionCardAnnotationView;
    second.resolve(snapshot([applied], [{ id: "latest" }])); await later;
    if (fails) first.reject(new Error("old network failure")); else first.resolve(snapshot([note], [{ id: "old" }]));
    await earlier;
    expect(ui.state[0]).toEqual([applied]); expect(ui.state[1]).toEqual([{ id: "latest" }]); expect(ui.state[2]).toBe("");
  });
  it("不同批注并行保存时直到所有请求完成才解除pending，两个结果都保留", async () => {
    const first = deferred<ReturnType<typeof response>>(), second = deferred<ReturnType<typeof response>>();
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise));
    const annotations = useMissionAnnotations("card");
    const one = annotations.save(selection, "第一条", "client-one"), two = annotations.save(selection, "第二条", "client-two");
    first.resolve(response(note)); await one;
    expect(ui.state[3]).toBe(true);
    const next = { ...note, id: "annotation-two", body: "第二条" };
    second.resolve(response(next)); await two;
    expect(ui.state[0]).toEqual([note, next]); expect(ui.state[3]).toBe(false);
  });
  it("同一批注先重试后保留备注，迟到的重试响应不会回退已经保存的备注", async () => {
    const retry = deferred<ReturnType<typeof response>>(), resolve = deferred<ReturnType<typeof response>>();
    const preserved = { ...note, status: "no_change", note: "暂不改正文" } as TMissionCardAnnotationView;
    vi.stubGlobal("fetch", vi.fn().mockReturnValueOnce(retry.promise).mockReturnValueOnce(resolve.promise).mockResolvedValue(snapshot([preserved])));
    const annotations = useMissionAnnotations("card"); ui.state[0] = [note];
    const first = annotations.retry(note.id), second = annotations.resolve(note.id, "暂不改正文");
    resolve.resolve(response(preserved)); await second; await tick(); ui.writes = [];
    retry.resolve(response(note)); await first; await tick();
    expect(ui.state[0]).toEqual([preserved]);
    expect(ui.writes.filter((write) => write.index === 0).every((write) => (write.value as TMissionCardAnnotationView[])[0].status === "no_change")).toBe(true);
  });
  it.each(["save", "resolve"] as const)("切换卡后旧%s结果不会进入新卡，也不会解冻新卡正在提交的控件", async (action) => {
    const oldPost = deferred<ReturnType<typeof response>>(), nextPost = deferred<ReturnType<typeof response>>();
    const other = { ...note, id: "other-card-note", cardId: "other-card" };
    const fetchMock = vi.fn((url: string, init?: { method?: string }) => init?.method === "POST" ? url.startsWith("/api/mission-cards/other-card/") ? nextPost.promise : oldPost.promise : Promise.resolve(snapshot(url.startsWith("/api/mission-cards/other-card/") ? [other] : [note])));
    vi.stubGlobal("fetch", fetchMock);
    const previous = renderHook("card"); await tick();
    const oldMutation = action === "save" ? previous.save(selection, "旧卡意见", "old-client") : previous.resolve(note.id, "旧卡备注");
    const current = renderHook("other-card"); await tick();
    const newMutation = current.save(selection, "新卡意见", "new-client");
    oldPost.resolve(response(note)); expect(await oldMutation).toContain("任务卡已关闭或切换");
    expect(ui.state[0]).toEqual([other]); expect(ui.state[3]).toBe(true);
    const count = fetchMock.mock.calls.length;
    expect(await previous.save(selection, "已切换后旧回调", "old-client-two")).toContain("任务卡已关闭或切换");
    expect(fetchMock).toHaveBeenCalledTimes(count);
    const fresh = { ...other, id: "new-card-note" };
    nextPost.resolve(response(fresh)); await newMutation;
    expect(ui.state[0]).toEqual([other, fresh]); expect(ui.state[3]).toBe(false);
  });
  it.each(["save", "answer", "retry", "resolve"] as const)("卸载后迟到的%s成功结果不再写入任何页面状态或读取旧卡", async (action) => {
    const post = deferred<ReturnType<typeof response>>();
    const fetchMock = vi.fn((_url: string, init?: { method?: string }) => init?.method === "POST" ? post.promise : Promise.resolve(snapshot([note])));
    vi.stubGlobal("fetch", fetchMock);
    const annotations = renderHook(); await tick();
    const mutation = action === "save" ? annotations.save(selection, "批注", "client-id") : action === "retry" ? annotations.retry(note.id) : action === "answer" ? annotations.answer(note.id, "补充回答") : annotations.resolve(note.id, "保留备注");
    ui.cleanups.forEach((cleanup) => cleanup?.()); ui.cleanups = [];
    const writes = ui.writes.length, calls = fetchMock.mock.calls.length;
    post.resolve(response(note)); expect(await mutation).toContain("任务卡已关闭或切换"); await tick();
    expect(ui.writes).toHaveLength(writes); expect(fetchMock).toHaveBeenCalledTimes(calls);
  });
  it("完成审核后直接批注禁用并解释取消确认，引用私聊仍然可用", () => {
    const html = renderToStaticMarkup(<SelectionPopover selection={selection} canCreate={false} closedReason="已完成审核，取消确认后可继续修改。" onSave={vi.fn()} onQuote={vi.fn()} onClose={vi.fn()} />);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>[\s\S]*?直接批注<\/button>/);
    const quoteButton = /<button[^>]*>[^]*?引用并对话<\/button>/.exec(html)?.[0].split("</button>").at(-2);
    expect(quoteButton).not.toContain("disabled");
    expect(html).toContain("取消确认后可继续修改");
  });
  it("批注输入途中正文冻结时，保留原输入并禁用保存", () => {
    ui.state = ["write", "尚未保存的意见", "", false];
    const html = renderToStaticMarkup(<SelectionPopover selection={selection} canCreate={false} closedReason="已经开始汇总，请重新开放审核后修改。" onSave={vi.fn()} onQuote={vi.fn()} onClose={vi.fn()} />);
    expect(html).toMatch(/<textarea[^>]*disabled=""[^>]*>尚未保存的意见<\/textarea>/);
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>保存批注<\/button>/);
    expect(html).toContain("已经开始汇总");
  });
});
