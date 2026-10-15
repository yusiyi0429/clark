import { Type, type Static } from "@sinclair/typebox";

/** API health 只报告布尔安全摘要：不返回 secret，也不发起模型/Search 调用（.tech/07 §8）。 */
export const HealthDependencies = Type.Object(
  {
    piRuntime: Type.Boolean(),
    modelSlots: Type.Boolean(),
    peopleDirectory: Type.Boolean(),
    companyConfigured: Type.Boolean(),
    search: Type.Boolean(),
    wechat: Type.Boolean(),
    outlets: Type.Boolean(),
    /** 会议录音识别的两段外部凭据是否配全（TOS 对象存储、火山语音识别）；不含 ffmpeg 自检。 */
    recording: Type.Object({ tos: Type.Boolean(), asr: Type.Boolean() }, { additionalProperties: false }),
    /** 腾讯云声纹（说话人注册 / 1:N）凭据是否配全；只看变量在不在，不发起外部调用。 */
    voiceprint: Type.Boolean(),
    /** world 推送凭据是否配全；false 表示未配置，不发起外部调用。 */
    world: Type.Boolean(),
  },
  { additionalProperties: false },
);

export const HealthResponse = Type.Object(
  {
    status: Type.Union([Type.Literal("ok"), Type.Literal("degraded")]),
    api: Type.Boolean(),
    database: Type.Boolean(),
    buildSha: Type.String(),
    dependencies: HealthDependencies,
  },
  { additionalProperties: false },
);

export type THealthResponse = Static<typeof HealthResponse>;
