import { Type, type Static } from "@sinclair/typebox";

/** 解码后最多 512 KB（网页先在圆框里裁好、导出 256×256 JPEG，一般几十 KB）。 */
export const MAX_AVATAR_IMAGE_BYTES = 512 * 1024;

/** 本人换头像：image 是 data:image/jpeg|png|webp;base64,…。 */
export const SaveAvatarRequest = Type.Object({
  image: Type.String({ minLength: 1, maxLength: Math.ceil(MAX_AVATAR_IMAGE_BYTES / 3) * 4 + 64 }),
}, { additionalProperties: false });

/** version：这张头像的版本（换图就变），网页拿它拼图片地址。 */
export const SavedAvatar = Type.Object({ version: Type.String({ minLength: 1 }) }, { additionalProperties: false });

/** 传过照片的人：personId → 头像版本。没在里面的人显示单字。 */
export const PersonAvatarsResponse = Type.Object({
  avatars: Type.Record(Type.String(), Type.String()),
}, { additionalProperties: false });

export type TSaveAvatarRequest = Static<typeof SaveAvatarRequest>;
export type TSavedAvatar = Static<typeof SavedAvatar>;
export type TPersonAvatarsResponse = Static<typeof PersonAvatarsResponse>;
