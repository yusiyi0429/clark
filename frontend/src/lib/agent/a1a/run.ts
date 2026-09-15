/**
 * A1a 信号 → 议题，用 GraphKnowledge M7 S01 上下文。
 * 对齐自 `tkos-lab/src/tkos_lab/agents/a1a_signal.py`。
 *
 * 一条信号进来有**三条**出路，第一步先定往哪条走：
 *
 * | 路由 | 含义 | 产出 |
 * |---|---|---|
 * | `update_issue` | 已有一条议题在说同一件事，但说法被这条信号改变了 | 一条**取代**它的新议题 |
 * | `new_issue`    | 公司还没有承接它的议题 | 一条新的潜在议题 |
 * | `ignore`       | 看着量很大、甚至是 CEO 给的，但分析完是噪音 | 不改也不新增，只留判断 |
 *
 * 选路和写正文分成两次模型调用，是为了让「路由选错」和「正文写得不好」在评分
 * 时分得开。合成一次的话，模型走错了路只会看到一份怪产出，看不出该改哪一段。
 *
 * `ignore` 这条路在选路那一步就结束，不再调第二次模型：这次运行的产出**就是**
 * 那个判断。空产出在这里是正确结果（`status:"ignored"`），不是没跑完。
 *
 * 图谱里找不到 `CARD-*` 锚点时**不停**，转纯外部：那条路上看不到任何既有议题，
 * 「取代」根本不成立，所以只剩两条分支，由 `a1a.issue.external` 一次判完，
 * 并且**不做外部检索** —— 考的就是从这段原文本身能推出什么。
 */
import {
  a1aExternal,
  a1aIgnore,
  a1aIsIgnore,
  a1aNew,
  a1aTriage,
  a1aUpdate,
  type Check,
} from "@/lib/agent/checks";
import { Harness } from "@/lib/agent/harness";
import type { AgentRunRecord } from "@/lib/data/types";

export const DECISIONS = ["update_issue", "new_issue", "ignore"] as const;
export type Decision = (typeof DECISIONS)[number];

/*
 * 模型偶尔会把路由值写成中文或近义词。能确定对应关系的就归一化，但**不猜**：
 * 归一化过的会在自检里标出来（下游按这三个值分支，正文里就该定死），对不上的
 * 直接失败 —— 随便挑一条会产出一份格式完整、却走错了路的议题，而且毫无迹象。
 */
const ALIASES: Record<string, Decision> = {
  update: "update_issue",
  modify: "update_issue",
  replace: "update_issue",
  update_existing: "update_issue",
  修改: "update_issue",
  取代: "update_issue",
  更新: "update_issue",
  修改已存的issue: "update_issue",
  new: "new_issue",
  create: "new_issue",
  create_issue: "new_issue",
  potential_issue: "new_issue",
  新增: "new_issue",
  新建: "new_issue",
  创建: "new_issue",
  创建新议题: "new_issue",
  noise: "ignore",
  skip: "ignore",
  noop: "ignore",
  none: "ignore",
  no_action: "ignore",
  忽略: "ignore",
  噪音: "ignore",
};

export function normalizeDecision(out: Record<string, unknown>): {
  decision: Decision | null;
  raw: string;
} {
  const v = out.decision;
  const raw = typeof v === "string" ? v.trim() : v === undefined || v === null ? "" : String(v);
  if ((DECISIONS as readonly string[]).includes(raw)) return { decision: raw as Decision, raw };
  const key = raw.toLowerCase().replace(/ /g, "").replace(/-/g, "_");
  return { decision: ALIASES[key] ?? null, raw };
}

export type A1aInput = {
  cardId: string;
  /** 锚点检索用的那一句。**不含任何指令样板。** */
  headline: string;
  source: string;
  /** 信号正文（`Card.what` 拼出来的）。没有就只用 headline。 */
  body?: string;
};

const signalBlock = (input: A1aInput): string =>
  `信号原文：\n${input.body?.trim() || input.headline}\n\n来源：${input.source || "（未提供）"}`;

function routedBlock(input: A1aInput, tri: Record<string, unknown>): string {
  const s = (k: string) => {
    const v = tri[k];
    return typeof v === "string" && v.trim() ? v.trim() : "（未给出）";
  };
  const bits = [
    signalBlock(input),
    "",
    "【上一步的定性结论】",
    `路由：${s("decision")}`,
    `这条信号在说的事：${s("signal_reading")}`,
    `理由：${s("rationale")}`,
  ];
  const code = typeof tri.target_issue_code === "string" ? tri.target_issue_code.trim() : "";
  if (code) bits.push(`要被取代的既有议题：${code}`);
  return bits.join("\n");
}

/**
 * 跑一次 A1a。返回一条 Run 记录 —— 写回由 `apply.ts` 决定，这里只判断和产出。
 *
 * `GraphKnowledgeUnavailable` **原样抛出**：图服务挂了要是被当成「图谱里没有
 * 这条信号」，每一次运行都会悄悄降级成纯外部，还照样产出一份格式漂亮的议题。
 */
export async function runA1a(
  input: A1aInput,
  init: { depth?: string; cognitive?: Record<string, string> } = {}
): Promise<AgentRunRecord> {
  const h = new Harness({ agent: "A1a", slot: "pro", depth: init.depth, cognitive: init.cognitive });
  const inp = signalBlock(input);

  await h.openContext("S01", input.headline);

  // ---- 纯外部：三条路只剩两条，一次调用判完 ----
  if (h.externalOnly) {
    h.note("纯外部 · 跳过选路", {
      /*
       * 两个源两句话。走到这一档的**判据是同一个**（这一轮没有可引的 member，
       * 于是 `update_issue` 的那两条自检必然判「是编的」），但成因完全不同：
       * 旧源是「这条信号在图里没有锚点」，新源是**这个源根本不产生编号**。
       * 合成一句「图谱里没有锚点」的话，换源之后每一条信号的运行记录上都写着一件
       * 没有发生过的事 —— 而那条记录正是事后查「为什么这半年一条取代都没有」时看的。
       */
      why: h.narrative
        ? "本体的工作记忆（议题+判断+共识）还没建起来，这一轮只有公司层内容：看不到任何既有议题，无从取代"
        : "图谱里没有锚点，看不到任何既有议题，无从取代",
    });
    const out = await h.callPrompt("a1a.issue.external", { input: inp, context: h.contextBlock });
    const ignored = a1aIsIgnore(out);
    // 改写之前把原值取下来：这条路只有两个合法取值，改写必须留痕，否则模型违反
    // 硬约束（比如给了 update_issue）时，产出照样是一条格式完整的 new_issue。
    // 不是字符串也照原样带出来（`JSON.stringify` 一下）：塌成空串的话自检会报「没给
    // decision」，而下一行就把原值盖掉了 —— 「给了个数字」和「一个字都没给」这两件事
    // 从此没人能分。
    const raw =
      out.decision == null
        ? ""
        : typeof out.decision === "string"
          ? out.decision.trim()
          : JSON.stringify(out.decision);
    out.decision = ignored ? "ignore" : "new_issue";
    return h.finish({
      status: ignored ? "ignored" : "ok",
      input: inp,
      output: out,
      route: ignored ? "ignore" : "new_issue",
      checks: a1aExternal(out, raw),
    });
  }

  // ---- 第一次调用：选路 ----
  const tri = await h.callPrompt("a1a.triage", { input: inp, context: h.contextBlock });
  const { decision, raw } = normalizeDecision(tri);
  if (decision === null) {
    // 路由是后面每一步的开关，看不懂它选了什么就不能往下走。
    return h.finish({
      status: "failed",
      input: inp,
      output: tri,
      error: `路由取值不合法：收到 ${raw ? `「${raw}」` : "（空）"}；只能是 ${DECISIONS.join(" / ")}`,
    });
  }
  tri.decision = decision;
  const triChecks: Check[] = a1aTriage(tri, h.memberIds, raw);

  if (decision === "ignore") {
    // 到此为止，不调第二次模型。这一步的输出就是这次运行的产出。
    return h.finish({
      status: "ignored",
      input: inp,
      output: tri,
      route: "ignore",
      checks: [...triChecks, ...a1aIgnore(tri)],
    });
  }

  // ---- 第二次调用：写正文 ----
  const routed = routedBlock(input, tri);
  let out: Record<string, unknown>;
  let checks: Check[];
  if (decision === "update_issue") {
    out = await h.callPrompt("a1a.issue.update", { input: routed, context: h.contextBlock });
    if (out.decision === undefined) out.decision = "update_issue";
    const code = typeof out.target_issue_code === "string" ? out.target_issue_code.trim() : "";
    // 选路那一步已经指名了要取代哪一条；第二次调用漏了就补回去，不要让它变成空。
    if (!code) out.target_issue_code = tri.target_issue_code ?? "";
    checks = a1aUpdate(out, h.memberIds);
  } else {
    out = await h.callPrompt("a1a.issue.new", { input: routed, context: h.contextBlock });
    if (out.decision === undefined) out.decision = "new_issue";
    checks = a1aNew(out, h.memberIds);
  }
  // 选路的结论跟着产出一起交出去：评这份议题写得对不对，前提是先看到它为什么
  // 走了这条路。
  out.triage = tri;
  return h.finish({
    status: "ok",
    input: inp,
    output: out,
    route: decision,
    checks: [...triChecks, ...checks],
  });
}
