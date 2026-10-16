import { Type, type Static } from "@sinclair/typebox";

/** 本人声纹状态（GET/POST /api/me/voiceprint）：只报有没有、什么时候录的；声纹与厂商 id 不下发。 */
export const VoiceprintStatus = Type.Object(
  {
    enrolled: Type.Boolean(),
    updatedAt: Type.Union([Type.String(), Type.Null()]),
    /** 服务器是否配好腾讯云声纹凭据；false 时录入返回 503 VOICEPRINT_NOT_CONFIGURED。 */
    configured: Type.Boolean(),
  },
  { additionalProperties: false },
);

export type TVoiceprintStatus = Static<typeof VoiceprintStatus>;

/** 输入框语音转文字（POST /api/me/dictation）：只回转好的文字；没听到人声时是空串。录音不落库。 */
export const DictationResult = Type.Object({ text: Type.String() }, { additionalProperties: false });

export type TDictationResult = Static<typeof DictationResult>;

/**
 * 实时听写签发（POST /api/me/dictation/session）：服务端用腾讯云密钥签好的一次性 wss 地址，浏览器拿它直连腾讯实时识别。
 * 地址 30 秒内有效（只需盖住握手）；SecretKey 不下发，只有一次性签名。缺配置时 503 DICTATION_REALTIME_NOT_CONFIGURED，前端退回录完再转。
 */
export const DictationSessionResponse = Type.Object(
  {
    url: Type.String({ minLength: 1 }),
    voiceId: Type.String({ minLength: 1 }),
    engine: Type.String({ minLength: 1 }),
    /** 地址失效时间（ISO 8601）；过期后握手会被拒，需重新签发。 */
    expiresAt: Type.String({ minLength: 1 }),
    sampleRate: Type.Literal(16000),
    frameMs: Type.Literal(200),
  },
  { additionalProperties: false },
);

export type TDictationSessionResponse = Static<typeof DictationSessionResponse>;

/**
 * 听写后的快速整理（POST /api/me/dictation/polish）：一段识别原文，上限 2000 字（超出 413）。
 * mode：sentence（缺省）= 说话过程中逐句轻度整理、不分点；full = 停下后整段整理，列举时按「1. 」分行。
 */
export const DictationPolishRequest = Type.Object(
  { text: Type.String(), mode: Type.Optional(Type.Union([Type.Literal("sentence"), Type.Literal("full")])) },
  { additionalProperties: false },
);

export type TDictationPolishRequest = Static<typeof DictationPolishRequest>;

/** 整理结果：polished=false 时 text 就是原文（未配置、句子已经干净不需整理、失败、超时或没通过防护），HTTP 仍是 200。 */
export const DictationPolishResponse = Type.Object({ text: Type.String(), polished: Type.Boolean() }, { additionalProperties: false });

export type TDictationPolishResponse = Static<typeof DictationPolishResponse>;
