import { Type, type Static } from "@sinclair/typebox";

/** 前端判断能否走飞书免登：未配置飞书应用时 enabled=false、不给 appId。 */
export const FeishuAuthConfigResponse = Type.Object(
  { enabled: Type.Boolean(), appId: Type.Optional(Type.String()) },
  { additionalProperties: false },
);

/** 在飞书客户端里打开时，requestAccess（旧版 requestAuthCode）拿到的一次性 code。 */
export const FeishuCodeLoginRequest = Type.Object(
  { code: Type.String({ minLength: 1, maxLength: 512 }) },
  { additionalProperties: false },
);

export type TFeishuAuthConfigResponse = Static<typeof FeishuAuthConfigResponse>;
export type TFeishuCodeLoginRequest = Static<typeof FeishuCodeLoginRequest>;
