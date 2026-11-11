import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { SessionEntry } from "@/lib/local/sessionView";
import { SessionTranscript, type OpenFile } from "./SessionTranscript";

const render = (entries: SessionEntry[], onFile?: OpenFile) =>
  renderToStaticMarkup(<SessionTranscript entries={entries} agentName="Claude Code" canAct onDecide={vi.fn()} live={false} onFile={onFile} />);
const answer = (at: string, text: string): SessionEntry => ({ kind: "assistant", seq: 1, at, text });

describe("子会话用伙伴对话的出字组件（流畅感第 2 条）", () => {
  it("页面开着时刚到的那段按到达淡入（data-arrival）；打开时重放的历史整段直接画", () => {
    const fresh = render([answer(new Date().toISOString(), "改好了，**两处**。")]);
    expect(fresh).toContain("data-arrival");
    expect(fresh).toContain("<strong>");
    const old = render([answer("2026-11-01T01:00:00Z", "改好了，**两处**。")]);
    expect(old).not.toContain("data-arrival");
    expect(old).toContain("<strong>两处</strong>");
  });

  it("不认伙伴对话的公式和出处标记：命令里的 $ 照原样", () => {
    const html = render([answer("2026-11-01T01:00:00Z", "设好 $HOME 和 $PATH 再跑。")]);
    expect(html).toContain("$HOME 和 $PATH");
    expect(html).not.toContain("katex");
  });

  it("回答里提到的文件：能不能点看传进来的那个最新的办法（清单刷新后对得上的就能点）", () => {
    const entries = [answer("2026-11-01T01:00:00Z", "改了 `README.md`。")];
    expect(render(entries, () => null)).not.toContain("file-open");
    expect(render(entries, (mention) => (mention === "README.md" ? vi.fn() : null))).toContain('data-testid="file-open"');
  });
});
