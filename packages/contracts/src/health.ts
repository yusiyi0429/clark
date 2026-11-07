import { Type, type Static } from "@sinclair/typebox";
import { NullableInteger } from "./nullable.js";

/** API health 只报告布尔安全摘要：不返回 secret，也不发起模型/Search 调用（.tech/07 §8）。 */
export const HealthDependencies = Type.Object(
  {
    piRuntime: Type.Boolean(),
    modelSlots: Type.Boolean(),
    /** 人员目录已装载（登录、角色、人名只看它）。 */
    peopleDirectory: Type.Boolean(),
    /** 本体公司事实读取是否配全（本体地址与凭证、按人授权文件）；只看配置，不影响 status。 */
    companyConfigured: Type.Boolean(),
    search: Type.Boolean(),
    wechat: Type.Boolean(),
    outlets: Type.Boolean(),
    /** 会议录音识别的两段外部凭据是否配全（TOS 对象存储、火山语音识别）；不含 ffmpeg 自检。 */
    recording: Type.Object({ tos: Type.Boolean(), asr: Type.Boolean() }, { additionalProperties: false }),
    /** 腾讯云声纹（说话人注册 / 1:N）凭据是否配全；只看变量在不在，不发起外部调用。 */
    voiceprint: Type.Boolean(),
    /** world 推送凭据是否配全；false 表示未配置，不发起外部调用。 */
    world: Type.Boolean(),
  },
  { additionalProperties: false },
);

/** 本体（tkos.world）连通状态：启动时只读探测的结果；不含凭证，也不含地址。world 状态不影响 status。 */
export const WorldHealth = Type.Object(
  {
    configured: Type.Boolean(),
    /** 实例配置：mvp（原配置）、demo（演示范围）、formal（集团正式范围）或 tk（词元云集范围，只读）。 */
    instance: Type.String(),
    scopeId: Type.Union([Type.String(), Type.Null()]),
    /** 读侧集成（战场目标、Agent 上下文）是否启用。 */
    reads: Type.Boolean(),
    /** 写回是否启用（演示范围第 1 期关闭）。 */
    writes: Type.Boolean(),
    state: Type.Union([Type.Literal("not_configured"), Type.Literal("checking"), Type.Literal("connected"), Type.Literal("error")]),
    checkedAt: Type.Union([Type.String(), Type.Null()]),
    contractVersion: Type.Union([Type.String(), Type.Null()]),
    serverVersion: Type.Union([Type.String(), Type.Null()]),
    objects: Type.Union([Type.Object({
      company: Type.Integer({ minimum: 0 }), strategy: Type.Integer({ minimum: 0 }), units: Type.Integer({ minimum: 0 }),
      longTermGoals: Type.Integer({ minimum: 0 }), periodGoals: Type.Integer({ minimum: 0 }),
    }, { additionalProperties: false }), Type.Null()]),
    errorCode: Type.Union([Type.String(), Type.Null()]),
    httpStatus: NullableInteger(),
  },
  { additionalProperties: false },
);

export const HealthResponse = Type.Object(
  {
    status: Type.Union([Type.Literal("ok"), Type.Literal("degraded")]),
    api: Type.Boolean(),
    database: Type.Boolean(),
    buildSha: Type.String(),
    dependencies: HealthDependencies,
    world: Type.Optional(WorldHealth),
    /** 第二个只读实例（词元云集 TK scope，TKOS_WORLD_TK_INSTANCE）；没配时不带这一项。 */
    worldTk: Type.Optional(WorldHealth),
  },
  { additionalProperties: false },
);

export type THealthResponse = Static<typeof HealthResponse>;
