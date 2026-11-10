import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const api = vi.hoisted(() => ({ GET: vi.fn(), PUT: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ browserApi: api }));
vi.mock("@/components/coagent/PresenceCapsule", () => ({
  PresenceCapsule: ({ skin, name, pose }: { skin: string; name?: string; pose?: string }) => <span data-capsule={skin} data-name={name} data-pose={pose} />,
}));

import { BuddyPicker } from "./BuddyPicker";
import { BuddySettings, liveBuddySaver } from "./BuddySettings";
import { BUDDY_NAME_UNITS, buddyNameUnits, buddyNameValid, clampBuddyName, initialBuddyDraft, saveBuddy } from "./useBuddy";

function stubWindow(stored: string | null) {
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    localStorage: { getItem: (key: string) => (key === "tianshu.coagent-skin" ? stored : null) },
    matchMedia: () => ({ matches: true }),
  }));
}

beforeEach(() => { vi.clearAllMocks(); stubWindow(null); });
afterEach(() => vi.unstubAllGlobals());

describe("选择你的伙伴", () => {
  it("新人名字是空的，样子停在这台电脑上原来选过的那颗胶囊，性格是沉稳靠谱；有伙伴就用伙伴的", () => {
    expect(initialBuddyDraft(null)).toEqual({ name: "", form: "classic", personality: "steady" });
    stubWindow("alive");
    expect(initialBuddyDraft(null)).toEqual({ name: "", form: "alive", personality: "steady" });
    expect(initialBuddyDraft({ name: "团团", form: "panda", personality: "direct" })).toEqual({ name: "团团", form: "panda", personality: "direct" });
    expect(initialBuddyDraft({ name: "团团", form: "panda" })).toEqual({ name: "团团", form: "panda", personality: "steady" });
  });

  it("名字按宽度算：去掉首尾空白后，汉字、大写字母、m、w 和别的符号算 2，其余窄字算 1，合计 1–12", () => {
    expect(BUDDY_NAME_UNITS).toBe(12);
    expect(buddyNameUnits("Tom 小明")).toBe(10);
    expect(buddyNameUnits(" Miles ")).toBe(6);
    expect(buddyNameValid("   ")).toBe(false);
    for (const ok of ["一二三四五六", "abcdefghijkl", "WWWWWW", "Anna 小明小", " 团团 "]) expect(buddyNameValid(ok)).toBe(true);
    for (const tooWide of ["一二三四五六七", "abcdefghijklo", "WWWWWWW", "Annab 小明小", "一二三四五六a"]) expect(buddyNameValid(tooWide)).toBe(false);
  });

  it("输入框里超宽的部分打不进去：从头数到放不下为止，不截半个字", () => {
    expect(clampBuddyName("一二三四五六七")).toBe("一二三四五六");
    expect(clampBuddyName("WWWWWWWWWWWW")).toBe("WWWWWW");
    expect(clampBuddyName("abcdefghijklmn")).toBe("abcdefghijkl");
    expect(clampBuddyName("一二三四五a六")).toBe("一二三四五a");
    expect(clampBuddyName("😀😀😀😀😀😀😀")).toBe("😀😀😀😀😀😀");
    expect(clampBuddyName("Tom 小明")).toBe("Tom 小明");
  });

  it("上面是名字，中间是五种形象（三颗胶囊、Miles 和 C妹），下面是四种性格，选中的带标记", () => {
    const html = renderToStaticMarkup(<BuddyPicker value={{ name: "团团", form: "alive", personality: "warm" }} name="团团" onName={() => undefined} onCommitName={() => undefined} onPick={() => undefined} />);
    expect(html).toContain("性格");
    expect(html.match(/name="buddy-personality"/g)).toHaveLength(4);
    expect(html).toMatch(/data-selected="true"[^>]*><input[^>]*value="warm"/);
    for (const label of ["沉稳靠谱", "直言不讳", "温和体贴", "启发追问"]) expect(html).toContain(label);
    expect(html).toContain("名字");
    expect(html).toMatch(/<input[^>]*value="团团"/);
    expect(html).not.toContain("maxLength");
    expect(html.match(/name="coagent-skin"/g)).toHaveLength(5);
    expect(html.match(/data-capsule="(classic|alive|panda|miles|cmei)"/g)).toHaveLength(5);
    expect(html).toMatch(/data-selected="true"[^>]*><input[^>]*value="alive"/);
    expect(html).not.toMatch(/data-selected="true"[^>]*><input[^>]*value="classic"/);
  });

  it("选了 Miles 的伙伴，Miles 那一格带标记；格子里只有胶囊，名字只给读屏", () => {
    const html = renderToStaticMarkup(<BuddyPicker value={{ name: "团团", form: "miles" }} name="团团" onName={() => undefined} onCommitName={() => undefined} onPick={() => undefined} />);
    expect(html).toMatch(/data-selected="true"[^>]*><input[^>]*value="miles"/);
    expect(html).toMatch(/<input[^>]*aria-label="Miles"[^>]*value="miles"/);
    expect(html).not.toContain("<strong>");
    expect(html.match(/data-name="团团"/g)).toHaveLength(5);
  });

  it("保存时去掉首尾空白，存好后告诉同页的其他读者；存不上就报错", async () => {
    const changed = vi.fn();
    window.addEventListener("buddy-changed", changed);
    api.PUT.mockResolvedValueOnce({ data: { name: "团团", form: "panda", personality: "coach" }, response: { ok: true } });
    await expect(saveBuddy({ name: " 团团 ", form: "panda", personality: "coach" })).resolves.toEqual({ name: "团团", form: "panda", personality: "coach" });
    expect(api.PUT).toHaveBeenCalledWith("/api/me/buddy", { body: { name: "团团", form: "panda", personality: "coach" } });
    expect(changed).toHaveBeenCalledTimes(1);
    api.PUT.mockResolvedValueOnce({ data: undefined, error: { message: "伙伴要有名字" }, response: { ok: false } });
    await expect(saveBuddy({ name: "团团", form: "panda" })).rejects.toThrow("伙伴要有名字");
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("「我 › 伙伴」：名字、五种形象、四种性格，没有保存按钮；形象一律待机姿势，没有「在听 / 在说」", () => {
    const html = renderToStaticMarkup(<BuddySettings />);
    expect(html).not.toContain("在听");
    expect(html).not.toContain("在说");
    expect(html.match(/data-pose="idle"/g)).toHaveLength(5);
    expect(html).not.toMatch(/data-pose="(listening|speaking)"/);
    expect(html).toContain("名字");
    expect(html.match(/name="coagent-skin"/g)).toHaveLength(5);
    expect(html.match(/name="buddy-personality"/g)).toHaveLength(4);
    expect(html).not.toContain("<button");
    expect(html).not.toContain("保存");
  });

  it("没存成的那一项下面一行原因，别的项下面没有", () => {
    const html = renderToStaticMarkup(<BuddyPicker value={{ name: "团团", form: "panda", personality: "warm" }} name="团团" onName={() => undefined} onCommitName={() => undefined} onPick={() => undefined}
      error={{ field: "personality", reason: "网络断了" }} />);
    expect(html.match(/role="alert"/g)).toHaveLength(1);
    expect(html).toMatch(/name="buddy-personality".*role="alert"[^>]*>网络断了</);
  });
});

describe("点了就存（「我 › 伙伴」）", () => {
  const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
  const deferred = () => {
    let resolve!: (value: unknown) => void;
    const promise = new Promise((ok) => { resolve = ok; });
    return { promise, resolve };
  };
  const buddy = (form: string) => ({ name: "团团", form, personality: "steady" }) as Parameters<typeof saveBuddy>[0];

  it("点一个形象当下就 PUT，存好告诉同页的伙伴台", async () => {
    const changed = vi.fn();
    window.addEventListener("buddy-changed", changed);
    const saved = vi.fn();
    api.PUT.mockResolvedValueOnce({ data: buddy("panda"), response: { ok: true } });
    const push = liveBuddySaver(saveBuddy, { saved, failed: vi.fn() });
    push(buddy("panda"), "form");
    expect(api.PUT).toHaveBeenCalledWith("/api/me/buddy", { body: buddy("panda") });
    await flush();
    expect(saved).toHaveBeenCalledWith(buddy("panda"));
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("快速连点几个形象：一次只发一个，发着时只记最后一次，最后存的是最后点的那个", async () => {
    const first = deferred();
    const last = deferred();
    const save = vi.fn().mockReturnValueOnce(first.promise).mockReturnValueOnce(last.promise);
    const saved = vi.fn();
    const failed = vi.fn();
    const push = liveBuddySaver(save, { saved, failed });
    push(buddy("panda"), "form");
    push(buddy("alive"), "form");
    push(buddy("miles"), "form");
    expect(save).toHaveBeenCalledTimes(1);
    first.resolve(buddy("panda"));
    await flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(save).toHaveBeenLastCalledWith(buddy("miles"));
    last.resolve(buddy("miles"));
    await flush();
    expect(save).toHaveBeenCalledTimes(2);
    expect(saved.mock.calls.map(([value]) => value.form)).toEqual(["panda", "miles"]);
    expect(failed).not.toHaveBeenCalled();
  });

  it("没存成：报那一项和原因；被后来者顶掉的那次没成不报，接着发最后一次", async () => {
    const failed = vi.fn();
    const save = vi.fn().mockRejectedValueOnce(new Error("网络断了"));
    liveBuddySaver(save, { saved: vi.fn(), failed })(buddy("panda"), "form");
    await flush();
    expect(failed).toHaveBeenCalledWith({ field: "form", reason: "网络断了" });

    const quiet = vi.fn();
    const first = deferred();
    const save2 = vi.fn().mockReturnValueOnce(first.promise.then(() => { throw new Error("先发的没成"); })).mockResolvedValueOnce({ name: "团团", form: "panda", personality: "coach" });
    const push = liveBuddySaver(save2, { saved: vi.fn(), failed: quiet });
    push(buddy("alive"), "form");
    push({ name: "团团", form: "panda", personality: "coach" }, "personality");
    first.resolve(null);
    await flush();
    expect(save2).toHaveBeenCalledTimes(2);
    expect(quiet).not.toHaveBeenCalled();
  });
});
