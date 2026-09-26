import { Type, type Static } from "@sinclair/typebox";

/** 会话身份：按 company-people seed 判断，roles 含 ceo 的是 CEO，其余是成员。 */
export const SessionRole = Type.Union([Type.Literal("ceo"), Type.Literal("member")]);

const LoginId = Type.String({ minLength: 1, maxLength: 40 });
/** 4 位数字口令（初始码与自设口令同一格式）。 */
const Passcode = Type.String({ pattern: "^[0-9]{4}$" });

export const LoginRequest = Type.Object(
  { loginId: LoginId, passcode: Passcode },
  { additionalProperties: false },
);

/** 首次登录（或自己改口令）：先校验当前口令，再换成新口令并签发会话。 */
export const ChangePasscodeRequest = Type.Object(
  { loginId: LoginId, passcode: Passcode, newPasscode: Passcode },
  { additionalProperties: false },
);

/** 登录结果：仍是初始码时不签发会话，只告诉前端去设置自己的口令。 */
export const LoginResponse = Type.Object(
  { authenticated: Type.Boolean(), mustChangePasscode: Type.Boolean(), role: Type.Optional(SessionRole) },
  { additionalProperties: false },
);

export const SessionResponse = Type.Object(
  {
    authenticated: Type.Boolean(),
    personId: Type.Optional(Type.String()),
    displayName: Type.Optional(Type.String()),
    role: Type.Optional(SessionRole),
  },
  { additionalProperties: false },
);

export type TSessionRole = Static<typeof SessionRole>;
export type TLoginRequest = Static<typeof LoginRequest>;
export type TChangePasscodeRequest = Static<typeof ChangePasscodeRequest>;
export type TLoginResponse = Static<typeof LoginResponse>;
export type TSessionResponse = Static<typeof SessionResponse>;
