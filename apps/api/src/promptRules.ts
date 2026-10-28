/**
 * prompt 与校验器共用的硬规则常量。改这里，prompt 插值与服务端校验一起变。
 * 数值来源：预审候选 schema 与既有校验逻辑，契约值不在这里重新定义。
 */

/**
 * 会前预审 v5（10/28，按管理层汇报案例重写）每一项的条数：要聊的问题、要拍板的事、缺什么、拍板选项。
 * 上限与契约 maxItems 一致；下限按档位在 meetingPreflight.ts 的 preflightCandidateError 里校验。
 */
export const PREFLIGHT_QUESTIONS_MAX = 3;
export const PREFLIGHT_DECISIONS_MAX = 2;
export const PREFLIGHT_GAPS_MAX = 2;
export const PREFLIGHT_OPTIONS_MIN = 2;
export const PREFLIGHT_OPTIONS_MAX = 3;
/** 篇幅目标（字）：写进提示词；契约上限放宽到两三倍，只防失控，不按目标卡。 */
export const PREFLIGHT_LENGTH = { decision: 50, headline: 40, body: 150, question: 50, why: 80 } as const;

/**
 * 两个问题的正文去标点后：字符二元组 Dice 相似度达到该值，或较短一条（≥8 字）被另一条包含，即视为同一疑问。
 * 服务端确定性合并（要拍板的事优先，同类保留先出现的一条，合并来源），不让同一问题换话术出现在两处。
 */
export const CEO_QUESTION_DUPLICATE_SIMILARITY = 0.6;
export const CEO_QUESTION_CONTAINMENT_MIN_CHARS = 8;

/** 预研禁止自造的英文 slug / 方法标签例子；只提示，无对应服务端校验。 */
export const RESEARCH_FORBIDDEN_SLUG_EXAMPLES = ["thin-four-domain-baseline", "minimal-control-first"] as const;
