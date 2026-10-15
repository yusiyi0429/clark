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

/** 恰好 1 条的类别：没有核心判断就不是一份预审。 */
export const PREFLIGHT_EXACTLY_ONE_KINDS = ["core_judgment"] as const;
/** 最多 1 条的类别：普通同步会可以没有战略一致性判断，不为凑类别编造。 */
export const PREFLIGHT_AT_MOST_ONE_KINDS = ["strategic_alignment"] as const;
/**
 * 不设下限的类别（feedback 18）：积极信号、风险、下一步、会议问题和一号位追问都按材料实际情况给，可以为 0 条。
 * 只保留上限，避免把普通执行内容堆给 CEO。
 */
export const PREFLIGHT_OPTIONAL_KINDS = ["positive_signal", "risk_calibration", "next_step", "meeting_question", "leader_lens"] as const;

/** 需要 CEO 当场判断的问题与一号位追问：0 条合法，上限防止凑数。 */
export const MEETING_QUESTION_MAX = 5;
export const LEADER_LENS_MAX = 5;
/** CEO 级问题类别：必须带 ceoDecision（为什么现在、为什么需要 CEO、选项与影响）。 */
export const CEO_QUESTION_KINDS = ["meeting_question", "leader_lens"] as const;
/** meeting_question 是取舍，至少两个可选路径；leader_lens 是拍板前追问，选项可为空。 */
export const MEETING_QUESTION_MIN_OPTIONS = 2;
/**
 * 两条 CEO 级问题的正文去标点后：字符二元组 Dice 相似度达到该值，或较短一条（≥8 字）被另一条包含，即视为同一疑问。
 * 服务端确定性合并（保留先出现的一条，合并来源），不让同一问题换话术出现在两个栏目。
 */
export const CEO_QUESTION_DUPLICATE_SIMILARITY = 0.6;
export const CEO_QUESTION_CONTAINMENT_MIN_CHARS = 8;

/** leader_lens 禁止出现的元评述字样；校验器与 prompt 引用同一份。 */
export const LEADER_LENS_FORBIDDEN_PHRASES = ["视角预判", "非权威发言"] as const;
export const LEADER_LENS_FORBIDDEN_TEXT = LEADER_LENS_FORBIDDEN_PHRASES.map((phrase) => `“${phrase}”`).join("");

/** 预研禁止自造的英文 slug / 方法标签例子；只提示，无对应服务端校验。 */
export const RESEARCH_FORBIDDEN_SLUG_EXAMPLES = ["thin-four-domain-baseline", "minimal-control-first"] as const;
