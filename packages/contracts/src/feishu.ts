import { Type, type Static } from "@sinclair/typebox";

/** 前端判断能否走飞书免登：未配置飞书应用时 enabled=false、不给 appId；scopes 是浏览器授权同一套用户权限，供 requestAccess 的 scopeList 使用。 */
export const FeishuAuthConfigResponse = Type.Object(
  { enabled: Type.Boolean(), appId: Type.Optional(Type.String()), scopes: Type.Optional(Type.Array(Type.String())) },
  { additionalProperties: false },
);

/** 在飞书客户端里打开时，requestAccess（旧版 requestAuthCode）拿到的一次性 code。 */
export const FeishuCodeLoginRequest = Type.Object(
  { code: Type.String({ minLength: 1, maxLength: 512 }) },
  { additionalProperties: false },
);

/**
 * 本人的飞书连好了没有：enabled=false 是这套天枢没接飞书；connected 要求授权有效、带着会后拿妙记要的权限；
 * calendar 要求授权有效、带着在飞书日历约会要的权限（约会议时没有就提示会议不会进他的飞书日历）。
 */
export const FeishuConnectionResponse = Type.Object(
  {
    enabled: Type.Boolean(), connected: Type.Boolean(), calendar: Type.Boolean(),
    /**
     * 连接页用（新首页 9.4）：not_connected 没连过（或已断开）；connected 已连（授权有效、带着会后拿妙记要的权限，同 connected）；
     * expired 连过、但授权过期或要重新授权（含缺权限）。没接飞书（enabled=false）时是 not_connected。断开用 DELETE /api/me/feishu。
     */
    state: Type.Union([Type.Literal("not_connected"), Type.Literal("connected"), Type.Literal("expired")]),
  },
  { additionalProperties: false },
);

export type TFeishuAuthConfigResponse = Static<typeof FeishuAuthConfigResponse>;
export type TFeishuConnectionResponse = Static<typeof FeishuConnectionResponse>;
export type TFeishuCodeLoginRequest = Static<typeof FeishuCodeLoginRequest>;
