import { Type, type Static } from "@sinclair/typebox";
import { WorldAnchor } from "./meetingDecisions.js";
import { BuddyAskQuestion, BuddyPlan, BuddyUiEffect } from "./buddyActions.js";

/**
 * 对话的 scope。project:<projectId> 是新首页的项目对话（本人和这个项目的那条伙伴对话，projects.ts；原来的 Task 管线并进来了），
 * 和总管线 global 各是各的历史；task:<id> 是执行事项详情页的对话，不是它。
 */
export const ConversationScope = Type.String({
  pattern: "^(global|(issue|signal|meeting|monthly-plan|mission-card|monthly-review-item|personal-review|task):[A-Za-z0-9][A-Za-z0-9_-]{0,127}|mission:.{1,128}|project:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$",
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

/**
 * Agent 向本人提问（ask_user 工具）：一次 1–4 题，每题 2–4 个选项，recommended 标推荐（每题最多一个）。
 * 界面一题一页作答，另给「其他」自己写，也可以跳过；提问后这一轮就停，答案作为本人的下一条消息发回来。
 */
export const AskOption = Type.Object(
  {
    label: Type.String({ minLength: 1, maxLength: 40 }),
    /** 选项下面一行补充（代价、含义），没有就不写。 */
    detail: Type.Optional(Type.String({ maxLength: 120 })),
    recommended: Type.Optional(Type.Boolean()),
  },
  { additionalProperties: false },
);
const AskQuestionFields = {
  question: Type.String({ minLength: 1, maxLength: 200 }),
  options: Type.Array(AskOption, { minItems: 2, maxItems: 4 }),
};
/** 工具参数：题目与选项，题号由服务端给。 */
export const AskUserInput = Type.Object(
  { questions: Type.Array(Type.Object(AskQuestionFields, { additionalProperties: false }), { minItems: 1, maxItems: 4 }) },
  { additionalProperties: false },
);
export const AskQuestion = Type.Object(
  { id: Type.String({ minLength: 1, maxLength: 8 }), ...AskQuestionFields },
  { additionalProperties: false },
);

/** 本人的作答：每题选一个选项（option 是下标）或自己写（text）；两样都没有就是跳过。 */
export const AskAnswerInput = Type.Object(
  {
    askId: Type.String({ format: "uuid" }),
    items: Type.Array(Type.Object(
      {
        questionId: Type.String({ minLength: 1, maxLength: 8 }),
        option: Type.Optional(Type.Integer({ minimum: 0, maximum: 3 })),
        text: Type.Optional(Type.String({ minLength: 1, maxLength: 1000 })),
      },
      { additionalProperties: false },
    ), { maxItems: 4 }),
  },
  { additionalProperties: false },
);

/** 存在那条作答消息上的问答记录（服务端按提问卡核对后生成）：界面画成紧凑的问答，不再显示原文。 */
export const AskAnswerRecord = Type.Object(
  {
    askId: Type.String(),
    items: Type.Array(Type.Object(
      {
        questionId: Type.String(),
        question: Type.String(),
        kind: Type.Union([Type.Literal("option"), Type.Literal("other"), Type.Literal("skipped")]),
        /** 选的选项原文，或自己写的；跳过时没有。 */
        answer: Type.Optional(Type.String()),
        /** 选的就是推荐的那个。 */
        recommended: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: false },
    ), { minItems: 1, maxItems: 4 }),
  },
  { additionalProperties: false },
);

/**
 * 场景锚点（PR #12 Anchor 层）：页面告诉服务端本人此刻在看哪张卡、看到的是哪一版。只传标识与版本，不传正文；
 * 服务端在本人有权看的页面投影里找这张卡，找不到 404，版本比当前旧时照常回答、在锚点上标明页面是旧版本。
 */
export const AnchorSelection = Type.Object(
  { cardId: Type.String({ minLength: 1, maxLength: 256 }), version: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);

/**
 * 项目对话这一轮为什么在云端跑（17.2 第 38 条，见 projectLocalTurns.ts）：本该在本机跑，local_unavailable 本机起不来，local_quota 本机那家订阅额度用完。
 */
export const LocalFallbackReason = Type.Union([Type.Literal("local_unavailable"), Type.Literal("local_quota")]);

export const ConversationMessageRequest = Type.Object(
  {
    message: Type.String({ minLength: 1, maxLength: 20_000 }),
    /** 本人已提交的排队消息。同一标识重试保留正在运行的工作。 */
    queuedInputId: Type.Optional(Type.String({ format: "uuid" })),
    /** 当前页面上聚焦的那张卡；不带时对象页聚焦页面对象本身，首页没有聚焦项。 */
    anchorSelection: Type.Optional(AnchorSelection),
    /** 回答 Agent 的提问：带了它，这一句的原文由服务端按提问卡和答案重写。 */
    answers: Type.Optional(AskAnswerInput),
    /** 这一句是在回答伙伴的哪个选项框（ConversationCard 的 buddy_question）：那张标成 answered，不是 dismissed。原文照发，不改写。 */
    buddyQuestionId: Type.Optional(Type.String({ format: "uuid" })),
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
    /** 本人此刻所在页面的路径（如 /me/task-quality）：首页对话据此告诉 Agent 这是哪个页面、能做什么。 */
    pagePath: Type.Optional(Type.String({ minLength: 1, maxLength: 200, pattern: "^/" })),
    /** 只在项目对话：这一句本该在本机跑、本机没跑成，改发云端（见 LocalFallbackReason）。读回历史时这一轮的回答带同样的 fallback。 */
    fallback: Type.Optional(LocalFallbackReason),
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

const MeetingDraftPerson = Type.Object({ personId: Type.String({ minLength: 1 }), displayName: Type.String() }, { additionalProperties: false });

/**
 * 回答后面挂的卡（对话里的一句话入口：生成复盘、帮我问问、请同事帮忙、约会议）。由服务端按工具结果生成，不由模型写；
 * 卡上的状态（是否已发出、草稿进度）由界面按 id 读最新的对象，发出仍走各对象自己的 Action。href 是对象页面的地址。
 */
export const ConversationCard = Type.Union([
  /** 伙伴要发给同事的一句话（17.4 send_message）：本人在卡上看一眼、点「发出」才由天枢机器人转达（GET /api/me/buddy-messages/:draftId）。 */
  Type.Object({ kind: Type.Literal("buddy_message"), draftId: Type.String({ format: "uuid" }) }, { additionalProperties: false }),
  /**
   * 伙伴的选项框（18 节第 9 条，伙伴调 ask_user 出的）：跟着出它的那一轮画在对话记录里，不钉在输入框上方。每题给选项（recommended 的在第一个），网页另带「自己填」。
   * status：open 还在等本人；answered 本人点选项答了；dismissed 本人没答、发了别的话。本人在这个对话（伙伴台或那个项目对话）里发出任何一条新消息，
   * 云端就把还 open 的那张标成 dismissed（网页发出时也可以先收起，读历史以云端为准）；只有 open 的画成能点的框，answered、dismissed 的不画或只留一行淡字，由网页定。
   * 作答：网页把选择拼成一句话当作本人的新消息发出（如「部署方式：只发预发（推荐）；时间：本周五」），请求带 buddyQuestionId，那张标成 answered。
   */
  Type.Object({
    kind: Type.Literal("buddy_question"),
    questionId: Type.String({ format: "uuid" }),
    questions: Type.Array(BuddyAskQuestion, { minItems: 1, maxItems: 4 }),
    status: Type.Union([Type.Literal("open"), Type.Literal("answered"), Type.Literal("dismissed")]),
  }, { additionalProperties: false }),
  /** 复盘草稿：摘要与「打开修改」。 */
  Type.Object({ kind: Type.Literal("review"), personalReviewId: Type.String({ minLength: 1 }), href: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  /** 周复盘草稿：摘要与「打开修改」。 */
  Type.Object({ kind: Type.Literal("weekly_review"), weeklyReviewId: Type.String({ minLength: 1 }), href: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  /** 对上不止一件待办：本人点选其中一件，再查有没有人问过、整理问题。 */
  Type.Object({
    kind: Type.Literal("todo_pick"),
    question: Type.String({ minLength: 1, maxLength: 1000 }),
    candidates: Type.Array(Type.Object({
      requestId: Type.String({ minLength: 1 }), title: Type.String(), initiatorId: Type.Optional(Type.String()), initiatorName: Type.String(), sentAt: Type.String(), href: Type.String({ minLength: 1 }),
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
  /** Agent 的提问：题目列表与「开始回答」；回答过的按后面那条作答消息显示成「已回答」。 */
  Type.Object({ kind: Type.Literal("questions"), askId: Type.String({ minLength: 1 }), questions: Type.Array(AskQuestion, { minItems: 1, maxItems: 4 }) }, { additionalProperties: false }),
  /** 本人发起的信息收集草稿：收什么、发给谁、截止、每周固定与「发送」。 */
  Type.Object({ kind: Type.Literal("collection_draft"), collectionId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
  /**
   * 对话里起草的会议（不落库，草稿整份在卡上）：名称、起止、主持人、参会人、挂到，「约好」走建会接口（带 draftId，同一张卡只建一场），
   * 「改」打开约会议面板。人名在人员目录里没对上或对上不止一个的放进 unresolved（host 为 true 的是主持人），不猜。
   */
  Type.Object({
    kind: Type.Literal("meeting_draft"),
    draftId: Type.String({ minLength: 1 }),
    title: Type.String({ minLength: 1, maxLength: 200 }),
    scheduledAt: Type.String({ minLength: 1 }),
    endsAt: Type.String({ minLength: 1 }),
    host: Type.Union([MeetingDraftPerson, Type.Null()]),
    participants: Type.Array(MeetingDraftPerson, { maxItems: 50 }),
    unresolved: Type.Array(Type.Object({
      name: Type.String({ minLength: 1, maxLength: 40 }),
      reason: Type.Union([Type.Literal("not_found"), Type.Literal("ambiguous")]),
      host: Type.Optional(Type.Boolean()),
    }, { additionalProperties: false }), { maxItems: 20 }),
    anchor: Type.Union([WorldAnchor, Type.Null()]),
  }, { additionalProperties: false }),
]);

/**
 * 这一轮实际用的模型（项目对话、伙伴台走 Chat 的回答）：provider 是来源（Chat 配的接入方，如 tokenhub），model 是模型名。只记这两样，不记钥匙、地址。
 * 一轮里调了几次模型时取最后一次。Chat 没报（老版本、天枢自己的对话）的没有。
 */
export const ConversationModel = Type.Object(
  { provider: Type.String({ minLength: 1, maxLength: 60 }), model: Type.String({ minLength: 1, maxLength: 120 }) },
  { additionalProperties: false },
);

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
    /** 只在助手回答上：这一轮伙伴最后一张计划清单（17.4，见 buddyActions.ts 的 BuddyPlan）；没出清单的没有这个字段。 */
    plan: Type.Optional(BuddyPlan),
    /**
     * 只在助手回答上：这一轮实际用的来源和模型（见 ConversationModel）；不知道的没有这个字段。
     * 项目对话在本机跑的那一轮（ranOn = local）：provider 是执行方（「Claude Code」「Codex」），model 是给人看的模型名（「Opus 5.5」）。
     */
    model: Type.Optional(ConversationModel),
    /**
     * 只在项目对话的助手回答上（17.2 第 38 条）：这一轮在哪跑，cloud 云端、local 本人电脑上。项目对话以外没有这个字段。
     * 网页底部胶囊、轮次旁的来源按它和 model 写：「本机 · Opus 5.5」「云端 · claude-opus-5-5」。
     */
    ranOn: Type.Optional(Type.Union([Type.Literal("cloud"), Type.Literal("local")])),
    /** 只在项目对话的助手回答上：这一轮本该在本机、没跑成改在云端（同 ConversationMessageRequest.fallback）。网页在旁边写一行这一轮用的是云端。 */
    fallback: Type.Optional(LocalFallbackReason),
    /** 只在助手回答上：这一轮跨对象读取的范围（最后一次）。 */
    readScope: Type.Optional(ReadScope),
    /** 只在本人的作答消息上：回答 Agent 提问的问答记录。 */
    answers: Type.Optional(AskAnswerRecord),
    /**
     * carried：从首页带过来的一段对话（转议题时复制进议题页对话）；trace：留痕行（「已转到议题 X」），点击直达 meta.href。
     * 普通消息没有这个字段。
     */
    kind: Type.Optional(Type.Union([Type.Literal("carried"), Type.Literal("trace")])),
    /**
     * 这一轮是在飞书私聊机器人或微信 ClawBot 里说的（问与答都标）；buddy 是伙伴从伙伴台转来的（项目对话里本人那一句，17.4 message_project，只标本人那句）；
     * report 是子会话停了、云端替本人给项目主管线发的那句（18 节第 10 条，只标那一句；报告本身是项目动态里的 sub_session_report，网页不把这句画成本人的气泡）；
     * 网页里不标的就是在天枢里说的。
     */
    via: Type.Optional(Type.Union([Type.Literal("feishu"), Type.Literal("wechat"), Type.Literal("buddy"), Type.Literal("report")])),
    /** 只在本人的提问上：这一轮服务端还在回答（首页对话走独立 Chat 时）。切走、刷新回来据此接上这一轮。 */
    running: Type.Optional(Type.Boolean()),
    meta: Type.Optional(Type.Object(
      { issueId: Type.Optional(Type.String()), title: Type.Optional(Type.String()), href: Type.Optional(Type.String()) },
      { additionalProperties: false },
    )),
    /**
     * 本人挂在这条消息上的表情，按块一块一个（只在伙伴台和项目对话；见 ConversationReaction）；没挂的没有这个字段。
     * part 是第几块（伙伴回答拆成的气泡或卡片，从 0 数；本人的话只有第 0 块），-1 是老数据，网页当成最后一块。
     */
    reactions: Type.Optional(Type.Array(Type.Object(
      { part: Type.Integer({ minimum: -1 }), emoji: Type.String({ minLength: 1, maxLength: 16 }) },
      { additionalProperties: false },
    ))),
    /** 伙伴点在这条消息上的表情（派活成功后在本人那句话上点 👍）；和本人的分开存，本人改自己的不动它。没点的没有这个字段。 */
    buddyReactions: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 16 }), { maxItems: 3 })),
  },
  { additionalProperties: false },
);

/** 一条消息上伙伴最多点几个表情。 */
export const MESSAGE_REACTION_MAX = 3;
/**
 * 本人给伙伴台、项目对话里一条消息的一块挂的表情：每块一个，写的时候换掉这一块原来的，emoji 为 null 是取消；返回存下的。
 * 只是本人自己的标记：不送给模型、不通知别人。消息按 runId + role 认（一轮里本人一句、回答一句；序号读历史时会重排，不拿它认），
 * part 同 ConversationMessage.reactions 的 part（-1 是老数据那一块）。
 */
export const ConversationReaction = Type.Object(
  {
    runId: Type.String({ minLength: 1, maxLength: 200 }),
    role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
    part: Type.Integer({ minimum: -1 }),
    emoji: Type.Union([Type.String({ minLength: 1, maxLength: 16 }), Type.Null()]),
  },
  { additionalProperties: false },
);

/**
 * 项目对话正在本人电脑上跑的那一轮（17.2 第 38 条）：还没写进对话历史，读历史时单独给。手机、别的页面据此画「正在回答」和本人那一句；
 * 本机这台电脑上的网页直接从本机读实时内容。turnId 是这一轮的 id（结束后历史里那一轮的 runId 就是它）。
 */
export const ConversationLocalTurn = Type.Object(
  {
    turnId: Type.String({ format: "uuid" }),
    message: Type.String(),
    startedAt: Type.String({ format: "date-time" }),
    deviceName: Type.String(),
    /** 在哪跑、用的什么：「本机 · Claude Code · Opus 5.5」。 */
    source: Type.String(),
  },
  { additionalProperties: false },
);

export const ConversationHistory = Type.Object(
  {
    scope: ConversationScope,
    messages: Type.Array(ConversationMessage),
    /** 只在项目对话：本机正占着的那一轮（见 ConversationLocalTurn）；没有不带。 */
    localTurn: Type.Optional(ConversationLocalTurn),
  },
  { additionalProperties: false },
);

/** 一轮回答：接上它的事件流、请服务端停下它。runId 是这一轮的标识（事件流每条都带）。 */
export const ConversationTurnParams = Type.Object(
  { scope: ConversationScope, runId: Type.String({ format: "uuid" }) },
  { additionalProperties: false },
);
/** 停止之后这一轮的状态（Chat 的 turns 状态：aborted / completed / failed）。 */
export const ConversationTurnStopResponse = Type.Object(
  { runId: Type.String(), status: Type.String() },
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
  /**
   * 伙伴的计划清单（17.4）：伙伴调 update_plan 时天枢插进这一轮；同一轮后一条取代前一条。collapsed=true 是本人中途发来新消息、这张清单收起。
   */
  Type.Object({ ...StreamBase, type: Type.Literal("plan"), plan: BuddyPlan }, { additionalProperties: false }),
  /** 伙伴动作在界面上的效果（17.4）：切外观、打开某一处、刷新哪几块（见 buddyActions.ts 的 BuddyUiEffect）。动作做完时天枢插进这一轮。 */
  Type.Object({ ...StreamBase, type: Type.Literal("ui"), ui: BuddyUiEffect }, { additionalProperties: false }),
  /** 伙伴这一轮出的卡（17.4：send_message 的 buddy_message）：动作做完时天枢插进这一轮的流，界面接在回答后面；读回历史时在这条回答的 cards 里。 */
  Type.Object({ ...StreamBase, type: Type.Literal("card"), card: ConversationCard }, { additionalProperties: false }),
  /**
   * 伙伴点的表情：派活成功（拆卡、开工、转话、重开、转给项目对话）后天枢在本人这一轮那句话上点 👍，插进这一轮的流。
   * emojis 是伙伴在这条消息上的整组（同历史里的 buddyReactions）；消息按 runId + role 认。
   */
  Type.Object({ ...StreamBase, type: Type.Literal("buddy_reaction"), role: Type.Literal("user"),
    emojis: Type.Array(Type.String({ minLength: 1, maxLength: 16 }), { minItems: 1, maxItems: 3 }) }, { additionalProperties: false }),
  /**
   * 本人这条消息的回执（17.4，伙伴对话：scope 为 global 和 project:<id>，网页发的才有）：delivered 天枢收下了（第一个勾），read 伙伴读到了（第二个勾）。
   * messageId 是天枢给这条消息的 id，两帧按它对上同一条消息。两帧都在这条消息自己的响应流里，排在最前面。
   * - 没在回复时发的：伙伴马上开始这一轮，两帧几乎同时到，都带 runId。
   * - 伙伴正在回上一轮时本人再发（中途插话）：不再回 409 TURN_IN_PROGRESS。天枢先开流、立即写 delivered（这时还没有这一轮，不带 runId），
   *   再停掉上一轮（上一轮的流以 done aborted 结束，计划清单收起），拿这条开新的一轮；新一轮第一帧到了写 read（带 runId）。
   *   给了 delivered 以后还是没开成（上一轮停不下来、对话服务拒收或连不上），在这条流里给一帧 error（code 同开流前的拒绝：TURN_IN_PROGRESS、
   *   RESUME_NOT_FOUND、CHAT_UNAVAILABLE、CHAT_FAILED 等，不带 runId）就结束，界面把第一个勾撤掉、这条消息可以重发。
   */
  Type.Object({ runId: Type.Optional(Type.String()), scope: StreamBase.scope, sequence: StreamBase.sequence, type: Type.Literal("receipt"),
    state: Type.Union([Type.Literal("delivered"), Type.Literal("read")]), messageId: Type.String({ minLength: 1 }) }, { additionalProperties: false }),
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
  /** 这一轮实际用的来源和模型（走 Chat 的对话，Chat 每次调完模型报一次；换了才再给）。网页画在回答下面，读历史时在 ConversationMessage.model。 */
  Type.Object({ ...StreamBase, type: Type.Literal("model"), provider: ConversationModel.properties.provider, model: ConversationModel.properties.model },
    { additionalProperties: false }),
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
   * runId：只有中途插话给了 delivered 以后、新一轮没开成时不带（见 receipt）。
   */
  Type.Object(
    {
      ...StreamBase,
      runId: Type.Optional(Type.String()),
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
export type TAskUserInput = Static<typeof AskUserInput>;
export type TAskQuestion = Static<typeof AskQuestion>;
export type TAskAnswerInput = Static<typeof AskAnswerInput>;
export type TAskAnswerRecord = Static<typeof AskAnswerRecord>;
export type TConversationMessageRequest = Static<typeof ConversationMessageRequest>;
export type TAnchorSelection = Static<typeof AnchorSelection>;
export type TConversationMessage = Static<typeof ConversationMessage>;
export type TConversationCard = Static<typeof ConversationCard>;
export type TConversationHistory = Static<typeof ConversationHistory>;
export type TConversationRecoveryNote = Static<typeof ConversationRecoveryNote>;
export type TConversationModel = Static<typeof ConversationModel>;
export type TLocalFallbackReason = Static<typeof LocalFallbackReason>;
export type TConversationLocalTurn = Static<typeof ConversationLocalTurn>;
export type TConversationSseEvent = Static<typeof ConversationSseEvent>;
export type TConversationReaction = Static<typeof ConversationReaction>;
