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
  { authenticated: Type.Boolean(), mustChangePasscode: Type.Boolean(), role: Type.Optional(SessionRole), onboarded: Type.Optional(Type.Boolean()) },
  { additionalProperties: false },
);

export const SessionResponse = Type.Object(
  {
    authenticated: Type.Boolean(),
    personId: Type.Optional(Type.String()),
    displayName: Type.Optional(Type.String()),
    role: Type.Optional(SessionRole),
    /** 登录 ID：个人菜单顶部写给本人看，修改口令也要用它。 */
    loginId: Type.Optional(Type.String()),
    /** 可选以兼容分批部署；当前 API 对已登录的人总会返回。 */
    onboarded: Type.Optional(Type.Boolean()),
    /** 同时是 CEO 和 DRI 的人可以在两种工作台之间切换；role 是当前视角。 */
    canSwitchView: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);

/** 切换当前视角（工单 07）：只有 canSwitchView 的人能调；重签会话，返回新的 SessionResponse。 */
export const SetViewRequest = Type.Object(
  { view: SessionRole },
  { additionalProperties: false },
);

export type TSessionRole = Static<typeof SessionRole>;
export type TLoginRequest = Static<typeof LoginRequest>;
export type TChangePasscodeRequest = Static<typeof ChangePasscodeRequest>;
export type TLoginResponse = Static<typeof LoginResponse>;
export type TSessionResponse = Static<typeof SessionResponse>;
export type TSetViewRequest = Static<typeof SetViewRequest>;
