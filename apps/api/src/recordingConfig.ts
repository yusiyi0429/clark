/**
 * 会议录音识别要的几把凭据。**全部服务端读取，一个都不下发到浏览器。**（移植自概念版 `lib/recording/config.ts`）
 *
 * 缺配不是「降级」：转写没有「大概转一下」的版本。所以每个读取函数在缺配时都抛一句写清缺哪个
 * 变量名的话，那句话会一路走到屏幕上 —— 而不是返回空字符串，让请求发出去再拿回一个 403
 * （403 看起来像 key 配错了，能查很久）。
 *
 * **不打印 key 本身，也不打印它的长度。** 长度会泄漏它是哪一类凭据。
 */

/** 缺配。和别处的错分开一类：据此知道「重试没有意义，先去配环境变量」。 */
export class RecordingNotConfigured extends Error {}

export type TosConfig = {
  accessKey: string;
  secretKey: string;
  endpoint: string;
  region: string;
  bucket: string;
};

/**
 * 火山两代控制台的鉴权形状不一样，**两种都认**。
 *
 * 新版控制台（豆包语音 → API 管理）只发一把 `API Key`，请求头 `X-Api-Key`；
 * 旧版控制台（API 服务中心）发 `APP ID` + `Access Token` 一对，请求头 `X-Api-App-Key` + `X-Api-Access-Key`。
 * 开通落在哪一版不在我们手里，「按文档配好了却一直 401」是最难查的一类问题。
 */
export type VolcAsrConfig =
  | { kind: "apiKey"; apiKey: string }
  | { kind: "appKey"; appKey: string; accessKey: string };

const VAR_NAME = {
  accessKey: "TOS_ACCESS_KEY",
  secretKey: "TOS_SECRET_KEY",
  endpoint: "TOS_ENDPOINT",
  region: "TOS_REGION",
  bucket: "TOS_BUCKET",
} as const;

const env = (name: string): string | undefined => {
  const value = process.env[name];
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed ? trimmed : undefined;
};

export function tosConfig(): TosConfig {
  const cfg = {
    accessKey: env(VAR_NAME.accessKey),
    secretKey: env(VAR_NAME.secretKey),
    endpoint: env(VAR_NAME.endpoint),
    region: env(VAR_NAME.region),
    bucket: env(VAR_NAME.bucket),
  };
  const missing = (Object.keys(cfg) as (keyof typeof cfg)[]).filter((key) => !cfg[key]).map((key) => VAR_NAME[key]);
  if (missing.length) {
    throw new RecordingNotConfigured(
      `对象存储还没配全，缺 ${missing.join("、")}。录音要先传到 TOS，火山的识别服务只接 URL、不接文件。`,
    );
  }
  return cfg as TosConfig;
}

export function volcAsrConfig(): VolcAsrConfig {
  // 新版那把优先：只有一个变量，配错的面小。
  const apiKey = env("VOLC_ASR_API_KEY");
  if (apiKey) return { kind: "apiKey", apiKey };
  const appKey = env("VOLC_ASR_APP_KEY");
  const accessKey = env("VOLC_ASR_ACCESS_KEY");
  if (appKey && accessKey) return { kind: "appKey", appKey, accessKey };
  // 两条路都说出来：手上拿着旧版一对凭据的人不该去找一个他那边根本没有的东西。
  throw new RecordingNotConfigured(
    "语音识别还没配，这份录音转不成文字。新版控制台配 VOLC_ASR_API_KEY 一个就够；" +
      "旧版控制台（API 服务中心）拿到的是一对，配 VOLC_ASR_APP_KEY（APP ID）和 VOLC_ASR_ACCESS_KEY（Access Token）。",
  );
}

/**
 * 用哪个模型。默认豆包录音文件识别 2.0（`volc.seedasr.auc`），比 1.0 便宜，说话人分离两边都有。
 * 留覆盖出口是因为开通的是哪一个不在我们手里：只开了 1.0 时发 2.0 的 resource id 会被拒，而那个拒绝看起来像鉴权错。
 *
 * ★ 提交和查询必须用**同一个** resource id，否则查不到那个任务。所以只有这一处。
 */
export const asrResourceId = (): string => env("VOLC_ASR_RESOURCE_ID") ?? "volc.seedasr.auc";

/** 配没配全。health 与「结束录音」要问 —— 问的时候不许抛。 */
export function recordingConfigured(): { tos: boolean; asr: boolean } {
  return {
    tos: Object.values(VAR_NAME).every((name) => Boolean(env(name))),
    asr: Boolean(env("VOLC_ASR_API_KEY") || (env("VOLC_ASR_APP_KEY") && env("VOLC_ASR_ACCESS_KEY"))),
  };
}

/** 两段都配全才放行；缺哪段就抛那一段的原话（先 TOS 后 ASR，和流水线顺序一致）。 */
export function assertRecordingConfigured(): void {
  tosConfig();
  volcAsrConfig();
}
