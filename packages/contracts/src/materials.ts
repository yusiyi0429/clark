import { Type, type Static } from "@sinclair/typebox";

/**
 * 工单 09 材料区：议题、执行事项的材料。群成员都能上传，只有主人能删；
 * 只有 Agent 能改，且只能改 Markdown 和 HTML 源码；每改一次存一版。
 */
export const MaterialObjectType = Type.Union([Type.Literal("issue"), Type.Literal("task")]);
/** html：工单 12，在沙箱里原样显示；和 Markdown 一样只能让 Agent 改源码。 */
export const MaterialFormat = Type.Union([Type.Literal("markdown"), Type.Literal("pdf"), Type.Literal("docx"), Type.Literal("html")]);

const MaterialPerson = Type.Object(
  { personId: Type.String({ minLength: 1 }), displayName: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

/** 某一版是谁让 Agent 改的；上传的第 1 版 requestedBy、summary 为 null。 */
export const MaterialRevisionView = Type.Object(
  {
    version: Type.Integer({ minimum: 1 }),
    requestedBy: Type.Union([MaterialPerson, Type.Null()]),
    summary: Type.Union([Type.String({ minLength: 1, maxLength: 200 }), Type.Null()]),
    /** ISO 8601 */
    at: Type.String({ minLength: 1 }),
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

export const MaterialBlock = Type.Object(
  { text: Type.String(), change: MaterialBlockChange },
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
