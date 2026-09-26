import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement, ReactNode } from "react";
import type { Card } from "@/lib/api/client";
import type { DocumentControls } from "./CardDocument";
import { personalPayload } from "./personalMissionFixture";

const ui = vi.hoisted(() => ({
  state: [] as unknown[], cursor: 0, controls: null as DocumentControls | null,
  buttons: new Map<string, { onPress?: () => Promise<void> | void; isDisabled?: boolean }>(),
  post: vi.fn(), get: vi.fn(), register: vi.fn(), refresh: vi.fn(), ask: vi.fn(),
  roundProps: null as { onAction: (action: unknown) => Promise<void> | void } | null,
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useEffect: () => {}, useState: (initial: unknown) => {
    const index = ui.cursor++;
    if (!(index in ui.state)) ui.state[index] = initial;
    return [ui.state[index], (value: unknown) => { ui.state[index] = typeof value === "function" ? value(ui.state[index]) : value; }];
  } };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: ui.refresh }) }));
vi.mock("@/lib/api/client", () => ({ browserApi: { GET: ui.get, POST: ui.post } }));
vi.mock("@/components/shell/WorkspaceContext", () => ({ useWorkspace: () => ({ close: vi.fn(), navigate: vi.fn(), viewerId: "viewer" }), useRegisterDetail: ui.register }));
vi.mock("@/components/shell/DetailFrame", () => ({ DetailFrame: ({ children }: { children: ReactNode }) => <div>{children}</div> }));
vi.mock("@/components/ConfirmDialog", () => ({ useConfirm: () => ({ ask: ui.ask, dialog: null }) }));
vi.mock("./useRoundNow", () => ({ useRoundNow: (_at: string, now: string) => Date.parse(now) }));
vi.mock("@heroui/react", () => { const part = ({ children }: { children: ReactNode }) => <>{children}</>; return { Modal: Object.assign(() => null, { Backdrop: part, Container: part, Dialog: part }) }; });
vi.mock("ts-design/primitives", () => ({ Button: ({ children, onPress, isDisabled }: { children: ReactNode; onPress?: () => Promise<void> | void; isDisabled?: boolean }) => { ui.buttons.set(String(children), { onPress, isDisabled }); return <button disabled={isDisabled}>{children}</button>; } }));
vi.mock("./RoundLine", () => ({ RoundLine: (props: { onAction: (action: unknown) => Promise<void> | void }) => { ui.roundProps = props; return null; } }));
vi.mock("./CardDocument", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./CardDocument")>();
  return { ...actual, CardDocument: ({ controls }: { controls: DocumentControls }) => { ui.controls = controls; return <>{controls.proposalEditor?.(personalPayload.card.missions[0], "outcome")}</>; } };
});
import { MissionCardScreen } from "./MissionCardScreen";

const card = { id: "personal-card", kind: "personal-mission-card", payload: personalPayload, actions: [], conversation: { scope: "mission-card:card" } } as unknown as Card;
const mission = personalPayload.card.missions[0];
function render() { ui.cursor = 0; ui.buttons.clear(); return renderToStaticMarkup(<MissionCardScreen initialCard={card} entry="member" />); }
function edit(text: string) {
  const editor = ui.controls!.proposalEditor!(mission, "outcome") as ReactElement<{ children: ReactElement[] }>;
  const textarea = editor.props.children[1] as ReactElement<{ onChange: (event: { target: { value: string } }) => void }>;
  textarea.props.onChange({ target: { value: text } });
  render();
}
async function submit() { ui.buttons.get("提交修改建议")!.onPress!(); await vi.waitFor(() => expect(ui.post).toHaveBeenCalled()); await new Promise((resolve) => setTimeout(resolve, 0)); return render(); }
beforeEach(() => { ui.state = []; ui.cursor = 0; ui.controls = null; vi.clearAllMocks(); ui.get.mockResolvedValue({ response: { ok: true }, data: { cards: [card] } }); ui.ask.mockResolvedValue(true); });

describe("个人卡建议交互", () => {
  it("建议提交带当时版本、字段与轮次，成功才清空；同时刷新左侧意见", async () => {
    ui.post.mockResolvedValue({ response: { ok: true } });
    render(); ui.controls!.onPropose(mission, "outcome"); render(); edit("与团队核验的新结果");
    const html = await submit();
    expect(ui.post).toHaveBeenCalledWith("/api/mission-cards/{cardId}/feedback", expect.objectContaining({ params: { path: { cardId: "card" } }, body: expect.objectContaining({ kind: "suggestion", round: 1, sourceVersion: 1, missionId: "mission", field: "outcome", proposed: "与团队核验的新结果" }) }));
    expect(ui.get).toHaveBeenCalled();
    expect(html).not.toContain("textarea");
    expect(html).toContain("修改建议已记录");
  });
  it("网络失败保留输入，原样重试复用 clientId，编辑后成为新尝试", async () => {
    ui.post.mockRejectedValue(new Error("网络暂时断开"));
    render(); ui.controls!.onPropose(mission, "outcome"); render(); edit("尚未送达的新结果");
    expect(await submit()).toContain("尚未送达的新结果");
    const first = ui.post.mock.calls[0][1].body.clientId;
    await submit();
    expect(ui.post.mock.calls[1][1].body.clientId).toBe(first);
    edit("修改后的新结果"); await submit();
    expect(ui.post.mock.calls[2][1].body.clientId).not.toBe(first);
  });
  it("版本冲突保留正在写的建议并显示服务端原因", async () => {
    ui.post.mockResolvedValue({ response: { ok: false, status: 409 }, error: { message: "页面版本已变化，请刷新后重新提交" } });
    render(); ui.controls!.onPropose(mission, "outcome"); render(); edit("待重新核对的输入");
    const html = await submit();
    expect(html).toContain("待重新核对的输入");
    expect(html).toContain("页面版本已变化，请刷新后重新提交");
  });
  it.each([new TypeError("Failed to fetch"), new Error("NetworkError when attempting to fetch resource.")])("断网错误在建议输入旁用中文呈现，不让人滚回页首找失败原因", async (failure) => {
    ui.post.mockRejectedValue(failure);
    render(); ui.controls!.onPropose(mission, "outcome"); render(); edit("断网时继续保留的建议");
    const html = await submit();
    expect(html).toContain("暂时无法连接服务器，请稍后重试；输入已保留。");
    expect(html).not.toContain(failure.message);
    expect(html.indexOf('role="alert"')).toBeGreaterThan(html.indexOf("</textarea>"));
    expect(html.indexOf('role="alert"')).toBeLessThan(html.indexOf(">提交修改建议</button>"));
    expect(html).toContain('aria-describedby="proposal-error-mission-outcome"');
    expect(html).toContain("断网时继续保留的建议");
  });
  it("划词交给当前个人卡群组并带源版本，超长引用给可操作提示", () => {
    render(); ui.controls!.onQuote(mission, "outcome", "形成可核验结果"); render();
    expect(ui.register.mock.calls.at(-1)![0]).toMatchObject({ scope: "mission-card:card", group: { cardId: "card", viewerId: "viewer", round: 1, reference: { missionId: "mission", field: "outcome", sourceVersion: 1, quote: "形成可核验结果" } } });
    ui.controls!.onQuote(mission, "outcome", "长".repeat(2001));
    expect(render()).toContain("请划选其中一段引用");
  });
});
