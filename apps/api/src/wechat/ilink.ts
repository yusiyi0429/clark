import { createCipheriv, createHash, randomBytes, randomUUID } from "node:crypto";

/**
 * 微信 ClawBot 的 iLink 接口（ilinkai.weixin.qq.com）。没有公开文档，请求格式照腾讯官方插件
 * @tencent-weixin/openclaw-weixin 2.4.10 的源码；实测结论见 .scratch/wechat-bridge/README.md。
 * - 扫码绑定：get_bot_qrcode → 长轮询 get_qrcode_status，confirmed 时给 bot token、扫码人的 ilink_user_id 和这个 bot 的接口地址。
 * - 收消息：getupdates 长轮询，带上一次的游标 get_updates_buf；errcode/ret = -14 表示绑定失效，要重新扫码。
 * - 发消息：sendmessage；HTTP 200 不算成功，要看 ret。context_token 用本人最近一条消息带来的，没有也能发（10/27 实测）。
 * - 发图片：getuploadurl 拿上传参数 → AES-128-ECB 加密后传到微信 CDN → sendmessage 带 image_item。
 */
export const ILINK_BASE_URL = "https://ilinkai.weixin.qq.com";
const CDN_BASE_URL = "https://novac2c.cdn.weixin.qq.com/c2c";
const CHANNEL_VERSION = "2.4.10";
const HEADERS = { "iLink-App-Id": "bot", "iLink-App-ClientVersion": String((2 << 16) | (4 << 8) | 10) };
const BASE_INFO = { channel_version: CHANNEL_VERSION, bot_agent: "Tianshu/1.0" };
export const STALE_TOKEN = -14;
/** getupdates 的默认长轮询时长；服务端会在回包里给下一次用的时长。 */
export const LONG_POLL_MS = 35_000;

export type IlinkFetch = typeof fetch;
export type IlinkBot = { baseUrl: string; token: string };
export type IlinkMessage = {
  message_type?: number;
  from_user_id?: string;
  context_token?: string;
  item_list?: { type?: number; text_item?: { text?: string }; voice_item?: { text?: string } }[];
};
export type IlinkUpdates = { ret?: number; errcode?: number; errmsg?: string; msgs?: IlinkMessage[]; get_updates_buf?: string; longpolling_timeout_ms?: number };
export type QrStatus = {
  status: "wait" | "scaned" | "confirmed" | "expired" | "scaned_but_redirect" | "need_verifycode" | string;
  bot_token?: string; ilink_bot_id?: string; ilink_user_id?: string; baseurl?: string; redirect_host?: string;
};

export class IlinkError extends Error {
  constructor(message: string, readonly ret?: number) { super(message); }
}

/** uint64 的消息 id 先加引号再解析，免得丢精度（官方插件同样处理）。 */
const parse = <T>(text: string): T => JSON.parse(text.replace(/"(message_id|msg_id|svr_id)"\s*:\s*(-?\d+)/g, '"$1":"$2"')) as T;

/** 文字消息与语音（微信已转好的文字）拼成一句；图片、文件等返回空串。 */
export function messageText(message: IlinkMessage): string {
  return (message.item_list ?? [])
    .map((item) => (item.type === 1 ? item.text_item?.text : item.type === 3 ? item.voice_item?.text : undefined))
    .filter(Boolean).join("\n").trim();
}

export function createIlink(fetchImpl: IlinkFetch = fetch) {
  async function post<T>(base: string, endpoint: string, body: object, token: string | undefined, timeoutMs: number, signal?: AbortSignal): Promise<T> {
    const response = await fetchImpl(new URL(endpoint, `${base}/`), {
      method: "POST",
      headers: {
        ...HEADERS, "Content-Type": "application/json", AuthorizationType: "ilink_bot_token",
        "X-WECHAT-UIN": Buffer.from(String(randomBytes(4).readUInt32BE(0))).toString("base64"),
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
      },
      body: JSON.stringify({ ...body, base_info: BASE_INFO }),
      signal: signal ? AbortSignal.any([AbortSignal.timeout(timeoutMs), signal]) : AbortSignal.timeout(timeoutMs),
    });
    const text = await response.text();
    if (!response.ok) throw new IlinkError(`${endpoint} HTTP ${response.status}`);
    return parse<T>(text);
  }

  const checked = <T extends { ret?: number; errmsg?: string }>(endpoint: string, resp: T): T => {
    if (resp.ret && resp.ret !== 0) throw new IlinkError(`${endpoint} ret=${resp.ret} ${resp.errmsg ?? ""}`.trim(), resp.ret);
    return resp;
  };

  async function sendItem(bot: IlinkBot, to: string, contextToken: string | null, item: object): Promise<void> {
    const resp = await post<{ ret?: number; errmsg?: string }>(bot.baseUrl, "ilink/bot/sendmessage", {
      msg: {
        from_user_id: "", to_user_id: to, client_id: `tianshu-${randomUUID()}`, message_type: 2, message_state: 2,
        item_list: [item], ...(contextToken ? { context_token: contextToken } : {}),
      },
    }, bot.token, 15_000);
    checked("sendmessage", resp);
  }

  return {
    /** 要一张绑定二维码：qrcode 用来查状态，qrcodeUrl 是二维码里编码的内容。 */
    async qrcode(): Promise<{ qrcode: string; qrcodeUrl: string }> {
      const resp = await post<{ qrcode: string; qrcode_img_content: string }>(ILINK_BASE_URL, "ilink/bot/get_bot_qrcode?bot_type=3", { local_token_list: [] }, undefined, 15_000);
      return { qrcode: resp.qrcode, qrcodeUrl: resp.qrcode_img_content };
    },

    /** 长轮询扫码状态；本地超时当作还在等。 */
    async qrStatus(base: string, qrcode: string, timeoutMs = LONG_POLL_MS): Promise<QrStatus> {
      try {
        const response = await fetchImpl(new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, `${base}/`),
          { headers: HEADERS, signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) throw new IlinkError(`get_qrcode_status HTTP ${response.status}`);
        return JSON.parse(await response.text()) as QrStatus;
      } catch (error) {
        if ((error as Error).name === "TimeoutError") return { status: "wait" };
        throw error;
      }
    },

    async notifyStart(bot: IlinkBot): Promise<void> {
      await post(bot.baseUrl, "ilink/bot/msg/notifystart", {}, bot.token, 10_000);
    },

    async notifyStop(bot: IlinkBot): Promise<void> {
      await post(bot.baseUrl, "ilink/bot/msg/notifystop", {}, bot.token, 10_000);
    },

    /** 长轮询收消息；本地超时返回空结果，调用方接着轮询。 */
    async updates(bot: IlinkBot, cursor: string, timeoutMs: number, signal?: AbortSignal): Promise<IlinkUpdates> {
      try {
        return await post<IlinkUpdates>(bot.baseUrl, "ilink/bot/getupdates", { get_updates_buf: cursor }, bot.token, timeoutMs + 5_000, signal);
      } catch (error) {
        if ((error as Error).name === "TimeoutError" || signal?.aborted) return { ret: 0, msgs: [], get_updates_buf: cursor };
        throw error;
      }
    },

    /** 「正在输入」要先拿 typing_ticket；拿不到就不显示，不影响回答。 */
    async typingTicket(bot: IlinkBot, to: string, contextToken: string | null): Promise<string | null> {
      const resp = await post<{ typing_ticket?: string }>(bot.baseUrl, "ilink/bot/getconfig",
        { ilink_user_id: to, ...(contextToken ? { context_token: contextToken } : {}) }, bot.token, 10_000).catch(() => ({ typing_ticket: undefined }));
      return resp.typing_ticket || null;
    },

    async typing(bot: IlinkBot, to: string, ticket: string, on: boolean): Promise<void> {
      await post(bot.baseUrl, "ilink/bot/sendtyping", { ilink_user_id: to, typing_ticket: ticket, status: on ? 1 : 2 }, bot.token, 10_000).catch(() => undefined);
    },

    async sendText(bot: IlinkBot, to: string, contextToken: string | null, text: string): Promise<void> {
      await sendItem(bot, to, contextToken, { type: 1, text_item: { text } });
    },

    /** 图片：明文算 md5，随机 16 字节 AES 密钥加密后传 CDN，CDN 回的下载参数放进 image_item。 */
    async sendImage(bot: IlinkBot, to: string, contextToken: string | null, image: Buffer): Promise<void> {
      const filekey = randomBytes(16).toString("hex");
      const aeskey = randomBytes(16);
      const cipher = createCipheriv("aes-128-ecb", aeskey, null);
      const ciphertext = Buffer.concat([cipher.update(image), cipher.final()]);
      const upload = checked("getuploadurl", await post<{ ret?: number; errmsg?: string; upload_full_url?: string; upload_param?: string }>(bot.baseUrl, "ilink/bot/getuploadurl", {
        filekey, media_type: 1, to_user_id: to, rawsize: image.length, rawfilemd5: createHash("md5").update(image).digest("hex"),
        filesize: ciphertext.length, no_need_thumb: true, aeskey: aeskey.toString("hex"),
      }, bot.token, 15_000));
      const target = upload.upload_full_url?.trim()
        || (upload.upload_param ? `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(upload.upload_param)}&filekey=${encodeURIComponent(filekey)}` : "");
      if (!target) throw new IlinkError("getuploadurl 没有给上传地址");
      const response = await fetchImpl(target, { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Uint8Array(ciphertext), signal: AbortSignal.timeout(30_000) });
      const downloadParam = response.headers.get("x-encrypted-param");
      if (response.status !== 200 || !downloadParam) throw new IlinkError(`CDN 上传失败 HTTP ${response.status}`);
      // aes_key 是十六进制密钥字符串再转 base64（官方插件就是这么写的）。
      await sendItem(bot, to, contextToken, {
        type: 2, image_item: { media: { encrypt_query_param: downloadParam, aes_key: Buffer.from(aeskey.toString("hex")).toString("base64"), encrypt_type: 1 }, mid_size: ciphertext.length },
      });
    },
  };
}

export type Ilink = ReturnType<typeof createIlink>;
