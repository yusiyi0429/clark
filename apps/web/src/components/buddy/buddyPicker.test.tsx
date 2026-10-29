import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const api = vi.hoisted(() => ({ GET: vi.fn(), PUT: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ browserApi: api }));
vi.mock("@/components/coagent/PresenceCapsule", () => ({
  PresenceCapsule: ({ skin }: { skin: string }) => <span data-capsule={skin} />,
}));

import { BuddyPicker } from "./BuddyPicker";
import { BuddySettings } from "./BuddySettings";
import { buddyNameValid, initialBuddyDraft, saveBuddy } from "./useBuddy";

function stubWindow(stored: string | null) {
  vi.stubGlobal("window", Object.assign(new EventTarget(), {
    localStorage: { getItem: (key: string) => (key === "tianshu.coagent-skin" ? stored : null) },
    matchMedia: () => ({ matches: true }),
  }));
}

beforeEach(() => { vi.clearAllMocks(); stubWindow(null); });
afterEach(() => vi.unstubAllGlobals());

describe("选择你的伙伴", () => {
  it("新人名字是空的，样子停在这台电脑上原来选过的那颗胶囊；有伙伴就用伙伴的", () => {
    expect(initialBuddyDraft(null)).toEqual({ name: "", form: "classic" });
    stubWindow("alive");
    expect(initialBuddyDraft(null)).toEqual({ name: "", form: "alive" });
    expect(initialBuddyDraft({ name: "团团", form: "panda" })).toEqual({ name: "团团", form: "panda" });
  });

  it("名字去掉首尾空白后 1–12 个字", () => {
    expect(buddyNameValid("   ")).toBe(false);
    expect(buddyNameValid("一二三四五六七八九十甲乙丙")).toBe(false);
    expect(buddyNameValid("一二三四五六七八九十甲乙")).toBe(true);
    expect(buddyNameValid(" 团团 ")).toBe(true);
  });

  it("上面是名字，下面是三颗胶囊，选中的那颗带标记", () => {
    const html = renderToStaticMarkup(<BuddyPicker value={{ name: "团团", form: "alive" }} onChange={() => undefined} />);
    expect(html).toContain("名字");
    expect(html).toMatch(/<input[^>]*value="团团"/);
    expect(html).toMatch(/<input[^>]*maxLength="12"/);
    expect(html.match(/name="coagent-skin"/g)).toHaveLength(3);
    expect(html.match(/data-capsule="(classic|alive|panda)"/g)).toHaveLength(3);
    expect(html).toMatch(/data-selected="true"[^>]*><input[^>]*value="alive"/);
    expect(html).not.toMatch(/data-selected="true"[^>]*><input[^>]*value="classic"/);
  });

  it("保存时去掉首尾空白，存好后告诉同页的其他读者；存不上就报错", async () => {
    const changed = vi.fn();
    window.addEventListener("buddy-changed", changed);
    api.PUT.mockResolvedValueOnce({ data: { name: "团团", form: "panda" }, response: { ok: true } });
    await expect(saveBuddy({ name: " 团团 ", form: "panda" })).resolves.toEqual({ name: "团团", form: "panda" });
    expect(api.PUT).toHaveBeenCalledWith("/api/me/buddy", { body: { name: "团团", form: "panda" } });
    expect(changed).toHaveBeenCalledTimes(1);
    api.PUT.mockResolvedValueOnce({ data: undefined, error: { message: "伙伴要有名字" }, response: { ok: false } });
    await expect(saveBuddy({ name: "团团", form: "panda" })).rejects.toThrow("伙伴要有名字");
    expect(changed).toHaveBeenCalledTimes(1);
  });

  it("设置里的伙伴形象：名字、三颗胶囊和保存；还没读到伙伴时不能保存", () => {
    const html = renderToStaticMarkup(<BuddySettings onDone={() => undefined} />);
    expect(html).toContain("名字");
    expect(html.match(/name="coagent-skin"/g)).toHaveLength(3);
    expect(html).toMatch(/<button[^>]*type="submit"[^>]*disabled=""[^>]*>[^<]*保存/);
  });
});
