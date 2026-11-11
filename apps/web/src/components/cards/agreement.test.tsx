import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TCardAgreementChange } from "@warmap/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/me/work" }));

import { AgreementSection, ChangeItem, ProposalDecision, overLimit, standardsOk } from "./Agreement";
import { foldEvents } from "@/lib/local/sessionView";

/** 卡的约定（主循环第 60 条）：没有 jsdom，只看画出来的样子。 */
const text = (html: string) => html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");
const standards = ["列出 3 个候选名", "每个写一句含义", "近似商标的申请号"];
const section = (patch: Partial<Parameters<typeof AgreementSection>[0]> = {}) => renderToStaticMarkup(
  <AgreementSection cardId="card-1" version={7} brief="给新品牌起名" standards={standards} agreement={{ revision: 3, changes: 2, proposal: null }}
    canEdit editing={false} onEditing={() => undefined} onSaved={async () => undefined} {...patch} />,
);

describe("会话详情里的完成标准", () => {
  it("平时一列，标题旁「改」；改过的写「约定改过 N 次」，默认收起；没改过不画", () => {
    const page = text(section());
    expect(page).toContain("|完成标准|改|列出 3 个候选名|每个写一句含义|近似商标的申请号|约定改过 2 次|");
    expect(section()).toMatch(/aria-expanded="false"[^>]*data-testid="agreement-changes"/);
    expect(text(section({ agreement: { revision: 1, changes: 0, proposal: null } }))).not.toContain("约定改过");
  });
  it("卡做完了、不是推进人：没有「改」", () => {
    expect(text(section({ canEdit: false }))).not.toContain("|改|");
  });
  it("改的时候：交代、逐条一个输入框、每条能删、能添加；取消、保存", () => {
    const html = section({ editing: true });
    const page = text(html);
    expect(page).toMatch(/\|交代\|给新品牌起名\|完成标准\|添加\|取消\|保存\|/);
    expect(html.match(/data-testid="agreement-line"/g)).toHaveLength(3);
    expect(html).toContain('value="近似商标的申请号"');
    expect(html.match(/aria-label="删除"/g)).toHaveLength(3);
  });
  it("超长的那一条标出来：自己超过 300 字的，或者从它起整份超过 2000 字的", () => {
    expect(overLimit(["短", "字".repeat(301), "短"])).toEqual([false, true, false]);
    const long = Array.from({ length: 8 }, () => "字".repeat(260));
    expect(overLimit(long)).toEqual([false, false, false, false, false, false, false, true]);
  });
  it("能不能存：至少一条，每条不空、不超 300 字，合起来不超 2000 字", () => {
    expect(standardsOk(standards)).toBe(true);
    expect(standardsOk([])).toBe(false);
    expect(standardsOk(["列出 3 个候选名", "  "])).toBe(false);
    expect(standardsOk(["字".repeat(301)])).toBe(false);
    expect(standardsOk(Array.from({ length: 8 }, () => "字".repeat(260)))).toBe(false);
  });
});

describe("约定的修改记录", () => {
  const change: TCardAgreementChange = {
    id: "00000000-0000-4000-8000-0000000000c1", revision: 2, at: "2026-11-11T07:00:00.000Z", by: { kind: "worker", name: null },
    before: { brief: "给新品牌起名", standards: ["近似商标的申请号"] }, after: { brief: "给新品牌起名", standards: ["近似商标由本人查"] }, reason: "商标网拦自动访问",
  };
  it("每次：谁 · 什么时候、原因、改前、改后；交代没变不写交代", () => {
    const page = text(renderToStaticMarkup(<ChangeItem change={change} />));
    expect(page).toMatch(/^\|执行方 · .+\|商标网拦自动访问\|改前\|近似商标的申请号\|改后\|近似商标由本人查\|$/);
    expect(page).not.toContain("给新品牌起名");
  });
});

describe("执行方提议改约定的框", () => {
  it("头部「提议改完成标准」，下面原因、改前、改后；改成这样（推荐）/ 不改", () => {
    const html = renderToStaticMarkup(<ProposalDecision cardId="card-1" current={{ brief: "给新品牌起名", standards }}
      proposal={{ id: "00000000-0000-4000-8000-0000000000a1", standards: ["列出 3 个候选名", "近似商标由本人查"], brief: null, reason: "商标网拦自动访问", at: "2026-11-11T07:00:00.000Z" }}
      onDecided={async () => undefined} />);
    const page = text(html);
    expect(page).toMatch(/^\|提议改完成标准\|商标网拦自动访问\|改前\|列出 3 个候选名\|每个写一句含义\|近似商标的申请号\|改后\|列出 3 个候选名\|近似商标由本人查\|/);
    expect(page).toContain("|改成这样|（推荐）|");
    expect(page).toContain("|不改|");
  });
  it("对话里记一行「提议改完成标准：原因」", () => {
    const view = foldEvents([{ seq: 1, at: "2026-11-11T07:00:00.000Z", sessionId: "s1", type: "agreement_proposal", proposalKey: "k1", standards: ["近似商标由本人查"], reason: "商标网拦自动访问" }]);
    expect(view.entries).toEqual([expect.objectContaining({ kind: "notice", text: "提议改完成标准：商标网拦自动访问", code: "agreement_proposal" })]);
  });
});
