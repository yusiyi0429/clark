import { Type, type Static } from "@sinclair/typebox";

export const MonthlyPlanStatus = Type.Union([
  Type.Literal("draft"),
  Type.Literal("negotiating"),
  Type.Literal("confirmed"),
]);

/** period 是 Asia/Shanghai 公司月的稳定键：YYYY-MM。MonthlyPlan 按月唯一。 */
export const MonthlyPlanPeriod = Type.String({ pattern: "^\\d{4}-(0[1-9]|1[0-2])$" });

/** 普通 todo：没有 open/done 等执行状态；battlefieldId 省略表示公司级。 */
export const MonthlyPlanTodo = Type.Object(
  {
    id: Type.String({ minLength: 1 }),
    battlefieldId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    title: Type.String({ minLength: 1, maxLength: 500 }),
    ownerId: Type.String({ minLength: 1, maxLength: 200 }),
    dueAt: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    sourceRef: Type.String({ minLength: 1, maxLength: 2000 }),
  },
  { additionalProperties: false },
);

export const MonthlyPlanBattlefield = Type.Object(
  {
    battlefieldId: Type.String({ minLength: 1, maxLength: 100 }),
    outcome: Type.String({ minLength: 1, maxLength: 4000 }),
  },
  { additionalProperties: false },
);

/** DRI 叙述性 feedback：只有文本、证据和 observedAt，不携带 todo 执行状态。 */
export const MonthlyPlanFeedback = Type.Object(
  {
    id: Type.String(),
    externalId: Type.String(),
    todoId: Type.Optional(Type.String()),
    battlefieldId: Type.Optional(Type.String()),
    text: Type.String(),
    evidenceRef: Type.Optional(Type.String()),
    observedAt: Type.String(),
    sourceRef: Type.String(),
  },
  { additionalProperties: false },
);

/** CEO 编辑记录：只记录改动发生的字段，不改写 Agent 候选历史。 */
export const MonthlyPlanEdit = Type.Object(
  { at: Type.String(), fields: Type.Array(Type.String()) },
  { additionalProperties: false },
);

export const MonthlyPlanError = Type.Object(
  { code: Type.String(), message: Type.String(), at: Type.String() },
  { additionalProperties: false },
);

export const MonthlyPlanNegotiation = Type.Object(
  {
    edits: Type.Array(MonthlyPlanEdit),
    checkedItemIds: Type.Array(Type.String()),
    feedback: Type.Array(MonthlyPlanFeedback),
    note: Type.String(),
  },
  { additionalProperties: false },
);

/** 草案生成生命周期：失败可见，只能由 CEO 显式重试，不自动升档或静默生成空计划。 */
export const MonthlyPlanGeneration = Type.Object(
  {
    status: Type.Union([
      Type.Literal("pending"),
      Type.Literal("running"),
      Type.Literal("ready"),
      Type.Literal("failed"),
    ]),
    pendingSince: Type.Union([Type.String(), Type.Null()]),
    runId: Type.Union([Type.String(), Type.Null()]),
    previousRunIds: Type.Array(Type.String()),
    error: Type.Union([MonthlyPlanError, Type.Null()]),
    generatedAt: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

export const MonthlyPlanCardPayload = Type.Object(
  {
    period: MonthlyPlanPeriod,
    status: MonthlyPlanStatus,
    companyOutcome: Type.String(),
    battlefields: Type.Array(MonthlyPlanBattlefield),
    todos: Type.Array(MonthlyPlanTodo),
    negotiation: MonthlyPlanNegotiation,
    generation: MonthlyPlanGeneration,
    confirmedAt: Type.Union([Type.String(), Type.Null()]),
  },
  { additionalProperties: false },
);

/** Draft Agent 内置 todos 还没有稳定 id；id 由 orchestrator 写入时分配。 */
export const MonthlyDraftTodo = Type.Object(
  {
    battlefieldId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    title: Type.String({ minLength: 1, maxLength: 500 }),
    ownerId: Type.String({ minLength: 1, maxLength: 200 }),
    dueAt: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
    sourceRef: Type.String({ minLength: 1, maxLength: 2000 }),
  },
  { additionalProperties: false },
);

/** Draft Agent 唯一结构化输出（Candidate Material）；代码再校验 owner 与字段。 */
export const MonthlyDraftCandidate = Type.Object(
  {
    companyOutcome: Type.String({ minLength: 1, maxLength: 4000 }),
    battlefields: Type.Array(MonthlyPlanBattlefield, { maxItems: 20 }),
    todos: Type.Array(MonthlyDraftTodo, { maxItems: 50 }),
  },
  { additionalProperties: false },
);

/** CEO versioned 编辑：公司结果、战场结果、普通 todo、核对项与 note。 */
export const UpdateMonthlyPlanDraftRequest = Type.Object(
  {
    companyOutcome: Type.Optional(Type.String({ minLength: 1, maxLength: 4000 })),
    battlefields: Type.Optional(Type.Array(MonthlyPlanBattlefield, { maxItems: 20 })),
    todos: Type.Optional(
      Type.Array(
        Type.Object(
          {
            id: Type.Optional(Type.String({ minLength: 1 })),
            battlefieldId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
            title: Type.String({ minLength: 1, maxLength: 500 }),
            ownerId: Type.String({ minLength: 1, maxLength: 200 }),
            dueAt: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
            sourceRef: Type.String({ minLength: 1, maxLength: 2000 }),
          },
          { additionalProperties: false },
        ),
        { maxItems: 50 },
      ),
    ),
    checkedItemIds: Type.Optional(Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 100 })),
    note: Type.Optional(Type.String({ maxLength: 5000 })),
  },
  { additionalProperties: false, minProperties: 1 },
);

const FeedbackBase = {
  externalId: Type.String({
    minLength: 1,
    maxLength: 200,
    description: "以 (period, externalId) 为幂等键；同内容返回原结果，不同内容 409",
  }),
  period: MonthlyPlanPeriod,
  submitterPersonId: Type.String({ minLength: 1, maxLength: 200 }),
  sourceRef: Type.String({ minLength: 1, maxLength: 2000 }),
  text: Type.String({ minLength: 1, maxLength: 4000 }),
  evidenceRef: Type.Optional(Type.String({ minLength: 1, maxLength: 2000 })),
  observedAt: Type.String({ minLength: 1, maxLength: 100 }),
  battlefieldId: Type.Optional(Type.String({ minLength: 1, maxLength: 100 })),
};

/** DRI 计划级叙述性 feedback。 */
export const DriMonthlyPlanFeedbackRequest = Type.Object(FeedbackBase, { additionalProperties: false });

/** DRI todo 级叙述性 feedback：只追加，不修改任何 todo 执行状态。 */
export const DriMonthlyPlanTodoFeedbackRequest = Type.Object(
  { ...FeedbackBase, todoId: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);

export type TMonthlyPlanStatus = Static<typeof MonthlyPlanStatus>;
export type TMonthlyPlanPeriod = Static<typeof MonthlyPlanPeriod>;
export type TMonthlyPlanTodo = Static<typeof MonthlyPlanTodo>;
export type TMonthlyPlanBattlefield = Static<typeof MonthlyPlanBattlefield>;
export type TMonthlyPlanFeedback = Static<typeof MonthlyPlanFeedback>;
export type TMonthlyPlanEdit = Static<typeof MonthlyPlanEdit>;
export type TMonthlyPlanNegotiation = Static<typeof MonthlyPlanNegotiation>;
export type TMonthlyPlanGeneration = Static<typeof MonthlyPlanGeneration>;
export type TMonthlyPlanCardPayload = Static<typeof MonthlyPlanCardPayload>;
export type TMonthlyDraftCandidate = Static<typeof MonthlyDraftCandidate>;
export type TUpdateMonthlyPlanDraftRequest = Static<typeof UpdateMonthlyPlanDraftRequest>;
export type TDriMonthlyPlanFeedbackRequest = Static<typeof DriMonthlyPlanFeedbackRequest>;
export type TDriMonthlyPlanTodoFeedbackRequest = Static<typeof DriMonthlyPlanTodoFeedbackRequest>;
