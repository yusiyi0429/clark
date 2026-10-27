import { createDecipheriv } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createIlink, IlinkError, messageText } from "../src/wechat/ilink.js";

type Call = { url: string; headers: Record<string, string>; body: unknown };

function fakeFetch(answers: ((call: Call) => Response)[]) {
  const calls: Call[] = [];
  const impl = (async (input: URL | string, init?: RequestInit) => {
    const raw = init?.body;
    const call = { url: String(input), headers: (init?.headers ?? {}) as Record<string, string>,
      body: raw instanceof Uint8Array ? Buffer.from(raw) : typeof raw === "string" ? JSON.parse(raw) : undefined };
    calls.push(call);
    return answers.shift()!(call);
  }) as typeof fetch;
  return { impl, calls };
}

const json = (value: unknown) => () => new Response(JSON.stringify(value), { status: 200 });
const bot = { baseUrl: "https://ilink.example", token: "bot-secret" };

describe("iLink 协议", () => {
  it("发图片：AES-128-ECB 加密后传 CDN，image_item 带 CDN 回的参数；aes_key 是十六进制密钥再转 base64", async () => {
    const image = Buffer.from("a tiny png that is not really a png");
    const { impl, calls } = fakeFetch([
      json({ upload_param: "up-param" }),
      () => new Response("", { status: 200, headers: { "x-encrypted-param": "down-param" } }),
      json({ ret: 0 }),
    ]);
    await createIlink(impl).sendImage(bot, "wx_owner@im.wechat", "ctx-1", image);

    const [upload, cdn, send] = calls;
    const uploadBody = upload.body as { aeskey: string; filekey: string; rawsize: number; filesize: number; media_type: number };
    expect(upload.url).toBe("https://ilink.example/ilink/bot/getuploadurl");
    expect(upload.headers.Authorization).toBe("Bearer bot-secret");
    expect(uploadBody).toMatchObject({ media_type: 1, rawsize: image.length, filesize: 48 });
    expect(cdn.url).toBe(`https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=up-param&filekey=${uploadBody.filekey}`);
    const decipher = createDecipheriv("aes-128-ecb", Buffer.from(uploadBody.aeskey, "hex"), null);
    expect(Buffer.concat([decipher.update(cdn.body as Buffer), decipher.final()])).toEqual(image);
    const item = (send.body as { msg: { item_list: { image_item: { media: { encrypt_query_param: string; aes_key: string } } }[]; context_token: string } }).msg;
    expect(item.context_token).toBe("ctx-1");
    expect(item.item_list[0].image_item.media).toMatchObject({
      encrypt_query_param: "down-param", aes_key: Buffer.from(uploadBody.aeskey).toString("base64"),
    });
  });

  it("发文字：ret 不为 0 算失败；没有会话凭证时不带 context_token", async () => {
    const { impl, calls } = fakeFetch([json({ ret: 0 }), json({ ret: -2, errmsg: "limit" })]);
    const ilink = createIlink(impl);
    await ilink.sendText(bot, "wx_owner@im.wechat", null, "你好");
    expect((calls[0].body as { msg: object }).msg).not.toHaveProperty("context_token");
    await expect(ilink.sendText(bot, "wx_owner@im.wechat", "ctx", "再来")).rejects.toMatchObject({ ret: -2 } satisfies Partial<IlinkError>);
  });

  it("消息文字：文字和微信转好的语音拼起来，图片不算", () => {
    expect(messageText({ item_list: [{ type: 1, text_item: { text: "第一句" } }, { type: 3, voice_item: { text: "语音转的" } }, { type: 2 }] }))
      .toBe("第一句\n语音转的");
    expect(messageText({ item_list: [{ type: 2 }] })).toBe("");
  });
});
