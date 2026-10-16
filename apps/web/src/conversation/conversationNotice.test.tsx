import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationNotice } from "./Transcript";

describe("失败说明下面的按钮", () => {
  it("能接着来时显示「继续」/「重新回答」，不能时只有说明", () => {
    const run = vi.fn();
    expect(renderToStaticMarkup(<ConversationNotice text="说明" action={{ label: "继续", run }} />)).toContain("继续");
    expect(renderToStaticMarkup(<ConversationNotice text="说明" />)).not.toContain("conversation-resume");
  });
});
