import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ requireMember: vi.fn(async () => ({ cookie: "session=test" })), load: vi.fn(async (_cookie: string, id: string) => ({ id })) }));
vi.mock("@/lib/api/server", () => ({ requireMember: mocks.requireMember }));
vi.mock("@/components/member/loadMemberBattlefield", () => ({ loadMemberBattlefield: mocks.load }));
vi.mock("@/components/member/MemberBattlefieldScreen", () => ({ MemberBattlefieldScreen: () => null }));
import MemberBattlefieldPage from "./page";

beforeEach(() => vi.clearAllMocks());

describe("成员战场详情页路由参数", () => {
  it("中文战场 id 解码后再读接口，避免双编码后 404", async () => {
    const segment = encodeURIComponent("灯塔项目");
    await MemberBattlefieldPage({ params: Promise.resolve({ id: segment }) });
    expect(mocks.load).toHaveBeenCalledWith("session=test", "灯塔项目");
    expect(mocks.requireMember).toHaveBeenCalledWith(`/me/battlefields/${segment}`);
  });
});
