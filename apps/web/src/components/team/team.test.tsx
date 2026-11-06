import { beforeAll, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TTaskCard, TTaskView } from "@warmap/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }), usePathname: () => "/me/team" }));

import { boardCards, isAgentCard, type CardItem } from "@/lib/board/cards";
import { addPreset, cardRole, decideProposal, listProposals, listRevisions, listRoles, modelForTier, patchRole, rolesStubbed, seedStubProposal, type RoleProposalView } from "@/lib/team/roles";
import { KanbanCard } from "@/components/board/KanbanCard";
import { ReviewDoc, isReview, reviewText, splitSections } from "@/components/topics/Review";
import { Diff, Proposals, changedFields } from "./TeamPage";

const base: TTaskView = {
  id: "c1", version: 1, title: "把看板接上", status: "not_started", source: "self", startDate: null, dueDate: null, doneDefinition: "做完", mission: null, waitingOn: null,
  owner: { personId: "p1", name: "孙铭泽" }, collaborators: [], latestProgress: null, returnReason: null, origin: null, awaitingAcceptance: false, planTaskId: "t1", blocker: null,
  createdAt: "2026-11-06T01:00:00Z", updatedAt: "2026-11-06T01:00:00Z",
};
const facet: TTaskCard = { stage: "todo", wait: null, executor: "claude_code", model: null, criterion: null, run: null, handback: null, deliverable: null };

describe("岗位接口还没有时用请求桩", () => {
  beforeAll(() => { vi.stubGlobal("fetch", vi.fn(async () => new Response(JSON.stringify({ code: "NOT_FOUND" }), { status: 404 }))); });

  it("从岗位包添加是一份副本；改完保存再读还在；版本对不上 409", async () => {
    const first = await listRoles();
    expect(rolesStubbed()).toBe(true);
    expect(first.roles).toEqual([]);
    expect(first.presets.map((preset) => preset.name)).toEqual(expect.arrayContaining(["验收员", "反方", "读者视角", "开发", "代码评审", "测试", "调研员", "写稿人", "行业视角"]));
    const role = await addPreset("dev/developer");
    expect(role).toMatchObject({ name: "开发", family: "dev", kind: "worker", version: 1, presetKey: "dev/developer" });
    expect((await listRoles()).presets.find((preset) => preset.key === "dev/developer")?.added).toBe(true);

    const saved = await patchRole(role.id, { version: 1, practiceMd: "- 先写测试再改代码" });
    expect(saved.version).toBe(2);
    expect((await listRoles()).roles[0]).toMatchObject({ id: role.id, practiceMd: "- 先写测试再改代码", version: 2 });
    const [revision] = await listRevisions(role.id);
    expect(revision).toMatchObject({ version: 2, source: "manual", changes: [{ field: "practice_md", before: "", after: "- 先写测试再改代码" }] });
    await expect(patchRole(role.id, { version: 1, practiceMd: "旧版本上改" })).rejects.toMatchObject({ status: 409 });
  });

  it("待确认的修改：采纳写回、版本 +1、留一条记录；不要就丢掉", async () => {
    const [role] = (await listRoles()).roles;
    seedStubProposal();
    const [proposal] = await listProposals();
    expect(proposal).toMatchObject({ roleId: role!.id, field: "practice_md" });
    await decideProposal(proposal!.id, "accept");
    expect(await listProposals()).toEqual([]);
    const after = (await listRoles()).roles[0]!;
    expect(after.version).toBe(role!.version + 1);
    expect(after.practiceMd).toBe(proposal!.proposedText);
    expect((await listRevisions(role!.id))[0]).toMatchObject({ source: "proposal", proposalId: proposal!.id });

    seedStubProposal();
    const [again] = await listProposals();
    await decideProposal(again!.id, "dismiss");
    expect(await listProposals()).toEqual([]);
    expect((await listRoles()).roles[0]!.version).toBe(after.version);
  });
});

describe("岗位页", () => {
  const proposal: RoleProposalView = { id: "p1", roleId: "r1", roleName: "开发", sourceKind: "overrule", card: { id: "c9", title: "接本机" }, field: "practice_md",
    currentText: "- 先读代码\n- 写完跑测试", proposedText: "- 先读代码\n- 写完跑测试\n- 交回前列出每条标准的证据", why: "验收被推翻：没有能核对的证据", createdAt: "2026-11-06T01:00:00Z" };

  it("待你确认：每条有采纳、不要，写明哪个岗位、哪一段、为什么", () => {
    const html = renderToStaticMarkup(<Proposals proposals={[proposal]} onDecided={vi.fn()} />);
    expect(html).toContain("待你确认");
    expect(html).toContain("开发");
    expect(html).toContain("做法");
    expect(html).toContain("验收被推翻：没有能核对的证据");
    expect(html).toContain("接本机");
    expect(html).toContain("采纳");
    expect(html).toContain("不要");
    expect(html).toContain("看改动");
  });

  it("改前改后：删掉的行标红、加的行标绿", () => {
    const html = renderToStaticMarkup(<Diff before={"一\n二"} after={"一\n三"} />);
    expect(html).toContain('<span data-change="del">二</span>');
    expect(html).toContain('<span data-change="add">三</span>');
    expect(html).toContain("<span>一</span>");
  });

  it("保存只带改了的字段", () => {
    const role = { id: "r1", presetKey: null, presetVersion: null, name: "开发", family: "dev" as const, kind: "worker" as const, dutiesMd: "a", practiceMd: "b", acceptanceMd: "c",
      tools: ["github" as const], modelTier: "strong" as const, version: 3, updatedAt: "", updatedBy: null };
    expect(changedFields(role, { name: "开发", dutiesMd: "a", practiceMd: "b", acceptanceMd: "c", tools: ["github"], modelTier: "strong" })).toBeNull();
    expect(changedFields(role, { name: " 开发 ", dutiesMd: "a", practiceMd: "b2", acceptanceMd: "c", tools: ["github", "tianshu"], modelTier: "normal" }))
      .toEqual({ version: 3, practiceMd: "b2", tools: ["tianshu", "github"], modelTier: "normal" });
  });
});

describe("卡上写岗位名", () => {
  it("配了岗位的卡写岗位名，不写执行方；没配岗位不写", () => {
    const withRole = { ...base, card: { ...facet, role: { id: "r1", name: "调研员" } } } as CardItem;
    const [card] = boardCards([withRole]);
    /** 看得见的字（去掉图标的读屏标签）。 */
    const text = (markup: string) => markup.replace(/aria-label="[^"]*"/g, "");
    const html = text(renderToStaticMarkup(<KanbanCard card={card!} canStart={false} elsewhere={null} onStart={vi.fn()} now={0} />));
    expect(cardRole(withRole)).toEqual({ id: "r1", name: "调研员" });
    expect(html).toContain("调研员");
    expect(html).not.toContain("Claude Code");
    expect(html).not.toContain("我自己");
    const self = { ...base, id: "c2", card: { ...facet, executor: "self" as const } } as CardItem;
    expect(isAgentCard(self)).toBe(false);
    const plain = text(renderToStaticMarkup(<KanbanCard card={boardCards([self])[0]!} canStart={false} elsewhere={null} onStart={vi.fn()} now={0} />));
    expect(plain).not.toContain("我自己");
  });

  it("开始时的模型默认按岗位档位：强 Opus、中 Sonnet、轻 Haiku，认不出用默认", () => {
    const models = [
      { id: "subscription", model: null, label: "订阅", isDefault: true },
      { id: "o", model: "opus", label: "Opus", isDefault: false },
      { id: "s", model: "sonnet", label: "Sonnet", isDefault: false },
      { id: "h", model: "haiku", label: "Haiku", isDefault: false },
    ];
    expect(modelForTier(models, "strong")?.id).toBe("o");
    expect(modelForTier(models, "normal")?.id).toBe("s");
    expect(modelForTier(models, "light")?.id).toBe("h");
    expect(modelForTier(models.slice(0, 1), "strong")?.id).toBe("subscription");
  });
});

describe("专题的评审会", () => {
  it("「评审」那一版按分歧和建议排版", () => {
    const body = "## 分歧\n- 反方：样本太少\n\n## 建议\n1. 补两家对标";
    expect(isReview({ kind: "review" as never })).toBe(true);
    expect(isReview({ kind: "draft" })).toBe(false);
    expect(splitSections(body)).toEqual([{ title: "分歧", text: "- 反方：样本太少" }, { title: "建议", text: "1. 补两家对标" }]);
    const html = renderToStaticMarkup(<ReviewDoc body={body} />);
    expect(html).toContain("分歧和建议");
    expect(html).toContain('data-kind="split"');
    expect(html).toContain('data-kind="advice"');
    expect(html).toContain("样本太少");
  });
  it("评审会请的是选中的挑刺岗位", () => {
    expect(reviewText(["反方", "读者视角"])).toContain("「反方」、「读者视角」");
  });
});
