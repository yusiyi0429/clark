/**
 * 火山对象存储（TOS）。**只有两件事：把一份 mp3 传上去，签一条能下载它的地址。**
 *
 * ## 为什么这个文件必须存在
 *
 * 火山那个录音文件识别接口**只接 URL，不接文件**（`volc-asr.ts` 文件头）。而这台机器
 * 在内网里，没有公网可达的地址。所以录音必须先离开这台机器 —— 这不是一个可以绕过去的
 * 中间层，是那条链路的前提。
 *
 * 这也正是 `lib/asr/transcribe-file.ts` 当初**不**走这条路的理由（它那段文件头写着：为了
 * 一次会后转写凭空多出一套凭据、一个桶、一条清理策略）。那个判断在当时是对的，被推翻
 * 是因为目标变了：现在要的是说话人分离，而实时那条线给不出。
 *
 * ## 桶必须是私有的
 *
 * 传上去的是一场战略会的原始录音。桶设成公共读的话，那段录音就在公网上摆着，只要
 * 有人猜到 key —— 而 key 是 `recordings/REC-20260831-xxxxxx.mp3` 这种可枚举的形状。
 * 私有桶加预签名地址：那条地址带着签名和过期时间，签给谁、签多久是我们说了算。
 *
 * ## 这一层只有两个函数，不做抽象
 *
 * 不套 S3 兼容层、不搞 provider 接口。换厂商时改的是这一个文件，而那件事一年也发生
 * 不了一次 —— 为它预留的那层抽象，代价是每次读代码的人都要多穿过一层才看得到真正
 * 发生了什么。
 */
import { TosClient, TosClientError, TosServerError } from "@volcengine/tos-sdk";

import { RecordingNotConfigured, tosConfig } from "./config";

/**
 * 多大算大文件，走分片。
 *
 * 规整之后是 16 k 单声道 64 kbps 的 mp3 —— 一小时约 29 MB，五小时约 144 MB。也就是说
 * 正常情况下**永远走不到分片那一支**。留着它是因为「正常情况」这四个字在这里不成立：
 * 上传那一路收的是原文件，而一份没转码就被送进来的 mp4 可以是几百 MB。
 */
const MULTIPART_OVER = 100 * 1024 * 1024;

/**
 * 每次现建，不缓存一个模块级单例。
 *
 * 缓存的话，`next dev` 下改一次 `.env.local` 要重启才生效 —— 而这条链路上最常见的
 * 操作恰好就是「换一把 key 再试一次」。建一个 client 只是把几个字符串塞进对象，
 * 它不开连接。
 */
function client(): TosClient {
  const cfg = tosConfig();
  return new TosClient({
    accessKeyId: cfg.accessKey,
    accessKeySecret: cfg.secretKey,
    region: cfg.region,
    /*
     * **endpoint 不带协议前缀**（`tos-cn-beijing.volces.com`）。带了的话 SDK 会拼成
     * `https://https://…`，而报出来的错是一句和地址无关的连接失败。这里替他削掉 ——
     * 控制台上复制下来的那一串多半是带的。
     */
    endpoint: cfg.endpoint.replace(/^https?:\/\//, ""),
    bucket: cfg.bucket,
  });
}

/**
 * 传一份本地文件上去。
 *
 * `contentType` **显式传，不吃 SDK 的自动推断** —— 它是按 key 的后缀猜的，猜不到就
 * 给 `application/octet-stream`。而 2026-01 之后新建的桶对某几种 content-type 有下载
 * 限制，猜错一次的表现是厂商那边下载失败，而那个失败在我们这侧只看得到「转写失败」。
 */
export async function putFile(
  key: string,
  filePath: string,
  contentType: string,
): Promise<void> {
  const c = client();
  try {
    const size = await fileSize(filePath);
    if (size > MULTIPART_OVER) {
      /* 分片 + 断点续传。几百 MB 的原文件走这一支。 */
      await c.uploadFile({
        key,
        file: filePath,
        contentType,
        partSize: 20 * 1024 * 1024,
        taskNum: 4,
      });
      return;
    }
    await c.putObjectFromFile({ key, filePath, contentType });
  } catch (err) {
    throw translate(err);
  }
}

/**
 * 签一条能下载它的地址。**同步，不是 Promise。**
 *
 * `expires` 单位是秒，服务端上限 2592000（30 天）。这里挡一道是因为超上限的表现不是
 * 报错，是签出来一条**永远 403 的地址** —— 而 403 看起来像凭据配错了。
 */
export function presignGet(key: string, expiresSeconds: number): string {
  const c = client();
  try {
    return c.getPreSignedUrl({
      method: "GET",
      key,
      expires: Math.min(Math.max(1, Math.floor(expiresSeconds)), 2_592_000),
    });
  } catch (err) {
    throw translate(err);
  }
}

/**
 * 把 SDK 的错折成一句人能读的话。
 *
 * 服务端的错要带上 `requestId` 和 `code`：跟火山提工单时它们是唯一有用的东西，而
 * 「上传失败」这三个字在工单里等于没说。**不带 key 本身，也不带它的长度。**
 */
function translate(err: unknown): Error {
  if (err instanceof RecordingNotConfigured) return err;
  if (err instanceof TosServerError) {
    return new Error(
      `对象存储拒绝了这次请求（HTTP ${err.statusCode} · ${err.code} · ${err.requestId}）：${err.message}`,
    );
  }
  if (err instanceof TosClientError) {
    return new Error(`对象存储这一段没发出去：${err.message}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

async function fileSize(path: string): Promise<number> {
  const { stat } = await import("node:fs/promises");
  return (await stat(path)).size;
}
