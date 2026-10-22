import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { RecordSection } from "./RecordSection";

const SOURCE = { id: "src-1", url: "https://example.feishu.cn/minutes/abc", title: "渠道预算会", contentHash: "a".repeat(64), sourceVersion: null, capturedAt: "2026-10-20T15:00:00+08:00" };
const TURNS = [
  { id: "turn-1", speakerId: "s1", startedAt: "2026-10-20T11:38:00+08:00", text: "二期预算定为 80 万。" },
  { id: "turn-2", speakerId: "s2", startedAt: "2026-10-20T11:45:00+08:00", text: "先说排期。" },
  { id: "turn-3", speakerId: "s1", startedAt: "2026-10-20T11:52:00+08:00", text: "那就这么定。" },
  { id: "turn-4", speakerId: "s2", startedAt: "2026-10-20T11:53:00+08:00", text: "好。" },
];

describe("一段正文的出处行", () => {
  it("几处出处按处列时段，不连成一个大时段", () => {
    const html = renderToStaticMarkup(
      <RecordSection number={1} state="same" editable={false} sources={[SOURCE]} turns={TURNS} speakerName={() => null}
        section={{ id: "sec-1", heading: "预算", body: "已定：二期预算 80 万。", sourceRefs: [{ sourceId: "src-1", locator: "turn-1" }, { sourceId: "src-1", locator: "turn-3..turn-4" }] }} />,
    );
    expect(html).toContain("渠道预算会 · 11:38、11:52–11:53");
    expect(html).not.toContain("11:38–11:53");
  });
});
