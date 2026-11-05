import { MAX_AVATAR_IMAGE_BYTES, type TSavedAvatar } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";

const IMAGE_DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

export class AvatarError extends Error {
  constructor(readonly status: 400 | 413, readonly code: string, message: string) { super(message); }
}

const version = (at: Date) => String(at.getTime());

/** 本人换头像：只校验类型和大小，裁剪在网页上做完了。 */
export async function saveAvatar(q: Query, personId: string, dataUrl: string): Promise<TSavedAvatar> {
  const match = IMAGE_DATA_URL.exec(dataUrl);
  if (!match) throw new AvatarError(400, "INVALID_INPUT", "只支持 JPEG、PNG、WebP 图片");
  const image = Buffer.from(match[2], "base64");
  if (!image.length) throw new AvatarError(400, "INVALID_INPUT", "图片是空的");
  if (image.length > MAX_AVATAR_IMAGE_BYTES) throw new AvatarError(413, "FILE_TOO_LARGE", "图片不能超过 512 KB");
  const saved = await q(`INSERT INTO person_avatars (person_id, image, image_type, updated_at) VALUES ($1, $2, $3, now())
    ON CONFLICT (person_id) DO UPDATE SET image = EXCLUDED.image, image_type = EXCLUDED.image_type, updated_at = now()
    RETURNING updated_at`, [personId, image, match[1]]);
  return { version: version((saved.rows[0] as { updated_at: Date }).updated_at) };
}

export async function deleteAvatar(q: Query, personId: string): Promise<void> {
  await q("DELETE FROM person_avatars WHERE person_id = $1", [personId]);
}

/** 传过照片的人：personId → 版本。 */
export async function listAvatarVersions(q: Query): Promise<Record<string, string>> {
  const rows = (await q("SELECT person_id, updated_at FROM person_avatars")).rows as { person_id: string; updated_at: Date }[];
  return Object.fromEntries(rows.map((row) => [row.person_id, version(row.updated_at)]));
}

export async function readAvatar(q: Query, personId: string): Promise<{ image: Buffer; type: string } | null> {
  const row = (await q("SELECT image, image_type FROM person_avatars WHERE person_id = $1", [personId])).rows[0] as
    { image: Buffer; image_type: string } | undefined;
  return row ? { image: row.image, type: row.image_type } : null;
}
