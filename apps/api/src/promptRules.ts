/**
 * prompt 与校验器共用的硬规则常量。改这里，prompt 插值与服务端校验一起变。
 * 数值来源：预审候选 schema 与既有校验逻辑，契约值不在这里重新定义。
 */

/** 预审七类 entry。顺序与 prompt 展示一致。 */
export const PREFLIGHT_ENTRY_KINDS = [
  "core_judgment",
  "strategic_alignment",
  "positive_signal",
  "risk_calibration",
  "meeting_question",
  "next_step",
  "leader_lens",
] as const;

/** 恰好 1 条的类别。 */
export const PREFLIGHT_EXACTLY_ONE_KINDS = ["core_judgment", "strategic_alignment"] as const;
/** 至少 1 条的类别。 */
export const PREFLIGHT_AT_LEAST_ONE_KINDS = ["positive_signal", "risk_calibration", "next_step"] as const;

export const MEETING_QUESTION_MIN = 3;
export const MEETING_QUESTION_MAX = 5;
export const LEADER_LENS_MIN = 3;
export const LEADER_LENS_MAX = 5;

/** leader_lens 禁止出现的元评述字样；校验器与 prompt 引用同一份。 */
export const LEADER_LENS_FORBIDDEN_PHRASES = ["视角预判", "非权威发言"] as const;
export const LEADER_LENS_FORBIDDEN_TEXT = LEADER_LENS_FORBIDDEN_PHRASES.map((phrase) => `“${phrase}”`).join("");

/** 预研禁止自造的英文 slug / 方法标签例子；只提示，无对应服务端校验。 */
export const RESEARCH_FORBIDDEN_SLUG_EXAMPLES = ["thin-four-domain-baseline", "minimal-control-first"] as const;
