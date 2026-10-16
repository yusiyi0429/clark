import { Type, type Static } from '@sinclair/typebox';
export const PersonalMemorySection = Type.Object({ id: Type.String(), title: Type.String(), text: Type.String() }, { additionalProperties: false });
export const PersonalMemoryDocument = Type.Object({ revision: Type.Integer({ minimum: 0 }), epoch: Type.Integer({ minimum: 0 }), markdown: Type.String(), sections: Type.Array(PersonalMemorySection) }, { additionalProperties: false });
export const ReplacePersonalMemoryRequest = Type.Object({ expectedRevision: Type.Integer({ minimum: 0 }), markdown: Type.String({ maxLength: 16384 }) }, { additionalProperties: false });
export const ForgetPersonalMemoryRequest = Type.Object({ expectedRevision: Type.Integer({ minimum: 0 }), sectionIds: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 100, uniqueItems: true }) }, { additionalProperties: false });
export type TReplacePersonalMemoryRequest = Static<typeof ReplacePersonalMemoryRequest>;
export type TForgetPersonalMemoryRequest = Static<typeof ForgetPersonalMemoryRequest>;
