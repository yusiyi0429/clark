import { Type, type Static } from "@sinclair/typebox";

/**
 * Nexus → DRI 确认（协议 nexus-dri-confirmation/0.1，溪南 11/10 接口包）。
 * 会后链归 Nexus：会上待定的事项由 Nexus 推给天枢；天枢让事项预先指定的负责人本人确认 / 修改 / 拒绝，再回调 Nexus；
 * Nexus 核验后自己写本体，天枢这一侧不写本体。
 *
 * Nexus 调天枢（服务凭据 Authorization: Bearer，NEXUS_DRI_SERVICE_TOKEN；没配时这三个接口不注册）：
 * - POST {NEXUS_DRI_REQUESTS_PATH}：推一条待确认项。Content-Type: application/json，正文不超过 NEXUS_DRI_MAX_BODY_BYTES 字节（超了 413），
 *   Idempotency-Key 必须是 nexusDriIdempotencyKey(requestId, revision)（不是 400 IDEMPOTENCY_KEY_MISMATCH）。
 *   正文按 NexusDriRequest 校验（400 INVALID_INPUT）；fingerprint 是「请求去掉 fingerprint 后的规范化 JSON 的 SHA-256 hex」，
 *   规范化 = 各层对象的键按字典序排、数组保持原顺序、紧凑输出（不带空白），UTF-8 编码（算不对 400 FINGERPRINT_MISMATCH）；
 *   recipientTenant、agentId 不是天枢这边配置的值 403 TENANT_MISMATCH / AGENT_MISMATCH。
 *   成功回 200 NexusDriReceipt：accepted 只表示天枢收到了，不代表本人确认。同一个 Idempotency-Key 重发回同一张回执；
 *   同一个键、正文指纹不同 409 IDEMPOTENCY_CONFLICT。
 *   同一个 requestId 来了更大的 revision：旧 revision 作废，本人不能再确认旧的（只看得到新的）；
 *   来的 revision 比已收到的最大 revision 小而且没收过 409 STALE_REVISION；同一个 requestId 换了 itemId 或 meetingId 409 ITEM_MISMATCH。
 * - GET {NEXUS_DRI_REQUESTS_PATH}/{requestId}/receipt?revision=<n>：只读回执（投递结果不明时按原幂等键对账）；没收过 404 RECEIPT_NOT_FOUND。
 * - GET {NEXUS_DRI_CONFIRMATIONS_PATH}/{confirmationRef}：读回本人的确认记录（NexusDriConfirmationRecord）；没有 404 CONFIRMATION_NOT_FOUND。
 *
 * 本人这一侧（浏览器会话）：
 * - GET /api/me/nexus-confirmations：等我确认的（我是负责人、没过期、没作废、还没处理）。
 * - POST /api/me/nexus-confirmations/{id}/decision：确认 / 修改 / 拒绝。只有负责人本人能点，别人 403 NOT_CONFIRMER；
 *   过了 expiresAt 409 EXPIRED；被新 revision 作废 409 SUPERSEDED；已处理过 409 ALREADY_DECIDED；
 *   修改只能改 value、保留本人原文：没带 value 400 VALUE_REQUIRED，和原来一样 400 VALUE_UNCHANGED，这一条没有可改的 value 400 NOT_AMENDABLE，
 *   改后回调正文超过 NEXUS_DRI_MAX_BODY_BYTES 字节 400 VALUE_TOO_LONG。
 *
 * 负责人：第一版取 proposedConfirmers 的第一位（本体人员 ID），按天枢的「人员 → 本体人员」对应找到天枢里的人；对不上记成找不到人，没有人能确认。
 * 到期：过了 expiresAt 作废，不回 pending、不催人。
 *
 * 天枢回调 Nexus（地址 NEXUS_DRI_CALLBACK_URL、共享密钥 NEXUS_DRI_CALLBACK_SECRET；没配就不发，记成待发）：
 * 正文 NexusDriCallback；头 x-dri-timestamp（13 位毫秒）和 x-dri-signature: sha256=<hex>，HMAC-SHA256 签「时间戳.原始正文」，
 * 发出去的正文字节和签名时一致。callbackId 稳定：重试用同一个 id、同一份正文、重新签。
 * 200 记成已送达（只表示 Nexus 存下了，不等于写进本体）；400 / 401 / 403 / 404 / 409 / 413 / 415 记成失败、不重试；
 * 500 / 503 和连不上按后台任务的退避重试。第一版不发 pending。
 */
export const NEXUS_DRI_CONTRACT = "nexus-dri-confirmation/0.1";
/** agentId 的缺省值（跟溪南约好的）；本地回放合成样例时可用 NEXUS_DRI_AGENT_ID 换成样例里的值。 */
export const NEXUS_DRI_AGENT_ID = "tianshu-dri";
export const NEXUS_DRI_MAX_BODY_BYTES = 32768;
export const NEXUS_DRI_REQUESTS_PATH = "/api/integrations/nexus/dri/requests";
export const NEXUS_DRI_CONFIRMATIONS_PATH = "/api/integrations/nexus/dri/confirmations";
export const nexusDriIdempotencyKey = (requestId: string, revision: number): string => `nexus-dri-delivery:${requestId}:${revision}`;

export const MeetingWorkTarget = Type.Object({
  projectId: Type.String({ format: "uuid" }), kind: Type.Union([Type.Literal("project"), Type.Literal("task"), Type.Literal("card"), Type.Literal("topic")]),
  id: Type.String({ minLength: 1, maxLength: 500 }),
}, { additionalProperties: false });
export const MeetingWorkAuthorization = Type.Object({
  authorization: Type.Literal("continue"),
  targets: Type.Array(Type.Object({ ...MeetingWorkTarget.properties, instruction: Type.Optional(Type.String({ maxLength: 4000 })) }, { additionalProperties: false }), { minItems: 1, maxItems: 30 }),
}, { additionalProperties: false });

const Sha256Hex = Type.String({ pattern: "^[0-9a-f]{64}$" });
const Id = (maxLength = 300) => Type.String({ minLength: 1, maxLength });

/**
 * 待本人确认的内容：分类、目标、字段、值。value 是本人看到并且能改的那段文字；没有 value 的（有限 operation）只能确认或拒绝。
 * 别的字段原样保留（指纹按整份请求算）。
 */
export const NexusDriContent = Type.Object(
  {
    classification: Id(100),
    targetRef: Id(500),
    fieldKey: Type.Optional(Id(200)),
    value: Type.Optional(Type.String({ minLength: 1, maxLength: 20000 })),
  },
  { additionalProperties: true },
);

/** 来源：精确的 id / version / hash / turnId / reference 和必要的短原话（不带整场原稿）。 */
export const NexusDriSource = Type.Object(
  {
    id: Id(),
    version: Id(),
    hash: Sha256Hex,
    turnId: Type.Optional(Id()),
    reference: Type.Optional(Id(1000)),
    quote: Type.Optional(Type.String({ maxLength: 4000 })),
  },
  { additionalProperties: true },
);

export const NexusDriRequest = Type.Object(
  {
    contract: Type.Literal(NEXUS_DRI_CONTRACT),
    requestId: Id(),
    itemId: Id(),
    revision: Type.Integer({ minimum: 1 }),
    /** Nexus 的会议实例 id（不是天枢的会议 id）。 */
    meetingId: Id(),
    scopeId: Id(),
    recipientTenant: Id(),
    agentId: Id(),
    minutesRef: Id(1000),
    question: Type.String({ minLength: 1, maxLength: 4000 }),
    content: NexusDriContent,
    /** 建议找谁（本体人员 ID）；第一版取第一位当负责人。 */
    proposedConfirmers: Type.Array(Id(), { maxItems: 20 }),
    disclosureRef: Id(1000),
    source: NexusDriSource,
    /** 毫秒时间戳。 */
    createdAt: Type.Integer({ minimum: 0 }),
    expiresAt: Type.Integer({ minimum: 0 }),
    /** 绑定 requestId，不作鉴权。 */
    callbackCorrelation: Id(),
    fingerprint: Sha256Hex,
  },
  { additionalProperties: true },
);

/** 接收回执：receiptId 是天枢存下这一版请求的记录 id；tenantId 是天枢这边的租户。 */
export const NexusDriReceipt = Type.Object(
  {
    accepted: Type.Literal(true),
    receiptId: Type.String({ minLength: 1 }),
    tenantId: Type.String({ minLength: 1 }),
    requestId: Type.String({ minLength: 1 }),
    itemId: Type.String({ minLength: 1 }),
    revision: Type.Integer({ minimum: 1 }),
    fingerprint: Sha256Hex,
  },
  { additionalProperties: false },
);
export const NexusDriReceiptParams = Type.Object({ requestId: Id() }, { additionalProperties: false });
export const NexusDriReceiptQuery = Type.Object({ revision: Type.Integer({ minimum: 1 }) }, { additionalProperties: false });

export const NexusDriDecision = Type.Union([Type.Literal("confirmed"), Type.Literal("amended"), Type.Literal("rejected")]);

/**
 * 本人的确认记录（confirmationRef 就是这条记录的 id）：绑 requestId、itemId、revision 和原请求指纹（fingerprint，不会被覆盖）。
 * question、content 是本人确认时看到的准确内容（原请求里的，原样）；confirmedBy 是本体人员 ID。
 * 修改时另带 amendedContent（原 content 只换 value，本人原文）和 amendedFingerprint（amendedContent 规范化 JSON 的 SHA-256 hex，规范化同请求指纹）。
 */
export const NexusDriConfirmationRecord = Type.Object(
  {
    confirmationRef: Type.String({ minLength: 1 }),
    requestId: Type.String({ minLength: 1 }),
    itemId: Type.String({ minLength: 1 }),
    revision: Type.Integer({ minimum: 1 }),
    fingerprint: Sha256Hex,
    decision: NexusDriDecision,
    confirmedBy: Type.String({ minLength: 1 }),
    /** ISO 时间（UTC，毫秒）。 */
    confirmedAt: Type.String({ minLength: 1 }),
    question: Type.String({ minLength: 1 }),
    content: NexusDriContent,
    amendedContent: Type.Optional(NexusDriContent),
    amendedFingerprint: Type.Optional(Sha256Hex),
  },
  { additionalProperties: false },
);
export const NexusDriConfirmationParams = Type.Object({ confirmationRef: Id() }, { additionalProperties: false });

/** 回调 Nexus 的正文（字段顺序照溪南的样例）；content 只在 amended 时带，是完整的修改后内容。 */
export const NexusDriCallback = Type.Object(
  {
    callbackId: Type.String({ minLength: 1 }),
    requestId: Type.String({ minLength: 1 }),
    itemId: Type.String({ minLength: 1 }),
    revision: Type.Integer({ minimum: 1 }),
    fingerprint: Sha256Hex,
    decision: NexusDriDecision,
    confirmedBy: Type.String({ minLength: 1 }),
    confirmedAt: Type.String({ minLength: 1 }),
    confirmationRef: Type.String({ minLength: 1 }),
    content: Type.Optional(NexusDriContent),
  },
  { additionalProperties: false },
);

/** 等我确认的一条：id 是回执 id；value 为 null 的不能修改，只能确认或拒绝；quote 是会上原话。 */
export const NexusConfirmationItem = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    meetingId: Type.String({ minLength: 1 }),
    question: Type.String({ minLength: 1 }),
    value: Type.Union([Type.String(), Type.Null()]),
    quote: Type.Union([Type.String(), Type.Null()]),
    createdAt: Type.String({ minLength: 1 }),
    expiresAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export const NexusConfirmationListResponse = Type.Object({ items: Type.Array(NexusConfirmationItem) }, { additionalProperties: false });
export const NexusConfirmationParams = Type.Object({ id: Type.String({ format: "uuid" }) }, { additionalProperties: false });
/** value 只在 amended 时带；continueWork 是本人同时选定并明确授权的去向，可以在确认后独立重试。 */
export const NexusConfirmationDecisionRequest = Type.Object(
  { decision: NexusDriDecision, value: Type.Optional(Type.String({ minLength: 1, maxLength: 20000 })), continueWork: Type.Optional(MeetingWorkAuthorization) },
  { additionalProperties: false },
);
export const NexusConfirmationDecisionResponse = Type.Object({ confirmationRef: Type.String({ minLength: 1 }) }, { additionalProperties: false });

export type TNexusDriContent = Static<typeof NexusDriContent>;
export type TNexusDriRequest = Static<typeof NexusDriRequest>;
export type TNexusDriReceipt = Static<typeof NexusDriReceipt>;
export type TNexusDriDecision = Static<typeof NexusDriDecision>;
export type TNexusDriConfirmationRecord = Static<typeof NexusDriConfirmationRecord>;
export type TNexusDriCallback = Static<typeof NexusDriCallback>;
export type TNexusConfirmationItem = Static<typeof NexusConfirmationItem>;
export type TNexusConfirmationListResponse = Static<typeof NexusConfirmationListResponse>;
export type TNexusConfirmationDecisionRequest = Static<typeof NexusConfirmationDecisionRequest>;
export type TNexusConfirmationDecisionResponse = Static<typeof NexusConfirmationDecisionResponse>;
