import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { VOICEPRINT_SCRIPT, VoiceprintCard } from "./VoiceprintCard";

describe("我的声纹", () => {
  it("录之前单独勾选同意、写明用途，给出朗读文字；没勾同意不能开始录", () => {
    const html = renderToStaticMarkup(<VoiceprintCard />);
    expect(html).toContain("我的声纹");
    expect(html).toContain("还没录");
    expect(html).toContain("只用于在公司会议录音里认出我的发言；我可以随时删除");
    expect(html).toContain(VOICEPRINT_SCRIPT);
    expect(html).not.toContain("由人确认");
    expect(html).toContain("15–30 秒");
    const start = html.slice(html.lastIndexOf("<button", html.indexOf("开始录制")), html.indexOf("开始录制"));
    expect(start).toContain("disabled");
  });
});
