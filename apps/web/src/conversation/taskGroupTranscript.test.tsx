import { expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { TaskGroupTranscript } from "./TaskGroupTranscript";
import { MissionGroupComposer } from "./MissionGroupComposer";

it("事项群组沿用右列记录和输入条，展示 Co-Agent 开场且随时可说话", () => {
  const html = renderToStaticMarkup(<TaskGroupTranscript messages={[{ id: 0, kind: "co-agent", authorId: null, authorName: null, content: "讨论这件执行事项", quote: null, createdAt: "2026-09-27T00:00:00Z" }]} />);
  expect(html).toContain("Co-Agent"); expect(html).toContain("讨论这件执行事项");
  const composer = renderToStaticMarkup(<MissionGroupComposer cardId="task-1" taskId="task-1" viewerId="sun" phase="open" channels={[]} channel="group" onChannel={() => {}} narrow={false} mobileOpen={false} onMobileOpen={() => {}} onHeightChange={() => {}} reference={null} onRemoveReference={() => {}} busy={false} onSend={async () => true} />);
  expect(composer).toContain('data-conversation-context="task:task-1"');
  expect(composer).toContain('placeholder="输入你的想法…"');
  expect(composer).not.toMatch(/<textarea[^>]*disabled/);
});

it("离群后输入条只读", () => {
  const composer = renderToStaticMarkup(<MissionGroupComposer cardId="task-1" taskId="task-1" phase="open" readOnly channels={[]} channel="group" onChannel={() => {}} narrow={false} mobileOpen={false} onMobileOpen={() => {}} onHeightChange={() => {}} reference={null} onRemoveReference={() => {}} busy={false} onSend={async () => true} />);
  expect(composer).toContain("你已不在这个群");
  expect(composer).toMatch(/<textarea[^>]*disabled/);
});
