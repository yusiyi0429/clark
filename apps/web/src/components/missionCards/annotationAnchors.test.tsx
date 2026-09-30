import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TMissionCardAnnotationView } from "@warmap/contracts";
import { annotationMarks, locateAnchor, normalizeAnchorText } from "./annotationAnchors";
import { AnnotatedField, AnnotationNote, FieldAnnotationActivity, RevisionHistory } from "./MissionAnnotations";
import { personalPayload } from "./personalMissionFixture";

const mission = personalPayload.card.missions[0];
const note = { id: "note", cardId: "card", missionId: mission.missionId, field: "outcome", sourceVersion: 1, sourceText: "前文 **成功证据** 后文", quote: "成功证据", prefix: "前文 ", suffix: " 后文", startOffset: 3, body: "请明确验收口径", authorId: "owner", authorName: "白田田", status: "needs_clarification", question: "以哪种证据为准？", options: ["界面截图", "真实走查记录"], answer: null, note: null, appliedVersion: null, canAnswer: true, canRetry: false, clarifications: [], stale: false, createdAt: "2026-10-01T02:00:00.000Z" } as TMissionCardAnnotationView;

describe("rendered Markdown annotation anchors", () => {
  it("retains each clarification and answer alongside the original remark", () => {
    const html = renderToStaticMarkup(<AnnotationNote note={{ ...note, clarifications: [{ question: "哪种证据？", answer: "真实走查记录", authorId: "owner", authorName: "白田田", createdAt: note.createdAt }, { question: "覆盖谁？", answer: "CEO 与 DRI", authorId: "owner", authorName: "白田田", createdAt: note.createdAt }] }} />);
    for (const text of ["请明确验收口径", "哪种证据？", "真实走查记录", "覆盖谁？", "CEO 与 DRI"]) expect(html).toContain(text);
  });
  it("locates repeated text by context and refuses ambiguous matches", () => {
    expect(locateAnchor("先核对，后核对", { quote: "核对", prefix: "先", suffix: "，后", startOffset: 1 })).toEqual([1, 3]);
    expect(locateAnchor("先核对，后核对", { quote: "核对", prefix: "后", suffix: "", startOffset: 5 })).toEqual([5, 7]);
    expect(locateAnchor("先核对，后核对", { quote: "核对", prefix: "不存在", suffix: "", startOffset: 0 })).toBeNull();
  });
  it("normalizes rendered whitespace without treating Markdown delimiters as offsets", () => {
    expect(normalizeAnchorText("  前文\n\t成功证据 后文 ")).toBe("前文 成功证据 后文");
    const html = renderToStaticMarkup(<AnnotatedField mission={mission} field="outcome" text={note.sourceText} notes={[note]} onSelect={vi.fn()} />);
    expect(html).toContain('<strong><mark data-annotation-ids="note">成功证据</mark>');
    expect(html).toContain('aria-label="查看此处批注"');
    expect(html).not.toContain("**");
  });
  it("preserves multi-node emphasis and marks only the selected span once", () => {
    const across = { ...note, quote: "前文 成功证据", prefix: "", suffix: " 后文", startOffset: 0 };
    const html = renderToStaticMarkup(<AnnotatedField mission={mission} field="outcome" text={note.sourceText} notes={[across]} onSelect={vi.fn()} />);
    expect((html.match(/<mark /g) ?? []).length).toBe(2);
    expect((html.match(/查看此处批注/g) ?? []).length).toBe(1);
  });
  it("never attaches a stale annotation to changed text", () => {
    const html = renderToStaticMarkup(<AnnotatedField mission={mission} field="outcome" text={note.sourceText} notes={[{ ...note, stale: true }]} onSelect={vi.fn()} />);
    expect(html).not.toContain("<mark");
    expect(html).not.toContain("查看此处批注");
  });
  it("renders the clarification next to the field with a final custom input option", () => {
    const controls = { notes: [note], revisions: [], onSave: vi.fn(), onAnswer: vi.fn(), onRetry: vi.fn() };
    const html = renderToStaticMarkup(<FieldAnnotationActivity notes={[note]} controls={controls} />);
    expect(html).toContain("以哪种证据为准？");
    expect(html.indexOf("自己输入")).toBeGreaterThan(html.indexOf("真实走查记录"));
    const locked = renderToStaticMarkup(<FieldAnnotationActivity notes={[{ ...note, canAnswer: false }]} controls={controls} />);
    expect(locked).toMatch(/disabled[^>]*>界面截图/);
  });
  it("keeps both original and modified text available in revision history", () => {
    const html = renderToStaticMarkup(<RevisionHistory revisions={[{ id: "revision", cardId: "card", missionId: "mission", field: "outcome", before: "原来的结果", after: "可核对的结果", reason: "按批注明确验收证据", source: "annotation", authorId: "owner", authorName: "白田田", annotationId: "note", beforeVersion: 1, afterVersion: 2, createdAt: note.createdAt }]} />);
    expect(html).toContain("原来的结果"); expect(html).toContain("可核对的结果"); expect(html).toContain("按批注明确验收证据");
  });
});
