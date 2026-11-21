import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TTeamDelivery, TRequestListItem } from "@warmap/contracts";
import { resolveTeamNames, isTeamDraft, teamIntent } from "@/lib/home/teamIntent";
import { replyTeamDelivery, sendTeamDelivery } from "@/lib/home/teamDelivery";
import { draftPayload, newTeamDraft } from "./PartnerTeamCompose";
import { CollectionRoundCard, TeamDeliveryCard } from "./PartnerTeamCard";

const directory = [{ personId: "p-lin", displayName: "小林" }, { personId: "p-wang", displayName: "小王" },
  { personId: "p-zhou1", displayName: "周舟" }, { personId: "p-zhou2", displayName: "周舟" }];
const at = "2026-11-13T04:00:00.000Z";
const content = new File(["原件\n收到"], "报价.txt", { type: "text/plain" });
const attachment = { id: "a", fileName: "报价.txt", size: content.size, sha256: "a".repeat(64), href: "/api/me/team-deliveries/q/attachments/a" };
const delivery: TTeamDelivery = { id: "q", kind: "question", text: "客户希望下一版改什么？", sourceUrl: "https://example.org/report", dueAt: at, createdAt: at,
  sender: { personId: "alice", displayName: "发起人" }, attachments: [attachment], recipients: [] };
const member = { personId: "p-lin", displayName: "小林", status: "pending" as const, error: null, replies: [] };
const card = (item: TTeamDelivery, sent: boolean) => renderToStaticMarkup(<TeamDeliveryCard delivery={item} sent={sent} onSaved={() => {}} onForward={() => {}} />);
afterEach(() => vi.unstubAllGlobals());

describe("伙伴主对话的团队指令", () => {
  it("原文和实际文件与地址分开，只选择唯一匹配的成员 ID", () => {
    expect(teamIntent("发给小林的伙伴", [content])).toMatchObject({ kind: "share", names: ["小林"], text: "", review: false });
    expect(teamIntent("把这份文件发给小林", [content])).toMatchObject({ names: ["小林"], review: false });
    expect(teamIntent("发给小林和小王：只转这两行\n保留第二行", [])).toMatchObject({ names: ["小林", "小王"], text: "只转这两行\n保留第二行" });
    expect(teamIntent("发给小林：https://example.org/source", [])).toMatchObject({ text: "", sourceUrl: "https://example.org/source" });
    expect(teamIntent("把 https://example.org/source 发给小林，附言：请核对报价", [])).toMatchObject({ names: ["小林"], text: "请核对报价", sourceUrl: "https://example.org/source" });
    expect(teamIntent("发给小林：原文，附言：内容照发", [])).toMatchObject({ names: ["小林"], text: "原文，附言：内容照发" });
    expect(teamIntent("发给小林：本周开销填写有误", [])).toMatchObject({ names: ["小林"], text: "本周开销填写有误" });
    expect(resolveTeamNames(["小林", "周舟", "小王", "产品", "小林"], directory)).toEqual({ ids: ["p-lin", "p-wang"], unresolved: ["周舟", "产品"] });
    expect(resolveTeamNames(["p-zhou2"], directory)).toEqual({ ids: ["p-zhou2"], unresolved: [] });
  });

  it("无地址、代拟和缺原文件时让本人核对，附件不会先传给模型", () => {
    expect(isTeamDraft("", [content])).toBe(true);
    expect(teamIntent("", [content])).toMatchObject({ review: true, names: [] });
    expect(teamIntent("把报价文件发给小林", [])).toMatchObject({ review: true, text: "" });
    expect(teamIntent("请帮我拟一段说明发给小林", [])).toMatchObject({ review: true, text: "", names: ["小林"] });
    expect(teamIntent("发给小林的伙伴", [])).toMatchObject({ text: "" });
    expect(draftPayload({ ...newTeamDraft(), recipientIds: ["p-lin"] })).toBeNull();
  });

  it("临时征集推算明确的截止日供核对，固定场景与对文件的追问继续走原对话", () => {
    expect(teamIntent("问小林和小王：准备好了吗？", [])).toMatchObject({ kind: "question", names: ["小林", "小王"], text: "准备好了吗？", review: false });
    expect(teamIntent("请产品和销售各给我两条客户反馈，周四前回", [], new Date(at))).toMatchObject({
      kind: "question", names: ["产品", "销售"], dueAt: "2026-11-19T23:59", review: true,
    });
    expect(teamIntent("问小林：截止到2026-02-31，有什么反馈？", [], new Date(at))?.dueAt).toBe("");
    for (const text of ["请发起每周开销收集", "向方法部收集每周进展", "给我总结刚收到的文件", "请问这个项目，什么时候交付？", "发给我的文件里有什么？", "问伙伴：那份文件写了什么？"]) {
      expect(isTeamDraft(text, [])).toBe(false);
    }
    const draft = { ...newTeamDraft("question"), text: "反馈", recipientIds: ["p-lin"], dueAt: "2026-11-19T23:59" };
    expect(draftPayload(draft)?.dueAt).toBe("2026-11-19T15:59:00.000Z");
  });

  it("只递送已选择的版本和成员，上传正文与可独立访问的来源同时保留", () => {
    const draft = { ...newTeamDraft(), recipientIds: ["p-lin"], text: "只给这一段", sourceUrl: "https://example.org/doc", sources: [{ ...attachment, createdAt: at }] };
    expect(draftPayload(draft)).toEqual({ clientId: draft.clientId, recipientIds: ["p-lin"], kind: "share", text: "只给这一段", sourceUrl: draft.sourceUrl,
      sourceAttachments: [{ id: "a", sha256: attachment.sha256 }] });
    expect(draftPayload({ ...draft, sourceUrl: "javascript:void(0)" })).toBeNull();
  });
});

describe("伙伴自己的时间线", () => {
  it("多成员进度留在首层，默认只收起历史与原文件，历史里的转发仍可到达", () => {
    const html = card({ ...delivery, recipients: [
      { ...member, status: "answered", replies: [{ id: "history", status: "answered", text: "很长的中文反馈".repeat(30), attachments: [attachment], createdAt: at }] },
      { ...member, personId: "p-wang", displayName: "小王", status: "needs_info" },
      { ...member, personId: "p-zhou", displayName: "小周", status: "pending" },
    ] }, true);
    const disclosures = [...html.matchAll(/<details\b([^>]*)>([\s\S]*?)<\/details>/g)];
    expect(disclosures).toHaveLength(2);
    disclosures.forEach((disclosure) => expect(disclosure[1]).not.toMatch(/\bopen(?:=|\s|$)/));
    expect(disclosures[0][2]).toContain("附件 · 1");
    expect(disclosures[0][2]).toContain(attachment.href);
    expect(disclosures[1][2]).toContain("1 条往来");
    expect(disclosures[1][2]).toContain("转发这条回复");
    const firstLevel = html.replace(/<details\b[^>]*>[\s\S]*?<\/details>/g, "");
    for (const word of ["客户希望下一版改什么？", "https://example.org/report", "小林", "小王", "小周", "已回复", "需补充", "待回复", "给小王补充说明"]) expect(firstLevel).toContain(word);
  });

  it("发起人看同一征集的分人结果、失败项的单独重试、按人澄清和可选的回复文字", () => {
    const html = card({ ...delivery, recipients: [
      { ...member, status: "needs_info", replies: [{ id: "r1", status: "needs_info", text: "还缺成本范围", attachments: [attachment], createdAt: at }] },
      { ...member, personId: "p-wang", displayName: "小王", status: "failed", error: "此成员暂不能接收" },
    ] }, true);
    for (const word of ["team-request-q", "客户希望下一版改什么？", "team-reply-r1", "需补充", "给小林补充说明", "转发这条回复", "送达失败", "此成员暂不能接收", "重试给小王的投递", "回复截止", attachment.href]) expect(html).toContain(word);
    expect(html).not.toContain("重试给小林的投递");
    expect(html).not.toContain("追加回复");
  });

  it("收件人可提交文字/附件或澄清；普通资料在对话里打开，不要求提交", () => {
    const question = card({ ...delivery, recipients: [member] }, false);
    for (const word of ["发起人发起的征集", "我的进度", "待回复", "缺材料或需澄清", "向发送人申请可读版本", attachment.href]) expect(question).toContain(word);
    expect(question).not.toContain("小王");
    const share = card({ ...delivery, kind: "share", recipients: [{ ...member, status: "delivered" }] }, false);
    expect(share).toContain("发起人分享的资料");
    expect(share).not.toContain("需澄清");
    expect(share).not.toContain("待回复");
  });

  it("固定收集仍回到原轮次的字段和确认；待确认与已确认分开", () => {
    const item: TRequestListItem = { id: "round-1", kind: "collection", title: "每周进展", status: "open", initiatorName: "小林", createdAt: at, sentAt: at,
      myStatus: "pending", recipientNames: ["小王"], recipientsDone: 0, openQuestions: 0, unread: false, fieldsFilled: { filled: 1, required: 3 } };
    const html = renderToStaticMarkup(<CollectionRoundCard item={item} sent={false} />);
    expect(html).toContain('href="/me/requests/round-1"');
    expect(html).toContain("已填 1/3 栏 · 待确认");
    expect(html).toContain("填写并确认本轮收集");
    expect(renderToStaticMarkup(<CollectionRoundCard item={item} sent />)).toContain("查看本轮汇总");
  });
});

describe("实际文件的收发", () => {
  it("投递和回复均使用有序 multipart；重试保持同一个操作编号和原文件字节", async () => {
    const fetcher = vi.fn(async (_url: string, _options: RequestInit) => Response.json({ delivery }));
    vi.stubGlobal("fetch", fetcher);
    const payload = { clientId: "once", kind: "share" as const, recipientIds: ["p-lin"], text: "说明" };
    await sendTeamDelivery(payload, [content]);
    await sendTeamDelivery(payload, [content]);
    await replyTeamDelivery("q", { clientId: "reply-once", status: "clarification", recipientId: "p-lin", text: "请看附件" }, [content]);
    const forms = fetcher.mock.calls.map(([, options]) => options.body as FormData);
    for (const body of forms) {
      expect([...body.keys()]).toEqual(["payload", "files"]);
      const file = body.get("files") as File;
      expect(file.name).toBe("报价.txt"); expect(await file.text()).toBe("原件\n收到");
    }
    expect(forms[0]?.get("payload")).toBe(forms[1]?.get("payload"));
    expect(fetcher.mock.calls[2]?.[0]).toBe("/api/me/team-deliveries/q/replies");
    expect(JSON.parse(String(forms[2]?.get("payload")))).toMatchObject({ recipientId: "p-lin", status: "clarification" });
  });
});
