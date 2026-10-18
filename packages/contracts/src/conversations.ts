import { Type, type Static } from "@sinclair/typebox";

export const ConversationScope = Type.String({
  pattern: "^(global|(issue|signal|meeting|monthly-plan|mission-card|monthly-review-item|personal-review|task):[A-Za-z0-9][A-Za-z0-9_-]{0,127}|mission:.{1,128})$",
  description: "global 或稳定对象 scope",
});

export const CardReference = Type.Object(
  { cardId: Type.String({ minLength: 1 }), version: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);

export const ReferenceSnapshot = Type.Object(
  {
    cardId: Type.String(),
    version: Type.Integer({ minimum: 1 }),
    kind: Type.String(),
    title: Type.String(),
    objectRef: Type.Object(
      { type: Type.String(), id: Type.String(), version: Type.Integer({ minimum: 1 }) },
      { additionalProperties: false },
    ),
    payload: Type.Unknown(),
  },
  { additionalProperties: false },
);

export const ConversationAttachmentRef = Type.Object(
  { id: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

/** 已上传附件的可见信息；不含抽取文本与存储键。 */
export const ConversationAttachmentInfo = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    fileName: Type.String({ minLength: 1 }),
    mimeType: Type.Union([
      Type.Literal("application/pdf"),
      Type.Literal("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
      Type.Literal("text/markdown"),
    ]),
    sizeBytes: Type.Integer({ minimum: 1 }),
    pageCount: Type.Optional(Type.Integer({ minimum: 1 })),
  },
  { additionalProperties: false },
);

/** 持久化在 user 消息行 attachments jsonb 内的完整元数据；原件只留在 API 卷。 */
export const ConversationAttachment = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    fileName: Type.String({ minLength: 1 }),
    mimeType: Type.Union([
      Type.Literal("application/pdf"),
      Type.Literal("application/vnd.openxmlformats-officedocument.wordprocessingml.document"),
      Type.Literal("text/markdown"),
    ]),
    sizeBytes: Type.Integer({ minimum: 1 }),
    pageCount: Type.Optional(Type.Integer({ minimum: 1 })),
    storageKey: Type.String({ minLength: 1 }),
    sha256: Type.String({ pattern: "^[a-f0-9]{64}$" }),
    extractedText: Type.String({ minLength: 1, maxLength: 100000 }),
  },
  { additionalProperties: false },
);

export const ConversationAttachmentUploadResponse = Type.Object(
  { attachments: Type.Array(ConversationAttachmentInfo, { maxItems: 10 }) },
  { additionalProperties: false },
);

/**
 * 三层取用的读取范围（已定设计 5a）：谁（全员 / 本人 / 指定的人，personId）、哪个战场、哪几个月（YYYY-MM，含两端）。
 * Agent 跨对象读取时发 scope 事件带上它；本人在界面上改了范围，下一轮请求带 scopeOverride，这一轮的读取一律按它。
 */
const Month = Type.String({ pattern: "^\\d{4}-(0[1-9]|1[0-2])$" });
export const ReadScopeParams = Type.Object(
  {
    people: Type.Optional(Type.Union([
      Type.Literal("all"),
      Type.Literal("me"),
      Type.Array(Type.String({ minLength: 1, maxLength: 100 }), { minItems: 1, maxItems: 30, uniqueItems: true }),
    ])),
    battlefieldId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    from: Type.Optional(Month),
    to: Type.Optional(Month),
  },
  { additionalProperties: false },
);

/** 范围标签：label 是「全员 · 7–10 月」这样的短标签；choices 是点开调整时可选的人。 */
export const ReadScope = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: 80 }),
    params: ReadScopeParams,
    choices: Type.Optional(Type.Object(
      { people: Type.Array(Type.Object({ id: Type.String(), name: Type.String() }, { additionalProperties: false }), { maxItems: 80 }) },
      { additionalProperties: false },
    )),
  },
  { additionalProperties: false },
);

export const ConversationMessageRequest = Type.Object(
  {
    message: Type.String({ minLength: 1, maxLength: 20_000 }),
    references: Type.Optional(Type.Array(CardReference, { maxItems: 20 })),
    attachments: Type.Optional(Type.Array(ConversationAttachmentRef, { maxItems: 10 })),
    /** 工单 09：页面左侧正在看的那份材料；必须属于这个 scope 的对象。 */
    viewingMaterialId: Type.Optional(Type.String({ format: "uuid" })),
    /**
     * 「继续」：接着上一轮没完成的回答（那一轮的 runId）。有已写出的部分时从断点续写，没有时用已查到的材料重答；
     * 只能接这个人在这个页面自己的那一轮。
     */
    resumeRunId: Type.Optional(Type.String({ format: "uuid" })),
    /** 本人在范围标签上改过的读取范围：这一轮三层取用的工具一律按它读。 */
    scopeOverride: Type.Optional(ReadScopeParams),
  },
  { additionalProperties: false },
);

/**
 * 这一轮实际用了备用模型，或走了恢复路径（重试、从断点续写、精简历史）：回答末尾一行很淡的说明。
 * text 是那一行（不写模型名、不写技术细节）；detail 是悬停时更具体一点的说明（同样不写英文原文）。
 */
export const ConversationRecoveryNote = Type.Object(
  { text: Type.String({ minLength: 1, maxLength: 120 }), detail: Type.String({ maxLength: 400 }) },
  { additionalProperties: false },
);

/**
 * 回答后面挂的卡（对话里的一句话入口：生成复盘、帮我问问、请同事帮忙）。由服务端按工具结果生成，不由模型写；
 * 卡上的状态（是否已发出、草稿进度）由界面按 id 读最新的对象，发出仍走各对象自己的 Action。href 是对象页面的地址。
 */
export const ConversationCard = Type.Union([
  /** 复盘草稿：摘要与「打开修改」。 */
  Type.Object({ kind: Type.Literal("review"), personalReviewId: Type.String({ minLength: 1 }), href: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  /** 周复盘草稿：摘要与「打开修改」。 */
  Type.Object({ kind: Type.Literal("weekly_review"), weeklyReviewId: Type.String({ minLength: 1 }), href: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  /** 对上不止一件待办：本人点选其中一件，再查有没有人问过、整理问题。 */
  Type.Object({
    kind: Type.Literal("todo_pick"),
    question: Type.String({ minLength: 1, maxLength: 1000 }),
    candidates: Type.Array(Type.Object({
      requestId: Type.String({ minLength: 1 }), title: Type.String(), initiatorName: Type.String(), sentAt: Type.String(), href: Type.String({ minLength: 1 }),
    }, { additionalProperties: false }), { minItems: 2, maxItems: 4 }),
  }, { additionalProperties: false }),
  /** 已整理好的问题，等本人点「发送」。 */
  Type.Object({ kind: Type.Literal("todo_ask"), requestId: Type.String({ minLength: 1 }), question: Type.String({ minLength: 1, maxLength: 1000 }), href: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  /** 说明或已有问答里有答案：答案原文与出处；本人仍可以问。 */
  Type.Object({
    kind: Type.Literal("todo_answer"), requestId: Type.String({ minLength: 1 }), href: Type.String({ minLength: 1 }),
    question: Type.String({ minLength: 1, maxLength: 1000 }), answer: Type.String({ minLength: 1 }),
    source: Type.Union([Type.Literal("body"), Type.Literal("question")]), questionId: Type.Union([Type.String(), Type.Null()]),
  }, { additionalProperties: false }),
  /** 本人发起的请求草稿：收件人、标题、说明与「发送」。 */
  Type.Object({ kind: Type.Literal("request_draft"), requestId: Type.String({ minLength: 1 }), href: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  /** 本人发起的信息收集草稿：收什么、发给谁、截止、每周固定与「发送」。 */
  Type.Object({ kind: Type.Literal("collection_draft"), collectionId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
]);

export const ConversationMessage = Type.Object(
  {
    sequence: Type.Integer({ minimum: 1 }),
    role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
    content: Type.String(),
    referencesSnapshot: Type.Array(ReferenceSnapshot),
    attachments: Type.Array(ConversationAttachmentInfo),
    runId: Type.String(),
    createdAt: Type.String({ format: "date-time" }),
    /** 只在助手回答上、且这一轮走过恢复时才有。 */
    recoveryNote: Type.Optional(ConversationRecoveryNote),
    /** 只在助手回答上：这一轮实际装进上下文的个人记忆 id。回答里的记忆标记只认这里有的。 */
    memoryUsed: Type.Optional(Type.Array(Type.String())),
    /** 只在助手回答上：这一轮工具生成的卡（排在回答后面）。 */
    cards: Type.Optional(Type.Array(ConversationCard, { maxItems: 4 })),
    /** 只在助手回答上：这一轮跨对象读取的范围（最后一次）。 */
    readScope: Type.Optional(ReadScope),
    /**
     * carried：从首页带过来的一段对话（转议题时复制进议题页对话）；trace：留痕行（「已转到议题 X」），点击直达 meta.href。
     * 普通消息没有这个字段。
     */
    kind: Type.Optional(Type.Union([Type.Literal("carried"), Type.Literal("trace")])),
    meta: Type.Optional(Type.Object(
      { issueId: Type.Optional(Type.String()), title: Type.Optional(Type.String()), href: Type.Optional(Type.String()) },
      { additionalProperties: false },
    )),
  },
  { additionalProperties: false },
);

export const ConversationHistory = Type.Object(
  {
    scope: ConversationScope,
    messages: Type.Array(ConversationMessage),
  },
  { additionalProperties: false },
);

const StreamBase = {
  runId: Type.String(),
  scope: ConversationScope,
  sequence: Type.Integer({ minimum: 1 }),
};

export const ConversationSseEvent = Type.Union([
  Type.Object({ ...StreamBase, type: Type.Literal("message"), delta: Type.String() }, { additionalProperties: false }),
  Type.Object(
    {
      ...StreamBase,
      type: Type.Literal("tool"),
      phase: Type.Union([Type.Literal("started"), Type.Literal("completed")]),
      toolCallId: Type.String(),
      name: Type.String(),
      isError: Type.Optional(Type.Boolean()),
      /** 工具开始时给界面的一行进度（查什么，不含工具名）。 */
      label: Type.Optional(Type.String()),
      /** 工具结束时这一步实际读到了什么（条数、来源标题、企业知识节名），由系统按工具结果生成。 */
      detail: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  /**
   * Agent 处理时的当前步骤（服务端在工具开始、结束时映射）：同一 id 的后一条取代前一条。
   * label 是短动词短语；result 是这一步读到了什么（系统生成），有就直接显示。
   */
  Type.Object(
    {
      ...StreamBase,
      type: Type.Literal("step"),
      id: Type.String(),
      label: Type.String(),
      status: Type.Union([Type.Literal("done"), Type.Literal("active"), Type.Literal("pending"), Type.Literal("stopped")]),
      result: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  /** 跨对象读取的范围标签（三层取用）：界面显示成可以点开调整的标签；同一轮后一条取代前一条。 */
  Type.Object({ ...StreamBase, type: Type.Literal("scope"), label: ReadScope.properties.label, params: ReadScopeParams, choices: ReadScope.properties.choices }, { additionalProperties: false }),
  /** 本轮档位：快答 / 检索问答 / 深度；检索问答与深度档带一句开场说明（notice），界面先显示它和预计用时。 */
  Type.Object(
    {
      ...StreamBase,
      type: Type.Literal("route"),
      tier: Type.Union([Type.Literal("quick"), Type.Literal("grounded"), Type.Literal("deep")]),
      source: Type.Union([Type.Literal("rule"), Type.Literal("model"), Type.Literal("fallback")]),
      expectSeconds: Type.Integer({ minimum: 0 }),
      timeoutMs: Type.Integer({ minimum: 0 }),
      notice: Type.Optional(Type.String()),
      /** 本档的主答模型 id（只用于日志）。 */
      model: Type.Optional(Type.String()),
    },
    { additionalProperties: false },
  ),
  /**
   * 模型在思考。summary：推理摘要里的一句中文要点（英文摘要不下发）；delta：思考摘要的中文正文，逐段追加（英文段落已译成中文）。
   */
  Type.Object({ ...StreamBase, type: Type.Literal("thinking"), summary: Type.Optional(Type.String()), delta: Type.Optional(Type.String()) }, { additionalProperties: false }),
  /** 非深度档中途升级：回答超过约 20 秒还没出正文，或模型连续多轮检索；notice 是给界面的整句。 */
  Type.Object(
    {
      ...StreamBase,
      type: Type.Literal("escalation"),
      reason: Type.Union([Type.Literal("slow"), Type.Literal("retrieval")]),
      expectSeconds: Type.Integer({ minimum: 0 }),
      notice: Type.String(),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...StreamBase,
      type: Type.Literal("usage"),
      input: Type.Integer({ minimum: 0 }),
      output: Type.Integer({ minimum: 0 }),
      cacheRead: Type.Integer({ minimum: 0 }),
      cacheWrite: Type.Integer({ minimum: 0 }),
      totalTokens: Type.Integer({ minimum: 0 }),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...StreamBase,
      type: Type.Literal("compaction"),
      phase: Type.Union([Type.Literal("started"), Type.Literal("completed")]),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...StreamBase,
      type: Type.Literal("warning"),
      code: Type.Literal("RUNTIME_RECREATED"),
      message: Type.String(),
    },
    { additionalProperties: false },
  ),
  /**
   * 上游出错后正在自动恢复（同档重试、换备用模型、精简历史重试、从断点续写）：notice 是给进度行的一句中文，
   * attempt 是这一步的第几次尝试。恢复成功时正文接着流入，不另发事件。
   */
  Type.Object(
    {
      ...StreamBase,
      type: Type.Literal("recovery"),
      reason: Type.String(),
      action: Type.Union([Type.Literal("retry"), Type.Literal("fallback"), Type.Literal("trim"), Type.Literal("continue"), Type.Literal("skip")]),
      attempt: Type.Integer({ minimum: 1 }),
      notice: Type.String(),
    },
    { additionalProperties: false },
  ),
  /**
   * 这一轮没能完成。message 是给一号位的中文说明（原因 + 已保留什么 + 下一步）；
   * resume：continue = 有已写出的部分，可以从断点续写；retry = 没写出正文，可以用已查到的材料重答；没有 = 不建议直接再试（如凭证失效）。
   * partial：已写出的部分已存进这条对话（读回历史就能看到）。
   */
  Type.Object(
    {
      ...StreamBase,
      type: Type.Literal("error"),
      code: Type.String(),
      message: Type.String(),
      resume: Type.Optional(Type.Union([Type.Literal("continue"), Type.Literal("retry")])),
      partial: Type.Optional(Type.Boolean()),
    },
    { additionalProperties: false },
  ),
  Type.Object(
    {
      ...StreamBase,
      type: Type.Literal("done"),
      status: Type.Union([Type.Literal("completed"), Type.Literal("aborted")]),
      /** 这一轮走过恢复：与存进回答的那行说明相同。 */
      recoveryNote: Type.Optional(ConversationRecoveryNote),
    },
    { additionalProperties: false },
  ),
]);

export type TConversationScope = Static<typeof ConversationScope>;
export type TCardReference = Static<typeof CardReference>;
export type TReferenceSnapshot = Static<typeof ReferenceSnapshot>;
export type TConversationAttachmentRef = Static<typeof ConversationAttachmentRef>;
export type TConversationAttachmentInfo = Static<typeof ConversationAttachmentInfo>;
export type TConversationAttachment = Static<typeof ConversationAttachment>;
export type TConversationAttachmentUploadResponse = Static<typeof ConversationAttachmentUploadResponse>;
export type TReadScopeParams = Static<typeof ReadScopeParams>;
export type TReadScope = Static<typeof ReadScope>;
export type TConversationMessageRequest = Static<typeof ConversationMessageRequest>;
export type TConversationMessage = Static<typeof ConversationMessage>;
export type TConversationCard = Static<typeof ConversationCard>;
export type TConversationHistory = Static<typeof ConversationHistory>;
export type TConversationRecoveryNote = Static<typeof ConversationRecoveryNote>;
export type TConversationSseEvent = Static<typeof ConversationSseEvent>;
