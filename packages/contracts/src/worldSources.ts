import { Type } from "@sinclair/typebox";

/** 网页出处卡：答案里的 cite:world:<object_id>@<version> 点开后，按本人授权读到的本体对象当前这一版。 */
export const WorldSourceParams = Type.Object({ id: Type.String({ minLength: 1, maxLength: 128 }) }, { additionalProperties: false });

const Nullable = <T extends ReturnType<typeof Type.String>>(schema: T) => Type.Union([schema, Type.Null()]);

export const WorldSourceProgress = Type.Object({
  ref: Nullable(Type.String()),
  /** 快照记到哪天（YYYY-MM-DD）。 */
  asOf: Nullable(Type.String()),
  author: Nullable(Type.String()),
  unconfirmed: Type.Boolean(),
  lines: Type.Array(Type.String()),
}, { additionalProperties: false });

export const WorldSourceView = Type.Object({
  /** 当前这一版的 ref（object_id@version）；和引用时的版本可能不同。 */
  ref: Type.String(),
  objectId: Type.String(),
  version: Type.Integer({ minimum: 0 }),
  type: Type.String(),
  title: Type.String(),
  status: Type.String(),
  owners: Type.Array(Type.String()),
  progress: Type.Union([WorldSourceProgress, Type.Null()]),
}, { additionalProperties: false });
