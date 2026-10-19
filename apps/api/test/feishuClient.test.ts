import { describe, expect, it } from "vitest";
import { createFeishuClient, FeishuApiError } from "../src/feishu/client.js";
import { feishuDeepLink, linkCardContent, sendFeishuLinkCard, sendFeishuText } from "../src/feishu/messages.js";

type Call = { url: string; init?: RequestInit };

function mockFetch(respond: (call: Call) => unknown) {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string, init?: RequestInit) => {
    const call = { url: String(url), init };
    calls.push(call);
    return Response.json(respond(call));
  }) as typeof fetch;
  return { calls, fetchImpl };
}

describe("飞书开放接口客户端", () => {
  it("续期走 accounts.feishu.cn v3 表单接口；20037 抛出带错误码的 FeishuApiError", async () => {
    const { calls, fetchImpl } = mockFetch(() => ({ code: 20037, error: "invalid_grant", error_description: "refresh token expired" }));
    const client = createFeishuClient({ appId: "cli_x", appSecret: "secret", fetch: fetchImpl });
    const error = await client.refreshUserToken("ur-old").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(FeishuApiError);
    expect((error as FeishuApiError).code).toBe(20037);
    expect(calls[0].url).toBe("https://accounts.feishu.cn/oauth/v3/token");
    expect(Object.fromEntries(new URLSearchParams(String(calls[0].init!.body)))).toEqual({
      client_id: "cli_x", client_secret: "secret", grant_type: "refresh_token", refresh_token: "ur-old",
    });
  });

  it("文档元数据：以本人 token 调 drive 批量元数据接口，只取标题、修订时间、修订人和所有者", async () => {
    const { calls, fetchImpl } = mockFetch(() => ({ code: 0, data: {
      metas: [{ doc_token: "doxA", doc_type: "docx", title: "M2 战略解码", latest_modify_user: "ou_x", latest_modify_time: "1792137600", owner_id: "ou_o" }],
      failed_list: [{ token: "doxB", code: 970005 }] } }));
    const client = createFeishuClient({ appId: "cli_x", appSecret: "secret", fetch: fetchImpl });
    expect(await client.getDocMetas("u-me", [{ token: "doxA", type: "docx" }, { token: "doxB", type: "wiki" }])).toEqual([
      { token: "doxA", type: "docx", title: "M2 战略解码", modifiedAt: new Date(1792137600 * 1000), modifiedBy: "ou_x", ownerId: "ou_o" }]);
    expect(calls[0].url).toBe("https://open.feishu.cn/open-apis/drive/v1/metas/batch_query?user_id_type=open_id");
    expect(new Headers(calls[0].init!.headers).get("authorization")).toBe("Bearer u-me");
    expect(JSON.parse(String(calls[0].init!.body))).toEqual({
      request_docs: [{ doc_token: "doxA", doc_type: "docx" }, { doc_token: "doxB", doc_type: "wiki" }], with_url: false });
    expect(await client.getDocMetas("u-me", [])).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("code 换 token：成功时字段换成驼峰；没给 offline_access 时没有 refresh token", async () => {
    const { calls, fetchImpl } = mockFetch(() => ({ code: 0, access_token: "u-1", expires_in: 7200, scope: "auth:user.id:read", token_type: "Bearer" }));
    const client = createFeishuClient({ appId: "cli_x", appSecret: "secret", fetch: fetchImpl });
    expect(await client.exchangeCode("code-1")).toEqual({ accessToken: "u-1", expiresIn: 7200, scope: "auth:user.id:read" });
    expect(new URLSearchParams(String(calls[0].init!.body)).get("redirect_uri")).toBeNull();
  });

  it("机器人发文本与链接卡片：tenant_access_token 复用；卡片按钮只是跳回天枢的免登链接", async () => {
    const { calls, fetchImpl } = mockFetch((call) => call.url.includes("tenant_access_token")
      ? { code: 0, tenant_access_token: "t-1", expire: 7200 }
      : { code: 0, data: { message_id: `om_${calls.length}` } });
    const client = createFeishuClient({ appId: "cli_x", appSecret: "secret", fetch: fetchImpl });
    const to = { type: "open_id" as const, id: "ou_1" };
    await sendFeishuText(client, to, "测试");
    await sendFeishuLinkCard(client, to, { title: "有一件事等你确认", body: "<b>不解析</b>", links: [{ label: "打开天枢", path: "/me/tasks/1" }] }, "https://tianshu.example");
    expect(calls.map((c) => c.url)).toEqual([
      "https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal",
      "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id",
      "https://open.feishu.cn/open-apis/im/v1/messages?receive_id_type=open_id",
    ]);
    expect((calls[1].init!.headers as Record<string, string>).authorization).toBe("Bearer t-1");
    expect(JSON.parse(String(calls[1].init!.body))).toEqual({ receive_id: "ou_1", msg_type: "text", content: JSON.stringify({ text: "测试" }) });
    const card = JSON.parse(JSON.parse(String(calls[2].init!.body)).content);
    expect(card.elements[1].actions).toEqual([{
      tag: "button", text: { tag: "plain_text", content: "打开天枢" }, type: "primary",
      url: "https://tianshu.example/api/auth/feishu/start?next=%2Fme%2Ftasks%2F1",
    }]);
  });

  it("深链接只带站内路径", () => {
    expect(feishuDeepLink("https://tianshu.example", "//evil.example")).toBe("https://tianshu.example/api/auth/feishu/start?next=%2F");
    expect(JSON.stringify(linkCardContent({ title: "t", body: "b", links: [] }, "https://tianshu.example"))).not.toContain("value");
  });
});
