import { Type, type Static } from "@sinclair/typebox";

/** 本人自填的可选资料；空白不代表任何性别，不从人员目录推断。 */
const Gender = Type.Union([Type.String({ maxLength: 40 }), Type.Null()]);
export const PersonalProfileView = Type.Object({
  personId: Type.String({ minLength: 1 }),
  displayName: Type.String({ minLength: 1 }),
  gender: Gender,
}, { additionalProperties: false });
export const UpdatePersonalProfileRequest = Type.Object({ gender: Gender }, { additionalProperties: false });
export type TPersonalProfileView = Static<typeof PersonalProfileView>;
