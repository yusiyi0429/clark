import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card, CardAction } from "./api/client";
import { useCardAction } from "./useCardAction";

const api = vi.hoisted(() => ({ POST: vi.fn() }));
vi.mock("./api/client", () => ({ browserApi: api }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));
afterEach(() => vi.clearAllMocks());

describe("Action 客户端端点", () => {
  it.each([undefined, "/api/mission-rounds/actions/execute"] as const)("%s 只提交 opaque 锚与 input，成功交回服务端 Card", async (endpoint) => {
    let action!: ReturnType<typeof useCardAction>;
    const onCard = vi.fn();
    function Harness() { action = useCardAction(onCard, endpoint); return null; }
    renderToStaticMarkup(<Harness />);
    const descriptor = { actionId: "opaque-signed-slot", actionType: "mission-round.draft", label: "整理个人卡草稿" } as CardAction;
    const updated = { id: "mission-round:actual", kind: "mission-round" } as Card;
    api.POST.mockResolvedValue({ data: { cards: [updated] }, response: { status: 200 } });
    await expect(action.run(descriptor)).resolves.toEqual(updated);
    expect(api.POST).toHaveBeenCalledExactlyOnceWith(endpoint ?? "/api/actions/execute", { body: { actionId: "opaque-signed-slot", input: {} } });
    expect(onCard).toHaveBeenCalledExactlyOnceWith(updated);
  });
});
