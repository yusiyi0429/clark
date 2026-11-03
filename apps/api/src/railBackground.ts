import { MAX_RAIL_IMAGE_BYTES, type TRailBackground, type TSaveRailBackgroundRequest } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";

const DEFAULT: TRailBackground = { choice: "mist", imageVersion: null };
const IMAGE_DATA_URL = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/]+={0,2})$/;

export class RailBackgroundError extends Error {
  constructor(readonly status: 400 | 413, readonly code: string, message: string) { super(message); }
}

type Row = { choice: TRailBackground["choice"]; image_at: Date | null };
const view = (row: Row | undefined): TRailBackground =>
  row ? { choice: row.choice, imageVersion: row.image_at ? String(row.image_at.getTime()) : null } : DEFAULT;

/** 本人给通知栏选的背景：没选过是雾蓝。 */
export async function readRailBackground(q: Query, personId: string): Promise<TRailBackground> {
  return view((await q("SELECT choice, image_at FROM person_rail_backgrounds WHERE person_id = $1", [personId])).rows[0] as Row | undefined);
}

/** 选预设只改 choice，上传过的图留着；带 image 时换成新图。选「我的图」却从没上传过，报错。 */
export async function saveRailBackground(q: Query, personId: string, input: TSaveRailBackgroundRequest): Promise<TRailBackground> {
  if (input.image !== undefined) {
    if (input.choice !== "custom") throw new RailBackgroundError(400, "INVALID_INPUT", "只有选「我的图」时才带图片");
    const match = IMAGE_DATA_URL.exec(input.image);
    if (!match) throw new RailBackgroundError(400, "INVALID_INPUT", "只支持 JPEG、PNG、WebP 图片");
    const image = Buffer.from(match[2], "base64");
    if (!image.length) throw new RailBackgroundError(400, "INVALID_INPUT", "图片是空的");
    if (image.length > MAX_RAIL_IMAGE_BYTES) throw new RailBackgroundError(413, "FILE_TOO_LARGE", "图片不能超过 3 MB");
    const saved = await q(`INSERT INTO person_rail_backgrounds (person_id, choice, image, image_type, image_at) VALUES ($1, 'custom', $2, $3, now())
      ON CONFLICT (person_id) DO UPDATE SET choice = 'custom', image = EXCLUDED.image, image_type = EXCLUDED.image_type, image_at = now(), updated_at = now()
      RETURNING choice, image_at`, [personId, image, match[1]]);
    return view(saved.rows[0] as Row);
  }
  if (input.choice === "custom") {
    const saved = await q(`UPDATE person_rail_backgrounds SET choice = 'custom', updated_at = now()
      WHERE person_id = $1 AND image IS NOT NULL RETURNING choice, image_at`, [personId]);
    if (!saved.rows[0]) throw new RailBackgroundError(400, "INVALID_INPUT", "还没有上传过图片");
    return view(saved.rows[0] as Row);
  }
  const saved = await q(`INSERT INTO person_rail_backgrounds (person_id, choice) VALUES ($1, $2)
    ON CONFLICT (person_id) DO UPDATE SET choice = EXCLUDED.choice, updated_at = now()
    RETURNING choice, image_at`, [personId, input.choice]);
  return view(saved.rows[0] as Row);
}

/** 本人上传的那张图；没上传过是 null。 */
export async function readRailImage(q: Query, personId: string): Promise<{ image: Buffer; type: string } | null> {
  const row = (await q("SELECT image, image_type FROM person_rail_backgrounds WHERE person_id = $1 AND image IS NOT NULL", [personId])).rows[0] as
    { image: Buffer; image_type: string } | undefined;
  return row ? { image: row.image, type: row.image_type } : null;
}
