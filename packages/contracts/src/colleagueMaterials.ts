import { Type, type Static, type TSchema } from "@sinclair/typebox";

/**
 * 对外资料（同事的伙伴能读的）：每人一份文字说明，加若干上传的文件（.md、.pdf、.docx，只存抽出的文字）；技能上的「同事可用」开关在 roles.ts。
 * 存之前查疑似凭据，命中 422 SECRET_IN_MATERIAL，逐条说在哪、第几行。
 */

const strict = { additionalProperties: false } as const;
const Uuid = Type.String({ format: "uuid" });
const Instant = Type.String({ format: "date-time" });
const Nullable = <T extends TSchema>(schema: T) => Type.Union([schema, Type.Null()]);

/** 一份上传的文件：文件名、原件大小（字节）、抽出的文字有多少字。 */
export const ColleagueFile = Type.Object({ id: Uuid, fileName: Type.String({ minLength: 1, maxLength: 255 }), size: Type.Integer({ minimum: 1 }),
  chars: Type.Integer({ minimum: 1 }), createdAt: Instant }, strict);
/** 同事的伙伴读了我哪份全文：itemId 同 colleagueScope 的条目，reader 是读的人，readOn 是公司时区的那天（YYYY-MM-DD）。 */
export const ColleagueRead = Type.Object({ itemId: Type.String({ minLength: 1 }), title: Type.String(), reader: Type.String(), readOn: Type.String({ format: "date" }) }, strict);
/** note 没放过是空串，noteUpdatedAt 为 null。reads 只在读的时候带（最近 100 条，只给本人看）。 */
export const ColleagueMaterials = Type.Object({ note: Type.String({ maxLength: 20000 }), noteUpdatedAt: Nullable(Instant),
  files: Type.Array(ColleagueFile, { maxItems: 20 }), reads: Type.Optional(Type.Array(ColleagueRead, { maxItems: 100 })) }, strict);
/** 存说明：去掉首尾空白后为空就是清空。 */
export const SaveColleagueNoteRequest = Type.Object({ note: Type.String({ maxLength: 20000 }) }, strict);
/** 技能的「同事可用」开、关。 */
export const SetRoleSharingRequest = Type.Object({ shared: Type.Boolean() }, strict);
/** where：「说明」、文件名、或「技能 · 做法」这类；line 从 1 数；sample 只露前 6 位。 */
export const SecretFinding = Type.Object({ where: Type.String(), line: Type.Integer({ minimum: 1 }), sample: Type.String() }, strict);
export const SecretInMaterialResponse = Type.Object({ code: Type.Literal("SECRET_IN_MATERIAL"), message: Type.String(), findings: Type.Array(SecretFinding) }, strict);

export type TColleagueFile = Static<typeof ColleagueFile>;
export type TColleagueRead = Static<typeof ColleagueRead>;
export type TColleagueMaterials = Static<typeof ColleagueMaterials>;
export type TSaveColleagueNoteRequest = Static<typeof SaveColleagueNoteRequest>;
export type TSetRoleSharingRequest = Static<typeof SetRoleSharingRequest>;
export type TSecretFinding = Static<typeof SecretFinding>;
export type TSecretInMaterialResponse = Static<typeof SecretInMaterialResponse>;
