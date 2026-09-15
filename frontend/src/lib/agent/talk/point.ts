/**
 * 对谈里的判断状态对象与迁移提议。
 *
 * 这一层的设计原则：**模型产候选，人确认**。所以 `TalkPoint` 里没有 `confirmed` 栏，
 * `checkProposal` 拒一切带确认字样的提议（结构上的 + 正文里的）。对谈的候选过了之后
 * 原样抬到板上（`src/lib/data/types.ts:BoardJudgement`），确认那一步留给会议或对谈
 * 萃取，不在这里。
 */

import { SELF_CONFIRMED, VAGUE_REOPEN } from "@/lib/agent/rules";

export type TalkPoint = {
  issueId: string;
  /** 这个 session 在争的那一句。空串 = 还没收敛出争点。 */
  thesis: string;
  statements: string[];
  openQuestions: string[];
  /** 候选判断。四栏与 `BoardJudgement` 同名同义 —— 过了之后原样抬到板上，不做字段映射。 */
  candidate: { statement: string; basis: string; boundary?: string; reopenIf?: string } | null;
  /**
   * **上一轮结算落定时，判断是什么样子。** 也就是「进这一轮之前那一句」。
   *
   * 这一栏只由轮外结算写（`settle.ts` 每结算一轮写一次），`checkProposal` 的白名单里
   * 没有它 —— 模型递不进来，多出来的键整份拒。
   *
   * ## 它是干什么的
   *
   * 没有它的时候，结算拿「让步日志最后一条的 `after`」当这一轮的 `before`。于是某一轮
   * 改判**没能落成日志**（回应里指不出编号，那一轮只留痕不落库）之后，下一轮进来时
   * 「判断和日志对不上」这件事还在，只要那一轮的回应里出现任何一个真编号，就会落出一条
   * `{ turn: 下一轮, before: 旧判断, after: 新判断, kind: "concede" }` ——
   * **上一轮那次没有依据的改判，被洗成下一轮一次有依据的改判**，而这条伪造记录穿得过
   * 全部机检。这是反谄媚硬原则在生产路径上被绕过的一条完整通路。
   *
   * 有了这一栏，`changed` 才是「这一轮变的」，不是「累计还没记的变化」。上一轮那次缺席
   * 不会被洗掉：它以「日志前后接不上」的样子留在账上 —— 下一条真的落成的日志的 `before`
   * 与前一条的 `after` 对不上，`findDesync` 判据 2 会把它报出来，而不是被安到另一轮头上。
   *
   * 可选是为了兼容这一栏出现之前就存下来的判断状态：取不到时退回旧口径（日志最后一条
   * 的 `after`，没有日志就用 `thesis`）。
   */
  settledJudgement?: string;
};

export type PointProposal = Partial<Pick<TalkPoint, "thesis" | "statements" | "openQuestions" | "candidate">>;

/**
 * 校验一份迁移提议。
 *
 * **只认白名单四栏，多出来的键整份拒。** 不是过滤掉：过滤会让「模型试图确认判断」这件事
 * 静默成功一半 —— 它以为确认了，屏幕上没确认，日志里也没这次尝试的痕迹。整份拒 + 留痕，
 * 行为才解释得通。
 */
export function checkProposal(p: unknown): { ok: true; value: PointProposal } | { ok: false; why: string[] } {
  const why: string[] = [];

  if (typeof p !== "object" || p === null) {
    why.push("提议必须是对象");
    return { ok: false, why };
  }

  const obj = p as Record<string, unknown>;
  const allowed = new Set(["thesis", "statements", "openQuestions", "candidate"]);

  // 白名单检查：多出来的键整份拒
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      why.push(`提议包含不允许的字段：${key}`);
    }
  }
  if (why.length > 0) return { ok: false, why };

  const value: PointProposal = {};

  // thesis: 可选的字符串
  if ("thesis" in obj) {
    if (typeof obj.thesis !== "string") {
      why.push("thesis 必须是字符串");
    } else {
      value.thesis = obj.thesis;
    }
  }

  // statements: 可选的字符串数组
  if ("statements" in obj) {
    if (!Array.isArray(obj.statements)) {
      why.push("statements 必须是数组");
    } else if (!obj.statements.every((s) => typeof s === "string")) {
      why.push("statements 每一项必须是字符串");
    } else {
      value.statements = obj.statements;
    }
  }

  // openQuestions: 可选的字符串数组
  if ("openQuestions" in obj) {
    if (!Array.isArray(obj.openQuestions)) {
      why.push("openQuestions 必须是数组");
    } else if (!obj.openQuestions.every((s) => typeof s === "string")) {
      why.push("openQuestions 每一项必须是字符串");
    } else {
      value.openQuestions = obj.openQuestions;
    }
  }

  // candidate: 可选的对象，但如果存在必须有 statement 和 basis
  if ("candidate" in obj) {
    if (obj.candidate === null) {
      value.candidate = null;
    } else if (typeof obj.candidate !== "object") {
      why.push("candidate 必须是对象或 null");
    } else {
      const c = obj.candidate as Record<string, unknown>;

      // 检查不允许的字段（如 confirmed）
      const candidateAllowed = new Set(["statement", "basis", "boundary", "reopenIf"]);
      for (const key of Object.keys(c)) {
        if (!candidateAllowed.has(key)) {
          why.push(`candidate 包含不允许的字段：${key}`);
        }
      }

      if (typeof c.statement !== "string") {
        why.push("candidate.statement 必须是字符串");
      }
      if (typeof c.basis !== "string") {
        why.push("candidate.basis 必须是字符串");
      }
      if ("boundary" in c && typeof c.boundary !== "string") {
        why.push("candidate.boundary 必须是字符串");
      }
      if ("reopenIf" in c && typeof c.reopenIf !== "string") {
        why.push("candidate.reopenIf 必须是字符串");
      }

      if (why.length === 0) {
        const statement = c.statement as string;
        const basis = c.basis as string;

        // basis 必须非空（当 candidate 存在时）
        if (!basis.trim()) {
          why.push("candidate.basis 不能为空 —— 它是表态的前提");
        }

        // 正文里自称已确认的，整份拒
        if (SELF_CONFIRMED.test(statement)) {
          why.push("candidate.statement 包含已确认字样");
        }

        // reopenIf 写空话的，整份拒
        if ("reopenIf" in c) {
          const reopenIf = c.reopenIf as string;
          if (reopenIf && VAGUE_REOPEN.test(reopenIf)) {
            why.push("candidate.reopenIf 写了等于没写的空话");
          }
        }

        if (why.length === 0) {
          value.candidate = {
            statement,
            basis,
            ...(c.boundary !== undefined && { boundary: c.boundary as string }),
            ...(c.reopenIf !== undefined && { reopenIf: c.reopenIf as string }),
          };
        }
      }
    }
  }

  if (why.length > 0) return { ok: false, why };
  return { ok: true, value };
}

/**
 * 应用一份提议到当前状态。只改提议里有的栏，别的原样。
 */
export function applyProposal(cur: TalkPoint, p: PointProposal): TalkPoint {
  return {
    ...cur,
    ...(p.thesis !== undefined && { thesis: p.thesis }),
    ...(p.statements !== undefined && { statements: p.statements }),
    ...(p.openQuestions !== undefined && { openQuestions: p.openQuestions }),
    ...(p.candidate !== undefined && { candidate: p.candidate }),
  };
}

/**
 * 让步类型：让步、坚持、部分让步。
 */
export type MoveKind = "concede" | "hold" | "partial";

/**
 * 让步日志的一条。
 *
 * 这份日志是 Task 11 的 verifier 唯一的输入 —— 允许日志里写「因为他不同意所以我改了」，
 * 等于让轨迹检查失去物质基础。所以 `trigger` 的拒绝表是这一层的要害：**对方的不满、
 * 重复施压、身份权威一律不算触发物**。
 *
 * 拒绝表只在判断真的变了时才拦（`kind` 是 `concede`/`partial`，或 `before !== after`）。
 * `kind: "hold"` 那一条不拦：顶住压力时，`trigger` 该写的**正是那股压力**（「他连着压了
 * 三轮」），而这条日志的意义就是把「他压了、我没动」记下来。
 */
export type DeliberationEntry = {
  turn: number;
  /** 是什么让它变的：他的哪一条论证，或哪条证据（E 编号）。空串不许落库。 */
  trigger: string;
  before: string;
  after: string;
  kind: MoveKind;
  rationale: string;
};

/**
 * 让步类型给人读的三个词。**今天屏幕上还没有这一栏** —— 让步日志本身是真落库的，
 * 但没有任何一处在渲染它，所以这三个词现在只在日志里用得上。
 */
export const MOVE_LABEL: Record<MoveKind, string> = {
  concede: "让步",
  hold: "坚持",
  partial: "部分让步",
};

/**
 * 不算触发物的写法：对方的不满、重复施压、身份权威。
 *
 * **Task 11 的 `findDesync` 复用这一条。** 这张表是轨迹检查的物质基础：判断变了但指不出
 * 一个可以去核的触发物，正是压力性让步的形状。
 *
 * 这是一个**针对这个模型常见措辞的廉价前置过滤器**，不是语义判断器 —— 它拦不满、施压、
 * 权威这几类短语，但不能保证漏网的就是可核查的论证。Task 11 会交叉验证日志的时序与
 * 引用，人会读板，所以不完备的过滤器配诚实的注释是可接受的。
 */
export const NOT_A_TRIGGER = /(不同意|不接受|不认可|又问了|再问|连着压|反复(追)?问|(是一号位|一号位说)|要求重新考虑)/;

/**
 * 这一句能不能算「一条可指认的论证」。
 *
 * **Task 11 的 `findDesync` 复用这一个判断。** 空串和拒绝表上的写法都不算。
 */
export function isTrigger(s: string): boolean {
  if (!s.trim()) return false;
  return !NOT_A_TRIGGER.test(s);
}

/**
 * 校验一条让步日志。
 *
 * `trigger` 的拒绝表只在判断真的变了时才拦（`kind` 是 `concede`/`partial`，或
 * `before !== after`）。顶住压力那一条（`kind: "hold"` 且 `before === after`）不拦：
 * 压力本身就是 `trigger` 该写的东西。空串是唯一一条不分 `kind` 的硬要求。
 */
export function checkEntry(e: unknown): { ok: true; value: DeliberationEntry } | { ok: false; why: string[] } {
  const why: string[] = [];

  if (typeof e !== "object" || e === null) {
    why.push("日志条目必须是对象");
    return { ok: false, why };
  }

  const obj = e as Record<string, unknown>;

  // turn: 正整数
  if (typeof obj.turn !== "number" || !Number.isInteger(obj.turn) || obj.turn < 1) {
    why.push("turn 必须是正整数");
  }

  // trigger: 非空字符串（trim 后非空）
  if (typeof obj.trigger !== "string") {
    why.push("trigger 必须是字符串");
  } else if (!obj.trigger.trim()) {
    why.push("trigger 不能为空 —— 任何一条都得说清是什么促成的");
  }

  // before, after: 字符串
  if (typeof obj.before !== "string") {
    why.push("before 必须是字符串");
  }
  if (typeof obj.after !== "string") {
    why.push("after 必须是字符串");
  }

  // kind: 必须是三种之一
  if (typeof obj.kind !== "string" || !["concede", "hold", "partial"].includes(obj.kind)) {
    why.push("kind 必须是 concede、hold 或 partial");
  }

  // rationale: 字符串
  if (typeof obj.rationale !== "string") {
    why.push("rationale 必须是字符串");
  }

  if (why.length > 0) return { ok: false, why };

  const turn = obj.turn as number;
  const trigger = obj.trigger as string;
  const before = obj.before as string;
  const after = obj.after as string;
  const kind = obj.kind as MoveKind;
  const rationale = obj.rationale as string;

  // 这条记录声称判断变了：before !== after 或 kind 是 concede/partial
  const entryAssertsChange = before !== after || kind === "concede" || kind === "partial";

  // 拒绝表检查：只在判断真的变了时才拦
  if (entryAssertsChange && !isTrigger(trigger)) {
    why.push("判断变了但指不出触发物 —— 这正是压力性让步的形状");
  }

  // 一致性：concede/partial 要求 before !== after
  if ((kind === "concede" || kind === "partial") && before === after) {
    why.push(`kind 是 ${kind} 但 before 和 after 相同 —— 没变怎么叫让步`);
  }

  if (why.length > 0) return { ok: false, why };
  return { ok: true, value: { turn, trigger, before, after, kind, rationale } };
}
