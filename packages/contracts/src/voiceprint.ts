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
