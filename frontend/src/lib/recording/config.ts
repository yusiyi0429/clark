/**
 * 这条链路要的那几把凭据和几个路径。**全部服务端读取，一个都不下发到浏览器。**
 *
 * ## 为什么缺配不是「降级」
 *
 * 别的链路缺 key 时可以降级（深研不联网照样写报告，只是写明未核验）。这一条不行：
 * 转写这件事没有「大概转一下」的版本，缺凭据就是转不出来。所以这里的每个读取函数
 * 在缺配时都**抛一句写清缺哪个变量名的话**，那句话会一路走到屏幕上 —— 而不是返回
 * 一个空字符串，让请求发出去再拿回一个 403（403 看起来像 key 配错了，能查很久）。
 *
 * **不打印 key 本身，也不打印它的长度。** 长度会泄漏它是哪一类凭据。
 */
import { join } from "node:path";

/** 缺配。和别处的错分开一类：屏幕据此知道「重试没有意义，先去配环境变量」。 */
export class RecordingNotConfigured extends Error {}

export interface TosConfig {
  accessKey: string;
  secretKey: string;
  endpoint: string;
  region: string;
  bucket: string;
}

/**
 * 火山那两代控制台的鉴权形状不一样，**两种都认**。
 *
 * 新版控制台（豆包语音 → API 管理）只发一把 `API Key`，请求头是 `X-Api-Key`；
 * 旧版控制台（API 服务中心）发的是 `APP ID` + `Access Token` 一对，请求头是
 * `X-Api-App-Key` + `X-Api-Access-Key`。官方文档原话是「新版控制台只需要
 * X-Api-Key 即可」——也就是说旧的那条路仍然通。
 *
 * 为什么不挑一种：**开通那一步不在我们手里**。他在控制台上落到哪一版取决于账号是
 * 什么时候建的、点进了哪个入口，而「我按文档配好了却一直 401」是最难查的一类问题。
 * 认两种的代价是这里多一个分支；只认一种的代价是他可能得把账号重开一遍。
 */
export type VolcAsrConfig =
  | { kind: "apiKey"; apiKey: string }
  | { kind: "appKey"; appKey: string; accessKey: string };

/**
 * 音频文件都落在对象库同一个根底下。
 *
 * 跟着 `TKOS_DATA_DIR` 走而不是另开一个变量：容器里那个目录是挂卷的（见
 * `docker-compose.yml`），而一份还没转完的录音落在卷外面，重启之后就没了 —— 而
 * 库里那条记录还写着「转码中」。
 */
export const dataDir = (): string =>
  process.env.TKOS_DATA_DIR || join(process.cwd(), ".data");

/** 原始音频（拼好的 webm，或上传进来的原文件）。 */
export const rawDir = (): string => join(dataDir(), "recordings", "raw");

/** ffmpeg 规整出来的那份 mp3。上传完之后可以删，但先留着 —— 磁盘比重转一次便宜。 */
export const workDir = (): string => join(dataDir(), "recordings", "work");

/** live 那一路的分片，一片一个文件（`<id>/<seq>.part`），拼完删掉。 */
export const chunkDir = (id: string): string =>
  join(dataDir(), "recordings", "chunks", id);

export function tosConfig(): TosConfig {
  const cfg = {
    accessKey: env("TOS_ACCESS_KEY"),
    secretKey: env("TOS_SECRET_KEY"),
    endpoint: env("TOS_ENDPOINT"),
    region: env("TOS_REGION"),
    bucket: env("TOS_BUCKET"),
  };
  const missing = Object.entries(cfg)
    .filter(([, v]) => !v)
    .map(([k]) => VAR_NAME[k as keyof typeof cfg]);
  if (missing.length) {
    throw new RecordingNotConfigured(
      `对象存储还没配全，缺 ${missing.join("、")}。录音要先传到 TOS，` +
        `火山的识别服务只接 URL、不接文件。`,
    );
  }
  return cfg as TosConfig;
}

export function volcAsrConfig(): VolcAsrConfig {
  /* 新版那把优先：只有一个变量，配错的面小。 */
  const apiKey = env("VOLC_ASR_API_KEY");
  if (apiKey) return { kind: "apiKey", apiKey };

  const appKey = env("VOLC_ASR_APP_KEY");
  const accessKey = env("VOLC_ASR_ACCESS_KEY");
  if (appKey && accessKey) return { kind: "appKey", appKey, accessKey };

  /*
   * 缺配这句话要把**两条路都说出来**。只说「缺 VOLC_ASR_API_KEY」的话，手上拿着
   * 旧版控制台那一对 APP ID / Access Token 的人会去找一个他那边根本没有的东西。
   */
  throw new RecordingNotConfigured(
    "语音识别还没配，这份录音转不成文字。新版控制台配 VOLC_ASR_API_KEY 一个就够；" +
      "旧版控制台（API 服务中心）拿到的是一对，配 VOLC_ASR_APP_KEY（APP ID）" +
      "和 VOLC_ASR_ACCESS_KEY（Access Token）。",
  );
}

/**
 * 用哪个模型。默认豆包录音文件识别 2.0（`volc.seedasr.auc`）—— 它比 1.0 便宜三倍
 * （0.8 vs 2.3 元/小时），而这条链路要的说话人分离两边都有。
 *
 * 留一个覆盖出口是因为**开通的是哪一个不在我们手里**：他在控制台上只开了 1.0 的话，
 * 发 2.0 的 resource id 会被拒，而那个拒绝看起来像鉴权错。
 *
 * ★ 提交和查询必须用**同一个** resource id，否则查不到那个任务。所以只有这一处。
 */
export const asrResourceId = (): string =>
  env("VOLC_ASR_RESOURCE_ID") ?? "volc.seedasr.auc";

/** 配没配全。`/api/health` 和上传那颗按钮都要问 —— 问的时候不许抛。 */
export function recordingConfigured(): { tos: boolean; asr: boolean } {
  return {
    tos: Boolean(
      env("TOS_ACCESS_KEY") &&
        env("TOS_SECRET_KEY") &&
        env("TOS_ENDPOINT") &&
        env("TOS_REGION") &&
        env("TOS_BUCKET"),
    ),
    asr: Boolean(
      env("VOLC_ASR_API_KEY") ||
        (env("VOLC_ASR_APP_KEY") && env("VOLC_ASR_ACCESS_KEY")),
    ),
  };
}

const VAR_NAME = {
  accessKey: "TOS_ACCESS_KEY",
  secretKey: "TOS_SECRET_KEY",
  endpoint: "TOS_ENDPOINT",
  region: "TOS_REGION",
  bucket: "TOS_BUCKET",
} as const;

const env = (name: string): string | undefined => {
  const v = process.env[name];
  const t = typeof v === "string" ? v.trim() : "";
  return t ? t : undefined;
};
