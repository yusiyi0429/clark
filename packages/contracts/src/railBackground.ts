import { Type, type Static } from "@sinclair/typebox";

/**
 * 左边通知栏的背景：几张预设（mist 是原来那张雾蓝波纹，没选过时也是它），或 custom = 本人上传的那张图。
 * 预设都是偏深的底色，通知栏上的白字始终看得清；上传的图在网页上会压一层淡淡的暗色。
 */
export const RailBackgroundChoice = Type.Union([
  Type.Literal("mist"),
  Type.Literal("dusk"),
  Type.Literal("pine"),
  Type.Literal("night"),
  Type.Literal("sand"),
  Type.Literal("custom"),
]);

/** imageVersion：上传过图时是那张图的版本（换图就变），网页拿它拼图片地址；没上传过是 null。 */
export const RailBackground = Type.Object({
  choice: RailBackgroundChoice,
  imageVersion: Type.Union([Type.String(), Type.Null()]),
}, { additionalProperties: false });

/** 解码后最多 3 MB（网页先缩到长边 2000 像素以内、转成 JPEG，一般几百 KB）。 */
export const MAX_RAIL_IMAGE_BYTES = 3 * 1024 * 1024;

/**
 * 换背景：选预设只传 choice；上传新图传 choice = custom 和 image（data:image/jpeg|png|webp;base64,…）。
 * 选 custom 不带 image 时沿用上次上传的那张，没上传过就报错。
 */
export const SaveRailBackgroundRequest = Type.Object({
  choice: RailBackgroundChoice,
  image: Type.Optional(Type.String({ maxLength: Math.ceil(MAX_RAIL_IMAGE_BYTES / 3) * 4 + 64 })),
}, { additionalProperties: false });

export type TRailBackgroundChoice = Static<typeof RailBackgroundChoice>;
export type TRailBackground = Static<typeof RailBackground>;
export type TSaveRailBackgroundRequest = Static<typeof SaveRailBackgroundRequest>;
