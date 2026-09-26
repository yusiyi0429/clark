/**
 * 火山对象存储（TOS）：把一份 mp3 传上去，签一条能下载它的地址。（移植自概念版 `lib/recording/tos.ts`）
 *
 * 火山录音文件识别**只接 URL，不接文件**，而 API 在内网里没有公网可达地址，所以录音必须先离开这台机器。
 * 桶必须是私有的：传上去的是战略会原始录音，私有桶 + 预签名地址，签给谁、签多久由我们说了算。
 */
import { stat } from "node:fs/promises";
import { TosClient, TosClientError, TosServerError } from "@volcengine/tos-sdk";
import { RecordingNotConfigured, tosConfig } from "./recordingConfig.js";

/** 16k 单声道 64kbps mp3 一小时约 29 MB，正常永远走不到分片；留着是给超长会议的保险。 */
const MULTIPART_OVER = 100 * 1024 * 1024;

/** 每次现建，不缓存单例：换一把 key 再试时不用重启。建 client 只是塞几个字符串，不开连接。 */
function client(): TosClient {
  const cfg = tosConfig();
  return new TosClient({
    accessKeyId: cfg.accessKey,
    accessKeySecret: cfg.secretKey,
    region: cfg.region,
    // endpoint 不带协议前缀：带了 SDK 会拼成 `https://https://…`，报的是一句和地址无关的连接失败
    endpoint: cfg.endpoint.replace(/^https?:\/\//, ""),
    bucket: cfg.bucket,
  });
}

/**
 * 传一份本地文件上去。contentType **显式传**：SDK 按后缀猜，猜错时厂商那边下载失败，
 * 而那个失败在我们这侧只看得到「转写失败」。
 */
export async function putFile(key: string, filePath: string, contentType: string): Promise<void> {
  const c = client();
  try {
    const size = (await stat(filePath)).size;
    if (size > MULTIPART_OVER) {
      await c.uploadFile({ key, file: filePath, contentType, partSize: 20 * 1024 * 1024, taskNum: 4 });
      return;
    }
    await c.putObjectFromFile({ key, filePath, contentType });
  } catch (err) {
    throw translate(err);
  }
}

/**
 * 签一条能下载它的地址（同步）。`expires` 单位秒，服务端上限 2592000（30 天）：
 * 超上限不报错，而是签出一条**永远 403 的地址**，看起来像凭据配错了，所以这里夹住。
 */
export function presignGet(key: string, expiresSeconds: number): string {
  const c = client();
  try {
    return c.getPreSignedUrl({ method: "GET", key, expires: Math.min(Math.max(1, Math.floor(expiresSeconds)), 2_592_000) });
  } catch (err) {
    throw translate(err);
  }
}

/** SDK 的错折成一句人能读的话：服务端错带 requestId 和 code（提工单唯一有用的东西）；不带 key，也不带长度。 */
function translate(err: unknown): Error {
  if (err instanceof RecordingNotConfigured) return err;
  if (err instanceof TosServerError) {
    return new Error(`对象存储拒绝了这次请求（HTTP ${err.statusCode} · ${err.code} · ${err.requestId}）：${err.message}`);
  }
  if (err instanceof TosClientError) return new Error(`对象存储这一段没发出去：${err.message}`);
  return err instanceof Error ? err : new Error(String(err));
}
