/**
 * 舞台事件 —— 口述模式下「屏幕上现在该是什么」的唯一说法。
 *
 * 三个地方会产生它，但只有一种形状：
 *
 *   1. Agent 调工具（`show_evidence`、`open_document`…）—— 主线；
 *   2. 秘书控制台按热键（下一件、推第 3 张证据）—— 兜底；
 *   3. 屏幕自己（他按 ← 翻回上一张）—— 本地。
 *
 * 前两个从服务端下来，走 `/api/chat` 那一条已经存在的流（升级成 SSE 之后多一类命名
 * 事件），不另建通道。第三个只在浏览器里发生，不上服务端 —— 翻页不该产生一次网络往返。
 *
 * 关于载荷的一条硬规矩：**已经存在的对象只传编号，不传副本。**
 *
 * 证据卡传 `evidenceId`，文档传 `docId`，议程条目传 `itemId` —— 屏幕拿编号回去查
 * 同一批对象。这是「双模式同源」在协议层唯一能落实的地方：如果这里传的是模型现编的
 * 一段文字，口述模式就有了自己的一套数据，手动模式看到的和投影上看到的会不一样，
 * 而那种不一样正好会在客户面前出现。
 *
 * 例外只有两个：探索卡和决策草案。它们是模型在会上现写的，本来就没有对象可指 ——
 * 所以它们的形状故意贴着手动模式里已有的两个类型（`MessageBlock` 的 `question` 那一支、
 * `Closure` 七要素），将来落库不用改形状。
 */

import type { Closure } from "@/lib/data/types";

/** 语音条左边那盏灯。三态，不拟人。 */
export type VoiceState = "listening" | "retrieving" | "presenting";

export const VOICE_LABEL: Record<VoiceState, string> = {
  listening: "聆听中",
  retrieving: "取证中",
  presenting: "呈报中",
};

/**
 * 一张探索卡 —— 「这个现在答不了」之后落在屏幕上的那张。
 *
 * 字段跟 `MessageBlock` 里 `{type:"question"}` 那一支对齐（`text`/`suggestedDri`/
 * `deadline`），多出来的是 id 和状态：会上要当场把它从「待确认」翻成「已立项」。
 */
export interface ExplorationCard {
  id: string;
  /** 问题本身。一句话，就是答不了的那件事。 */
  text: string;
  /** 建议责任人。姓名照原样写。 */
  suggestedDri: string;
  /** 建议期限。`8/14`、`下周三` 这种口语日期也收。 */
  deadline: string;
  /** 关联节点：判断/议题/域的编号，照原样写，屏幕会当编号渲染。 */
  relatedIds: string[];
  /** 待确认 → 已立项 */
  status: "proposed" | "committed";
}

export const EXPLORATION_LABEL: Record<ExplorationCard["status"], string> = {
  proposed: "待确认",
  committed: "已立项",
};

/**
 * 决策草案 —— 七要素，字段名和 `Closure` 完全一样。
 *
 * 一个字都不许改名：会上确认下来的这张卡，将来是要原样写回成 Closure 的。
 */
export interface DecisionDraft extends Closure {
  id: string;
  /** 这是在定哪件事。一句话。 */
  title: string;
  /** 定完会动到哪条判断。编号照原样写，例如 `05-J1`。 */
  judgmentId?: string;
  /** 草案 → 已确认 */
  status: "draft" | "confirmed";
}

export const DECISION_LABEL: Record<DecisionDraft["status"], string> = {
  draft: "草案",
  confirmed: "已确认",
};

/** 从服务端下来的那些。 */
export type StageEvent =
  /** 开场：今天有几件事。 */
  | { type: "SHOW_AGENDA" }
  /** 呈报第 N 件事。 */
  | { type: "SHOW_CARD"; itemId: string }
  /** 打出一张证据卡。讲到任何文档或数字时必须先有这一下。 */
  | { type: "SHOW_EVIDENCE"; evidenceId: string }
  /** 打开全文，滚到那一段并高亮。 */
  | { type: "OPEN_DOC"; docId: string; anchor?: string }
  /** 目标与产出那棵树。 */
  | { type: "SHOW_MAP"; view?: string }
  /** 答不了的那件事，落成一张卡。 */
  | { type: "CREATE_EXPLORATION_CARD"; card: ExplorationCard }
  /** 当场把卡的状态翻过去。 */
  | { type: "UPDATE_CARD_STATUS"; id: string; status: ExplorationCard["status"] | DecisionDraft["status"] }
  /** 七要素草案，念一遍等他确认。 */
  | { type: "SHOW_DECISION_DRAFT"; draft: DecisionDraft }
  /** 收尾：今天办了什么。 */
  | { type: "SHOW_SUMMARY" }
  /** 那盏灯。 */
  | { type: "SET_STATE"; state: VoiceState };

/** 只在浏览器里发生的那些。它们不上服务端。 */
export type StageLocalAction =
  /** ← / → 翻卡片历史。 */
  | { type: "STAGE_BACK" }
  | { type: "STAGE_FORWARD" }
  /** 字幕：最新那句话。 */
  | { type: "CAPTION"; text: string; partial?: boolean }
  | { type: "CAPTION_CLEAR" }
  /**
   * 听到他说的话。`final` 之前会带着同一段话报很多次。
   *
   * 它和 `CAPTION` 分开两个格子，不合成一个。理由：字幕那一行是**参谋的嘴**（「字幕跟着嘴
   * 走」那条规矩就写在语音条里），而识别出来的是**他的话**。合成一个格子的话，一段识别得
   * 半通不通的 partial 会把参谋正在念的那句字幕当场覆盖掉 —— 而识别本来就是这条链子上最
   * 不可靠的一环，不能让它有权力擦掉别人的东西。
   */
  | { type: "HEARD"; text: string; final?: boolean }
  | { type: "HEARD_CLEAR" }
  /** 议程装好了。 */
  | { type: "AGENDA_READY"; agenda: Agenda };

export type StageAction = StageEvent | StageLocalAction;

// ---------------------------------------------------------------------------
// demo 议程
// ---------------------------------------------------------------------------

/**
 * `demo/agenda.json` 的形状。
 *
 * 它只装两样东西：**今天讲哪几件事、按什么顺序**，加上每件事的口播文稿。四个部分的
 * 内容和证据引文本身是从对象库里摘出来照录的 —— `docId` 指的是 `seed-desk.ts` 里真的
 * 存在的那份文档，`quote` 必须在那份文档的正文里真的能找到，否则「打开全文」会滚到
 * 一个空处，而那正好是这个产品最不能出错的地方。
 */
export interface Agenda {
  sessionTitle: string;
  /** 开场那句话。预合成的音频按 `id` 命名，见 M2。 */
  opening: string;
  /** 收尾那句话。 */
  closing: string;
  items: AgendaItem[];
}

export interface AgendaItem {
  id: string;
  title: string;
  /** 这件事口播时说什么。≤30 秒，约 150 字。 */
  script: string;
  fourParts: {
    /** ① 发生了什么 */
    what: string;
    /** ② 为何现在重要 */
    whyNow: string;
    /** ③ 影响哪条战略 —— 编号照原样写 */
    impacts: string;
    /** ④ 建议动作 */
    suggestion: string;
  };
  evidence: AgendaEvidence[];
}

export interface AgendaEvidence {
  id: string;
  /** 指向 `docs` 里真实存在的一份文档。 */
  docId: string;
  /** 那份文档正文里真的有的一句话。 */
  quote: string;
  /** 滚到哪一段。留空就用 `quote` 去找。 */
  anchor?: string;
  /** 屏幕上「出处」那一行：《7 月研发人力表》2026-08-05。 */
  source: string;
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

/**
 * 把不知道从哪儿来的一坨东西读成一个舞台事件，读不成就返回 `null`。
 *
 * 三个入口都不可信：模型拼出来的 `arguments` 字符串、秘书控制台 POST 上来的 body、
 * 以及流里可能被截断的一帧。写法照着 `api/chat/route.ts` 里的 `readBody` —— 手写
 * 窄化，不引校验库。多一个依赖换十几行代码，不换。
 */
export function parseStageEvent(raw: unknown): StageEvent | null {
  if (!isRecord(raw)) return null;
  const type = raw.type;
  if (typeof type !== "string") return null;

  switch (type) {
    case "SHOW_AGENDA":
    case "SHOW_SUMMARY":
      return { type };
    case "SHOW_CARD": {
      const itemId = str(raw.itemId ?? raw.item_id);
      return itemId ? { type, itemId } : null;
    }
    case "SHOW_EVIDENCE": {
      const evidenceId = str(raw.evidenceId ?? raw.evidence_id);
      return evidenceId ? { type, evidenceId } : null;
    }
    case "OPEN_DOC": {
      const docId = str(raw.docId ?? raw.doc_id);
      if (!docId) return null;
      const anchor = str(raw.anchor);
      return anchor ? { type, docId, anchor } : { type, docId };
    }
    case "SHOW_MAP": {
      const view = str(raw.view);
      return view ? { type, view } : { type };
    }
    case "SET_STATE": {
      const state = str(raw.state);
      if (state !== "listening" && state !== "retrieving" && state !== "presenting") return null;
      return { type, state };
    }
    case "UPDATE_CARD_STATUS": {
      const id = str(raw.id);
      const status = str(raw.status);
      if (!id) return null;
      if (status === "proposed" || status === "committed" || status === "draft" || status === "confirmed") {
        return { type, id, status };
      }
      return null;
    }
    case "CREATE_EXPLORATION_CARD": {
      const card = parseExploration(raw.card ?? raw);
      return card ? { type, card } : null;
    }
    case "SHOW_DECISION_DRAFT": {
      const draft = parseDecision(raw.draft ?? raw);
      return draft ? { type, draft } : null;
    }
    default:
      return null;
  }
}

/**
 * 探索卡。
 *
 * 只有「问题」是必须的：会上模型经常先把问题说清楚，责任人和期限还在犹豫 —— 那时候
 * 卡该出来，空着的字段写「待定」，比整张卡不出来好。责任人是空的一张卡照样能提醒他
 * 「这件事没人管」。
 */
function parseExploration(raw: unknown): ExplorationCard | null {
  if (!isRecord(raw)) return null;
  const text = str(raw.text ?? raw.question);
  if (!text) return null;
  const status = str(raw.status);
  return {
    id: str(raw.id) ?? `RQ-${slug(text)}`,
    text,
    suggestedDri: str(raw.suggestedDri ?? raw.suggested_dri) ?? "待定",
    deadline: str(raw.deadline) ?? "待定",
    relatedIds: strList(raw.relatedIds ?? raw.related_ids),
    status: status === "committed" ? "committed" : "proposed",
  };
}

/**
 * 决策草案。
 *
 * 七要素**一个都不能空**。`Closure` 那边的规矩是「少一要素就不算 Closure」，草案这一层
 * 就得同样严：屏幕上打出一张缺了「什么条件下重开」的七要素卡，会当着客户的面证明
 * 这套机制是装的。缺了就补「（未填）」并照样打出来，让缺口自己显出来，而不是悄悄合上。
 */
function parseDecision(raw: unknown): DecisionDraft | null {
  if (!isRecord(raw)) return null;
  const title = str(raw.title);
  const choose = str(raw.choose);
  if (!title || !choose) return null;
  const status = str(raw.status);
  const judgmentId = str(raw.judgmentId ?? raw.judgment_id);
  return {
    id: str(raw.id) ?? `D-${slug(title)}`,
    title,
    choose,
    notChoose: str(raw.notChoose ?? raw.not_choose) ?? "（未填）",
    why: str(raw.why) ?? "（未填）",
    keyHypothesis: str(raw.keyHypothesis ?? raw.key_hypothesis) ?? "（未填）",
    riskAccepted: str(raw.riskAccepted ?? raw.risk_accepted) ?? "（未填）",
    commitment: str(raw.commitment) ?? "（未填）",
    reopenTrigger: str(raw.reopenTrigger ?? raw.reopen_trigger) ?? "（未填）",
    ...(judgmentId ? { judgmentId } : {}),
    status: status === "confirmed" ? "confirmed" : "draft",
  };
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
};

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(str).filter((s): s is string => Boolean(s)) : [];

/** 模型没给 id 时兜一个。够稳定就行 —— 同一句话两次调用要落在同一张卡上。 */
const slug = (text: string): string => {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return Math.abs(h).toString(36);
};
