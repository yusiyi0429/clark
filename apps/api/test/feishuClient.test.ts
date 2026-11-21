import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { createFeishuClient, FeishuApiError, feishuUuid, type FeishuClient } from "../src/feishu/client.js";
import { feishuDeepLink, linkCardContent, sendFeishuLinkCard, sendFeishuText } from "../src/feishu/messages.js";
import { FEISHU_NOTIFY_KIND, feishuNotifier, feishuNotifyJobs } from "../src/feishu/notify.js";
import { createJobWorker } from "../src/jobs.js";
import { createTestDb } from "./helpers.js";

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

  it("发消息带 uuid 时请求体里有 uuid，不带时没有这个字段；uuid 是 key 的 sha256 十六进制前 32 位；5xx 记下 HTTP 状态", async () => {
    let status = 200;
    const calls: Call[] = [];
    const fetchImpl = (async (url: string, init?: RequestInit) => {
      calls.push({ url: String(url), init });
      if (String(url).includes("tenant_access_token")) return Response.json({ code: 0, tenant_access_token: "t-1", expire: 7200 });
      return Response.json(status === 200 ? { code: 0, data: { message_id: "om_1" } } : { code: 1500, msg: "internal error" }, { status });
    }) as typeof fetch;
    const client = createFeishuClient({ appId: "cli_x", appSecret: "secret", fetch: fetchImpl });
    const to = { type: "open_id" as const, id: "ou_1" };
    const uuid = feishuUuid("feishu.notify:k1");
    expect(uuid).toBe(createHash("sha256").update("feishu.notify:k1").digest("hex").slice(0, 32));
    await sendFeishuText(client, to, "测试", { uuid });
    await sendFeishuLinkCard(client, to, { title: "t", body: "b", links: [] }, "https://tianshu.example", { uuid });
    await sendFeishuText(client, to, "测试");
    const bodies = calls.slice(1).map((c) => JSON.parse(String(c.init!.body)));
    expect(bodies[0].uuid).toBe(uuid);
    expect(bodies[1].uuid).toBe(uuid);
    expect("uuid" in bodies[2]).toBe(false);
    status = 503;
    const error = await sendFeishuText(client, to, "测试").catch((e: unknown) => e);
    expect(error).toMatchObject({ code: 1500, httpStatus: 503 });
  });

  it("深链接只带站内路径", () => {
    expect(feishuDeepLink("https://tianshu.example", "//evil.example")).toBe("https://tianshu.example/api/auth/feishu/start?next=%2F");
    expect(JSON.stringify(linkCardContent({ title: "t", body: "b", links: [] }, "https://tianshu.example"))).not.toContain("value");
  });
});

describe("飞书通知任务", () => {
  const T0 = new Date("2026-11-21T02:00:00Z");
  const MINUTE = 60_000;
  const timeout = () => new DOMException("The operation was aborted due to timeout", "TimeoutError");

  /** 入队一条通知，按给定的首次尝试时间和已尝试次数摆好，用会抛错的假飞书客户端跑 worker。 */
  async function run(steps: { createdAt: Date; attempts: number; error: () => unknown }, check: (r: {
    tick: (at: Date) => Promise<number>; row: () => Promise<{ status: string; attempts: number; run_at: Date }>; uuids: (string | undefined)[];
  }) => Promise<void>) {
    await createTestDb(async ({ db, pool }) => {
      const q = pool.query.bind(pool);
      await q("INSERT INTO feishu_identities (person_id, open_id) VALUES ('p1', 'ou_1')");
      await feishuNotifier(q)({ personId: "p1", title: "t", body: "b", links: [] }, "k1");
      await q("UPDATE jobs SET created_at = $1, run_at = $2, attempts = $3", [steps.createdAt, T0, steps.attempts]);
      const uuids: (string | undefined)[] = [];
      const client: Pick<FeishuClient, "sendMessage"> = { sendMessage: async (_type, _id, _msgType, _content, options) => {
        uuids.push(options?.uuid);
        throw steps.error();
      } };
      let clock = T0;
      const worker = createJobWorker({ pool, handlers: feishuNotifyJobs({ pool, client, publicOrigin: "https://tianshu.example", now: () => clock }), now: () => clock });
      await check({
        tick: (at) => { clock = at; return worker.tick(); },
        row: async () => (await db.query("SELECT status, attempts, run_at FROM jobs WHERE kind = $1", [FEISHU_NOTIFY_KIND])).rows[0],
        uuids,
      });
    }, { migrated: true });
  }

  it("每次重试发出的 uuid 都一样，是 dedupe_key 算出来的", async () => {
    await run({ createdAt: T0, attempts: 0, error: timeout }, async ({ tick, row, uuids }) => {
      expect(await tick(T0)).toBe(1);
      expect(await row()).toMatchObject({ status: "pending", attempts: 1 });
      expect(await tick(new Date(T0.getTime() + MINUTE))).toBe(1);
      expect(await row()).toMatchObject({ status: "pending", attempts: 2 });
      expect(uuids).toEqual([feishuUuid(`${FEISHU_NOTIFY_KIND}:k1`), feishuUuid(`${FEISHU_NOTIFY_KIND}:k1`)]);
    });
  });

  it("第一次尝试 61 分钟后超时：按完成处理并记日志，不再排重试", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await run({ createdAt: new Date(T0.getTime() - 61 * MINUTE), attempts: 2, error: timeout }, async ({ tick, row }) => {
        expect(await tick(T0)).toBe(1);
        expect(await row()).toMatchObject({ status: "done", attempts: 3 });
      });
      expect(warn.mock.calls.map((c) => String(c[0])).join("\n")).toContain("送达未知，超过飞书去重窗口，不再重发");
    } finally { warn.mockRestore(); }
  });

  it("下一次重试会落在第一次尝试 1 小时以后时，送达未知也不再重发；还在窗口里照常重试", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // 第 4 次在 36 分钟，下一次排在 2 小时以后：超窗，不重发
      await run({ createdAt: new Date(T0.getTime() - 36 * MINUTE), attempts: 3, error: () => new TypeError("fetch failed") }, async ({ tick, row }) => {
        await tick(T0);
        expect(await row()).toMatchObject({ status: "done", attempts: 4 });
      });
      // 第 3 次在 6 分钟、飞书 5xx，下一次排在 36 分钟：还在窗口里
      await run({ createdAt: new Date(T0.getTime() - 6 * MINUTE), attempts: 2, error: () => new FeishuApiError(1500, "internal error", 503) }, async ({ tick, row }) => {
        await tick(T0);
        expect(await row()).toMatchObject({ status: "pending", attempts: 3, run_at: new Date(T0.getTime() + 30 * MINUTE) });
      });
    } finally { vi.mocked(console.warn).mockRestore(); }
  });

  it("明确的 4xx 业务错误照退避重试，超窗也一样", async () => {
    await run({ createdAt: new Date(T0.getTime() - 61 * MINUTE), attempts: 2, error: () => new FeishuApiError(230002, "发送飞书消息失败：bot not in chat", 400) }, async ({ tick, row }) => {
      await tick(T0);
      expect(await row()).toMatchObject({ status: "pending", attempts: 3, run_at: new Date(T0.getTime() + 30 * MINUTE) });
    });
  });
});
