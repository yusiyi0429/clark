import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const api = vi.hoisted(() => ({ GET: vi.fn(), PUT: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ browserApi: api }));
vi.mock("@/components/coagent/PresenceCapsule", () => ({
  PresenceCapsule: ({ skin, name }: { skin: string; name?: string }) => <span data-capsule={skin} data-name={name} />,
}));

import { BuddyPicker } from "./BuddyPicker";
import { BuddySettings } from "./BuddySettings";
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
    expect(initialBuddyDraft({ name: "团团", form: "panda", personality: "critical" })).toEqual({ name: "团团", form: "panda", personality: "critical" });
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
    const html = renderToStaticMarkup(<BuddyPicker value={{ name: "团团", form: "alive", personality: "cheerful" }} onChange={() => undefined} />);
    expect(html).toContain("性格");
    expect(html.match(/name="buddy-personality"/g)).toHaveLength(4);
    expect(html).toMatch(/data-selected="true"[^>]*><input[^>]*value="cheerful"/);
    for (const label of ["沉稳靠谱", "乐观开朗", "理性冷静", "较真犀利"]) expect(html).toContain(label);
    expect(html).toContain("名字");
    expect(html).toMatch(/<input[^>]*value="团团"/);
    expect(html).not.toContain("maxLength");
    expect(html.match(/name="coagent-skin"/g)).toHaveLength(5);
    expect(html.match(/data-capsule="(classic|alive|panda|miles|cmei)"/g)).toHaveLength(5);
    expect(html).toMatch(/data-selected="true"[^>]*><input[^>]*value="alive"/);
    expect(html).not.toMatch(/data-selected="true"[^>]*><input[^>]*value="classic"/);
  });

  it("选了 Miles 的伙伴，Miles 那一格带标记；格子里只有胶囊，名字只给读屏", () => {
    const html = renderToStaticMarkup(<BuddyPicker value={{ name: "团团", form: "miles" }} onChange={() => undefined} />);
    expect(html).toMatch(/data-selected="true"[^>]*><input[^>]*value="miles"/);
    expect(html).toMatch(/<input[^>]*aria-label="Miles"[^>]*value="miles"/);
    expect(html).not.toContain("<strong>");
    expect(html.match(/data-name="团团"/g)).toHaveLength(5);
  });

  it("保存时去掉首尾空白，存好后告诉同页的其他读者；存不上就报错", async () => {
    const changed = vi.fn();
    window.addEventListener("buddy-changed", changed);
    api.PUT.mockResolvedValueOnce({ data: { name: "团团", form: "panda", personality: "calm" }, response: { ok: true } });
    await expect(saveBuddy({ name: " 团团 ", form: "panda", personality: "calm" })).resolves.toEqual({ name: "团团", form: "panda", personality: "calm" });
    expect(api.PUT).toHaveBeenCalledWith("/api/me/buddy", { body: { name: "团团", form: "panda", personality: "calm" } });
    expect(changed).toHaveBeenCalledTimes(1);
    api.PUT.mockResolvedValueOnce({ data: undefined, error: { message: "伙伴要有名字" }, response: { ok: false } });
    await expect(saveBuddy({ name: "团团", form: "panda" })).rejects.toThrow("伙伴要有名字");
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("设置里的伙伴形象：名字、五种形象和保存；还没读到伙伴时不能保存", () => {
    const html = renderToStaticMarkup(<BuddySettings onDone={() => undefined} />);
    expect(html).toContain("名字");
    expect(html.match(/name="coagent-skin"/g)).toHaveLength(5);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>[^<]*保存/);
  });
});
