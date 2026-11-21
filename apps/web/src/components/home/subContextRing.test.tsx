import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LocalContext } from "@/lib/local/LocalRunnerProvider";
import { SubRow } from "./SubRows";

const sub = { id: "c1", kind: "card", title: "拆左栏", state: "done", waiting: null, updatedAt: "2026-11-18T01:00:00.000Z", queueReason: null, holdUntil: null, sessionId: "s1", unseen: false };
const session = (usedTokens: number) => ({ id: "s1", subject: { kind: "card", cardId: "c1" }, status: "idle", context: { usedTokens, maxTokens: 1_000_000, at: "2026-11-18T01:00:00.000Z" } });
const row = (sessions: unknown[]) => renderToStaticMarkup(
  <LocalContext.Provider value={{ sessions } as unknown as Parameters<typeof LocalContext.Provider>[0]["value"]}>
    <SubRow sub={sub as never} view={{ kind: "home" }} go={() => undefined} status="做完一轮" />
  </LocalContext.Provider>,
);

describe("右边会话面板的会话行（本人 11/18）", () => {
  it("会话面板只在占用到八成时多一颗小环", () => {
    // 到八成：行尾（状态后面）一颗小圆环，颜色同输入框下那颗到八成时，不带字
    const full = row([session(800_000)]);
    expect(full).toMatch(/data-testid="sub-status">做完一轮<\/span><span[^>]*data-tone="warning"[^>]*data-testid="sub-context"[^>]*><svg[\s\S]*?<\/svg><\/span>/);
    expect(full.replace(/aria-label="[^"]*"/g, "")).not.toContain("80%"); // 读屏读得到，画出来不带字
    expect(row([session(950_000)])).toContain('data-testid="sub-context"');
    // 低于八成、没有占用、不在这台电脑上：什么都不加
    expect(row([session(790_000)])).not.toContain("sub-context");
    expect(row([{ ...session(0), context: undefined }])).not.toContain("sub-context");
    expect(row([])).not.toContain("sub-context");
  });
});
