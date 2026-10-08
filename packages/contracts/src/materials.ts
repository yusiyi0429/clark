import { Type, type Static } from "@sinclair/typebox";

/**
 * 工单 09 材料区：议题、执行事项的材料。群成员都能上传，只有主人能删；
 * 只有 Agent 能改，且只能改 Markdown 和 HTML 源码；每改一次存一版。
 */
/** meeting：工单 14，会议页也有群组材料区，规则同议题、执行事项。 */
export const MaterialObjectType = Type.Union([Type.Literal("issue"), Type.Literal("task"), Type.Literal("meeting")]);
/** html：工单 12，在沙箱里原样显示；和 Markdown 一样只能让 Agent 改源码。 */
export const MaterialFormat = Type.Union([Type.Literal("markdown"), Type.Literal("pdf"), Type.Literal("docx"), Type.Literal("html")]);

const MaterialPerson = Type.Object(
  { personId: Type.String({ minLength: 1 }), displayName: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

/** 这一版是按哪条批注改的（批注原文与意见）；不是按批注改的为 null。 */
export const MaterialAnnotationRef = Type.Union([
  Type.Object(
    { id: Type.String({ minLength: 1 }), quote: Type.String(), body: Type.String(), author: MaterialPerson },
    { additionalProperties: false },
  ),
  Type.Null(),
]);

/** 某一版是谁让 Agent 改的；上传的第 1 版 requestedBy、summary 为 null。 */
export const MaterialRevisionView = Type.Object(
  {
    version: Type.Integer({ minimum: 1 }),
    requestedBy: Type.Union([MaterialPerson, Type.Null()]),
    summary: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
    /** ISO 8601 */
    at: Type.String({ minLength: 1 }),
    annotation: MaterialAnnotationRef,
  },
  { additionalProperties: false },
);

export const MaterialView = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    objectType: MaterialObjectType,
    objectId: Type.String({ minLength: 1 }),
    fileName: Type.String({ minLength: 1, maxLength: 240 }),
    format: MaterialFormat,
    sizeBytes: Type.Integer({ minimum: 0 }),
    pageCount: Type.Optional(Type.Integer({ minimum: 1 })),
    /** upload：有人上传；agent：Agent 按 owner 的要求新写的。 */
    origin: Type.Union([Type.Literal("upload"), Type.Literal("agent")]),
    /** 上传者；Agent 新写的是让它写的人。只有 owner 能删。 */
    owner: MaterialPerson,
    createdAt: Type.String({ minLength: 1 }),
    updatedAt: Type.String({ minLength: 1 }),
    version: Type.Integer({ minimum: 1 }),
    /** Markdown 和 HTML 能让 Agent 改；PDF、Word 只读。 */
    editable: Type.Boolean(),
    /**
     * 本人能不能让 Co-Agent 改这份：只有上传者和对象负责人（执行事项是推进人，会议是主持人，议题是 CEO），且只限 Markdown / HTML。
     * 能改的人选中文字有「立即修改」，能采用 / 不采用别人的批注、处理别人的修改建议、恢复删掉的段落。
     */
    canEdit: Type.Boolean(),
    /** 等本人「采用 / 不采用」的批注条数（别人保存的）；不能改这份时为 0。 */
    pending: Type.Integer({ minimum: 0 }),
    canDelete: Type.Boolean(),
    /** 最近一次 Agent 修改；只有第 1 版时为 null。 */
    lastRevision: Type.Union([MaterialRevisionView, Type.Null()]),
  },
  { additionalProperties: false },
);

export const MaterialListResponse = Type.Object(
  { materials: Type.Array(MaterialView, { maxItems: 30 }), canUpload: Type.Boolean() },
  { additionalProperties: false },
);

export const MaterialChangeSpan = Type.Object(
  { text: Type.String(), changed: Type.Boolean() },
  { additionalProperties: false },
);

/** 块级标注：这一版相对上一版。删掉的块 text 为空字符串。 */
export const MaterialBlockChange = Type.Union([
  Type.Null(),
  Type.Object(
    { kind: Type.Literal("modified"), before: Type.String(), spans: Type.Array(MaterialChangeSpan) },
    { additionalProperties: false },
  ),
  Type.Object({ kind: Type.Literal("added") }, { additionalProperties: false }),
  Type.Object({ kind: Type.Literal("removed"), before: Type.String() }, { additionalProperties: false }),
]);

/** 一段文字的一次改动（悬停时显示）：改之前的原文、谁让改的、按哪条批注。 */
export const MaterialBlockHistoryEntry = Type.Object(
  {
    version: Type.Integer({ minimum: 2 }),
    kind: Type.Union([Type.Literal("modified"), Type.Literal("added")]),
    /** 改之前的原文；added 为空字符串。 */
    before: Type.String(),
    requestedBy: Type.Union([MaterialPerson, Type.Null()]),
    at: Type.String({ minLength: 1 }),
    annotation: MaterialAnnotationRef,
  },
  { additionalProperties: false },
);

/**
 * change 是这一版相对上一版；history 是这段文字历次的改动（新的在前，最多 5 条，只在看最新版时给，没改过为空数组）。
 * 删掉的块不再在正文里提示，页面直接不显示，统一进 removed（垃圾篓）。
 */
export const MaterialBlock = Type.Object(
  { text: Type.String(), change: MaterialBlockChange, history: Type.Array(MaterialBlockHistoryEntry, { maxItems: 5 }) },
  { additionalProperties: false },
);

/**
 * 批注状态：noted 保存着、还没处理（PDF、Word 只能这样）→ 能改的人「立即修改」或采用后 queued 排队等 Co-Agent 改
 * → applying 改着 → applied 改完（appliedVersion）/ no_change 看过不用改 / failed；declined：能改的人不采用。
 */
export const MaterialAnnotationStatus = Type.Union([
  Type.Literal("noted"), Type.Literal("queued"), Type.Literal("applying"), Type.Literal("applied"),
  Type.Literal("no_change"), Type.Literal("failed"), Type.Literal("declined"),
]);

export const MaterialAnnotationView = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    materialId: Type.String({ minLength: 1 }),
    /** 写批注时看的版本。 */
    version: Type.Integer({ minimum: 1 }),
    quote: Type.String(),
    body: Type.String(),
    author: MaterialPerson,
    status: MaterialAnnotationStatus,
    appliedVersion: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
    /** no_change 时是 Co-Agent 的一句说明；failed 时是失败原因；declined 时是不采用的原因（可以没有）。 */
    note: Type.Union([Type.String(), Type.Null()]),
    /** 采用或不采用的人；能改的人自己「立即修改」时是他本人；还没处理为 null。 */
    decidedBy: Type.Union([MaterialPerson, Type.Null()]),
    /** 原文已改：写批注之后材料改过，选中的文字在最新版里已经找不到（只看还没处理的批注）。 */
    stale: Type.Boolean(),
    /** 本人能「采用 / 不采用」：别人保存的批注，本人能改这份材料。 */
    canDecide: Type.Boolean(),
    /** 本人能把自己保存的批注改成「立即修改」。 */
    canApply: Type.Boolean(),
    createdAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);

/** 选中材料里的一段文字写批注；prefix / suffix 是选中处前后各最多 200 字，用来在原文里定位。 */
export const CreateMaterialAnnotationRequest = Type.Object(
  {
    clientId: Type.String({ format: "uuid" }),
    version: Type.Integer({ minimum: 1 }),
    quote: Type.String({ minLength: 1, maxLength: 2000 }),
    prefix: Type.String({ maxLength: 200 }),
    suffix: Type.String({ maxLength: 200 }),
    body: Type.String({ minLength: 1, maxLength: 2000, pattern: "\\S" }),
    /** 不传时只保存（noted）；edit「立即修改」只给能改这份材料的人，排队让 Co-Agent 按批注改。 */
    intent: Type.Optional(Type.Union([Type.Literal("note"), Type.Literal("edit")])),
  },
  { additionalProperties: false },
);
export const CreateMaterialAnnotationResponse = Type.Object({ annotation: MaterialAnnotationView }, { additionalProperties: false });

/** 能改的人处理一条保存着的批注：adopt 采用（进原队列，和「立即修改」一样）；decline 不采用，原因可不填。 */
export const DecideMaterialAnnotationRequest = Type.Object(
  {
    decision: Type.Union([Type.Literal("adopt"), Type.Literal("decline")]),
    reason: Type.Optional(Type.String({ maxLength: 1000 })),
  },
  { additionalProperties: false },
);

/** 垃圾篓里的一段：哪一版删掉的、谁让删的、按哪条批注；restorable 为 false 时（例如材料已只读）不给恢复。 */
export const MaterialRemovedView = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    version: Type.Integer({ minimum: 2 }),
    text: Type.String(),
    requestedBy: Type.Union([MaterialPerson, Type.Null()]),
    at: Type.String({ minLength: 1 }),
    annotation: MaterialAnnotationRef,
    restorable: Type.Boolean(),
  },
  { additionalProperties: false },
);
/** 恢复一段被删的文字：插回原来的位置（跟在它原来前一段后面），存成新的一版。version 是当前最新版，旧了返回 409。 */
export const RestoreMaterialRemovedRequest = Type.Object(
  { removedId: Type.String({ minLength: 1 }), version: Type.Integer({ minimum: 1 }) },
  { additionalProperties: false },
);

/**
 * 对话里 Co-Agent 的修改提议：显示在材料上方，点「按这个改」才改；材料已被别人改过则 stale。
 * 不能改这份材料的人在对话里要改时，提议交给上传者（proposedFor），对象负责人也能处理。
 */
export const MaterialEditProposalView = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    materialId: Type.String({ minLength: 1 }),
    version: Type.Integer({ minimum: 1 }),
    summary: Type.String({ minLength: 1, maxLength: 200 }),
    /** 预览：每处改动的原文与改后（最多 10 处）。 */
    changes: Type.Array(Type.Object({ before: Type.String(), after: Type.String() }, { additionalProperties: false }), { maxItems: 10 }),
    /** 在对话里提的人。 */
    proposedBy: MaterialPerson,
    proposedFor: MaterialPerson,
    status: Type.Union([Type.Literal("pending"), Type.Literal("applied"), Type.Literal("dismissed"), Type.Literal("stale")]),
    createdAt: Type.String({ minLength: 1 }),
  },
  { additionalProperties: false },
);
export const DecideMaterialEditProposalRequest = Type.Object(
  { decision: Type.Union([Type.Literal("apply"), Type.Literal("dismiss")]) },
  { additionalProperties: false },
);

export const MaterialDetailResponse = Type.Object(
  {
    material: MaterialView,
    /** 正在看的版本；latest 为 false 时是旧版。 */
    version: Type.Integer({ minimum: 1 }),
    latest: Type.Boolean(),
    revision: MaterialRevisionView,
    /** Markdown 的分块和标注；HTML 只含有改动的行（第 1 版为空数组）；PDF、Word 为 null，页面用 preview。 */
    blocks: Type.Union([Type.Array(MaterialBlock), Type.Null()]),
    /** 新的在前。 */
    revisions: Type.Array(MaterialRevisionView),
    /** 这份材料上的批注，新的在前。 */
    annotations: Type.Array(MaterialAnnotationView),
    /** 垃圾篓：历次被删掉的段落，新的在前（只在看最新版时给；PDF、Word 为空数组）。 */
    removed: Type.Array(MaterialRemovedView),
    /** 当前看这份材料的人名下待确认的修改提议（只在看最新版时给）。 */
    proposals: Type.Array(MaterialEditProposalView),
  },
  { additionalProperties: false },
);

export type TMaterialObjectType = Static<typeof MaterialObjectType>;
export type TMaterialFormat = Static<typeof MaterialFormat>;
export type TMaterialRevisionView = Static<typeof MaterialRevisionView>;
export type TMaterialView = Static<typeof MaterialView>;
export type TMaterialListResponse = Static<typeof MaterialListResponse>;
export type TMaterialChangeSpan = Static<typeof MaterialChangeSpan>;
export type TMaterialBlockChange = Static<typeof MaterialBlockChange>;
export type TMaterialBlock = Static<typeof MaterialBlock>;
export type TMaterialDetailResponse = Static<typeof MaterialDetailResponse>;
export type TMaterialAnnotationRef = Static<typeof MaterialAnnotationRef>;
export type TMaterialBlockHistoryEntry = Static<typeof MaterialBlockHistoryEntry>;
export type TMaterialAnnotationStatus = Static<typeof MaterialAnnotationStatus>;
export type TMaterialAnnotationView = Static<typeof MaterialAnnotationView>;
export type TCreateMaterialAnnotationRequest = Static<typeof CreateMaterialAnnotationRequest>;
export type TCreateMaterialAnnotationResponse = Static<typeof CreateMaterialAnnotationResponse>;
export type TDecideMaterialAnnotationRequest = Static<typeof DecideMaterialAnnotationRequest>;
export type TMaterialRemovedView = Static<typeof MaterialRemovedView>;
export type TRestoreMaterialRemovedRequest = Static<typeof RestoreMaterialRemovedRequest>;
export type TMaterialEditProposalView = Static<typeof MaterialEditProposalView>;
export type TDecideMaterialEditProposalRequest = Static<typeof DecideMaterialEditProposalRequest>;
