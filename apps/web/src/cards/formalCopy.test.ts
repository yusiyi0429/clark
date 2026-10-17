import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * 一号位页面的固定文案按会议材料的书面语体写（文案严肃化，见 .superpowers/sdd/copy-formalization.md）：
 * 不用聊天、陪伴、拟人口吻和语气词。这里扫源码里的字符串（去掉注释），新文案带回这些词时失败。
 */
const SRC = fileURLToPath(new URL("..", import.meta.url));

const FILES = [
  "cards/IssueCard.tsx", "cards/MeetingCard.tsx", "cards/BattlefieldCard.tsx", "cards/battlefieldDisplay.tsx", "cards/RadarCard.tsx",
  "cards/SignalCard.tsx", "cards/SignalArticle.tsx", "cards/SignalStory.tsx", "cards/meetingIssueModel.ts",
  "components/NotificationRail.tsx", "components/CeoGlance.tsx", "components/StrategicConfirmCard.tsx",
  "components/NoticeActions.tsx", "components/ActionNoticeCard.tsx", "components/IssueRow.tsx", "components/coagent/PresenceCapsule.tsx",
  "components/shell/MaterialTabs.tsx", "components/materials/ObjectMaterialArea.tsx",
  "app/(ceo)/battlefields/[id]/BattlefieldDetailScreen.tsx",
  "conversation/ConversationDock.tsx", "conversation/ColumnComposer.tsx", "conversation/ConversationHistorySheet.tsx", "conversation/ConversationHost.tsx",
  "conversation/CitationPanel.tsx", "conversation/ThreadMembersMenu.tsx", "conversation/DictationControls.tsx", "conversation/useConversation.ts",
  "conversation/useDictation.ts", "conversation/Transcript.tsx",
  ...readdirSync(join(SRC, "components/meeting")).filter((name) => /\.tsx?$/.test(name) && !name.includes(".test.")).map((name) => `components/meeting/${name}`),
];

/** 清单里的典型口语词：陪伴口吻、语气词、卖萌符号、聊天式小标题与按钮。 */
const COLLOQUIAL = /与你一起|一起推敲|一起想|咱们|聊聊|试试|看看|帮你|[啦哦]|～|还没弄清|拍板前要问清|说完再转|没听清|这场会开完了|拉人进群|你的想法/g;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[\s;,{}()])\/\/.*$/gm, "$1");
}

describe("一号位页面文案不出现口语化、聊天式用语", () => {
  it.each(FILES)("%s", (file) => {
    const hits = [...stripComments(readFileSync(join(SRC, file), "utf8")).matchAll(COLLOQUIAL)].map((match) => match[0]);
    expect(hits).toEqual([]);
  });

  it("议题页备选方案小节用商定的标题、角标与说明", () => {
    const source = readFileSync(join(SRC, "cards/IssueCard.tsx"), "utf8");
    for (const text of ["\"备选方案\"", "\"AI 预研\"", "\"提交会议讨论\""]) expect(source).toContain(text);
    expect(source).not.toContain("各方案的取舍与前提");
  });
});
