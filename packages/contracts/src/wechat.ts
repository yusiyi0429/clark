import { Type, type Static } from "@sinclair/typebox";

/**
 * 本人的微信 ClawBot 连接：none 没连；waiting 等扫码、scanned 已扫码等手机上确认（都带二维码内容 qrcodeUrl）；
 * expired 二维码过期不再自动换；connected 已连上（welcomed=false 是本人还没在微信里开过口，开口后才发自我介绍、才推通知；
 * paused=true 是推送到了上限或推不出去，等本人在微信里说一句）；stale 绑定失效，要重新扫码。没接微信时这套接口不存在。
 */
export const WechatConnection = Type.Object(
  {
    state: Type.Union([Type.Literal("none"), Type.Literal("waiting"), Type.Literal("scanned"), Type.Literal("expired"), Type.Literal("connected"), Type.Literal("stale")]),
    qrcodeUrl: Type.Optional(Type.String()),
    welcomed: Type.Optional(Type.Boolean()),
    paused: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

export type TWechatConnection = Static<typeof WechatConnection>;
