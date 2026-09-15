import { Type, type Static } from "@sinclair/typebox";

export const LoginRequest = Type.Object(
  { password: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export const SessionResponse = Type.Object(
  { authenticated: Type.Boolean() },
  { additionalProperties: false },
);

export type TLoginRequest = Static<typeof LoginRequest>;
export type TSessionResponse = Static<typeof SessionResponse>;
