/**
 * 舞台的状态机。
 *
 * 一个 reducer，一份状态。所有事件 —— 模型调工具、秘书按热键、他自己翻页 —— 都从这
 * 一个口子进，所以「屏幕上现在是什么」永远只有一个说法。这一条是口述模式能不出洋相的
 * 结构性前提：三个来源如果各自 setState，会上就会出现两张卡同时想占屏幕的那一帧。
 *
 * 舞台一次只画一个主体（`current()`），但保留完整历史 —— 他会在会上说「刚才那张再给我
 * 看看」，那时候要能 ← 回去，而且回去之后 Agent 推新卡不该把他卡在过去。
 */

import type {
  Agenda,
  DecisionDraft,
  ExplorationCard,
  StageAction,
  VoiceState,
} from "./events";

/** 舞台上那一个主体。只记指针，不记内容 —— 内容在对象库里。 */
export type StageFrame =
  | { kind: "agenda" }
  | { kind: "card"; itemId: string }
  | { kind: "evidence"; evidenceId: string }
  | { kind: "doc"; docId: string; anchor?: string }
  | { kind: "map"; view?: string }
  | { kind: "exploration"; id: string }
  | { kind: "decision"; id: string }
  | { kind: "summary" };

export interface StageState {
  /** 翻得回去的历史。← / → 在这上面走。 */
  history: StageFrame[];
  /** 现在停在第几帧。`-1` = 还什么都没呈报（开屏那一瞬间）。 */
  cursor: number;
  agenda?: Agenda;
  /** 已呈报过哪几件事，按顺序。顶上那行进度的分子。 */
  presented: string[];
  explorations: ExplorationCard[];
  decisions: DecisionDraft[];
  voice: VoiceState;
  /** 最新那句话。`seq` 每换一句 +1，用它给淡出的定时器当 key。 */
  caption: { text: string; partial: boolean; seq: number } | null;
  /** 刚听到他说的那句话。为什么和 `caption` 分开两个格子，见 `events.ts` 里 `HEARD`。 */
  heard: { text: string; final: boolean } | null;
}

export const initialStage: StageState = {
  history: [],
  cursor: -1,
  presented: [],
  explorations: [],
  decisions: [],
  voice: "presenting",
  caption: null,
  heard: null,
};

/** 现在该画哪一个。`null` = 还没开始。 */
export const current = (s: StageState): StageFrame | null => s.history[s.cursor] ?? null;

export function stageReducer(state: StageState, action: StageAction): StageState {
  switch (action.type) {
    case "AGENDA_READY":
      return { ...state, agenda: action.agenda };

    case "SHOW_AGENDA":
      return push(state, { kind: "agenda" });

    case "SHOW_CARD": {
      const next = push(state, { kind: "card", itemId: action.itemId });
      // 呈报过的条目要去重：他让 Agent 把第二件事再讲一遍，进度不该变成 4/3。
      return next.presented.includes(action.itemId)
        ? next
        : { ...next, presented: [...next.presented, action.itemId] };
    }

    case "SHOW_EVIDENCE":
      return push(state, { kind: "evidence", evidenceId: action.evidenceId });

    case "OPEN_DOC":
      return push(state, {
        kind: "doc",
        docId: action.docId,
        ...(action.anchor ? { anchor: action.anchor } : {}),
      });

    case "SHOW_MAP":
      return push(state, { kind: "map", ...(action.view ? { view: action.view } : {}) });

    case "SHOW_SUMMARY":
      return push(state, { kind: "summary" });

    case "CREATE_EXPLORATION_CARD": {
      const card = action.card;
      const at = state.explorations.findIndex((c) => c.id === card.id);
      const explorations =
        at < 0
          ? [...state.explorations, card]
          : state.explorations.map((c, i) => (i === at ? card : c));
      return push({ ...state, explorations }, { kind: "exploration", id: card.id });
    }

    case "SHOW_DECISION_DRAFT": {
      const draft = action.draft;
      const at = state.decisions.findIndex((d) => d.id === draft.id);
      const decisions =
        at < 0 ? [...state.decisions, draft] : state.decisions.map((d, i) => (i === at ? draft : d));
      return push({ ...state, decisions }, { kind: "decision", id: draft.id });
    }

    /*
     * 翻状态不换屏。
     *
     * 「已立项」是当着客户翻的那一下 —— 卡必须留在原地，只有那个角标动。如果这里 push
     * 一帧新的，屏幕会重画一次，看起来像是换了一张卡，那一下就白翻了。
     */
    case "UPDATE_CARD_STATUS": {
      const s = action.status;
      if (s === "proposed" || s === "committed") {
        return {
          ...state,
          explorations: state.explorations.map((c) =>
            c.id === action.id ? { ...c, status: s } : c,
          ),
        };
      }
      return {
        ...state,
        decisions: state.decisions.map((d) => (d.id === action.id ? { ...d, status: s } : d)),
      };
    }

    case "SET_STATE":
      return state.voice === action.state ? state : { ...state, voice: action.state };

    case "STAGE_BACK":
      return state.cursor > 0 ? { ...state, cursor: state.cursor - 1 } : state;

    case "STAGE_FORWARD":
      return state.cursor < state.history.length - 1 ? { ...state, cursor: state.cursor + 1 } : state;

    case "CAPTION": {
      const text = action.text.trim();
      if (!text) return state;
      const partial = action.partial ?? false;
      const prev = state.caption;
      /*
       * 同一句话在流里会一个字一个字长出来。每一次都换 `seq`，那条 8 秒淡出的定时器就
       * 会被不断重置 —— 这是对的：他还在说的时候字幕不该淡。说完了（`partial` 转 false）
       * 才开始数那 8 秒。
       */
      const seq = prev && prev.text === text && prev.partial === partial ? prev.seq : (prev?.seq ?? 0) + 1;
      return { ...state, caption: { text, partial, seq } };
    }

    case "CAPTION_CLEAR":
      return state.caption ? { ...state, caption: null } : state;

    case "HEARD": {
      const text = action.text.trim();
      if (!text) return state;
      const final = action.final ?? false;
      const prev = state.heard;
      // 一个字一个字长出来的过程里，同一段话会报很多次。没变就别换对象，省一次重画。
      if (prev && prev.text === text && prev.final === final) return state;
      return { ...state, heard: { text, final } };
    }

    case "HEARD_CLEAR":
      return state.heard ? { ...state, heard: null } : state;

    default:
      return state;
  }
}

/**
 * 往历史里推一帧。
 *
 * 两条规矩：
 *
 * - 推的和现在这一帧**完全一样**就什么都不做。模型经常为同一件事连调两次
 *   `show_evidence`（讲第二句时又想起要给出处），不该在历史里留两格 —— 那会让 ← 按一下
 *   看起来没反应。
 * - 他翻回过去之后再推新的，就把前面那截丢掉。这是浏览器历史的规矩，也是唯一不会
 *   让他迷路的规矩：会上没人能在两条分叉的历史里找路。
 */
function push(state: StageState, frame: StageFrame): StageState {
  const now = current(state);
  if (now && same(now, frame)) return state;
  const history = [...state.history.slice(0, state.cursor + 1), frame];
  return { ...state, history, cursor: history.length - 1 };
}

const same = (a: StageFrame, b: StageFrame): boolean => {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "card":
      return b.kind === "card" && a.itemId === b.itemId;
    case "evidence":
      return b.kind === "evidence" && a.evidenceId === b.evidenceId;
    case "doc":
      return b.kind === "doc" && a.docId === b.docId && a.anchor === b.anchor;
    case "map":
      return b.kind === "map" && a.view === b.view;
    case "exploration":
      return b.kind === "exploration" && a.id === b.id;
    case "decision":
      return b.kind === "decision" && a.id === b.id;
    default:
      return true;
  }
};

// ---------------------------------------------------------------------------
// 顶上那一行
// ---------------------------------------------------------------------------

/**
 * 「今日呈报 2/3」。
 *
 * 两种情况不写：议程还没装好，和还没讲第一件。前者不写 0/0；后者不写 0/3 —— 开场那一帧
 * 议程卡自己就说了「今天为您准备了 3 件事」，顶上再挂一个 0 出去，是客户看到这个产品的
 * 第一个数字。讲了第一件之后这一行才有意义。
 */
export function progressLabel(s: StageState): string | null {
  const total = s.agenda?.items.length ?? 0;
  if (!total || !s.presented.length) return null;
  return `今日呈报 ${Math.min(s.presented.length, total)}/${total}`;
}

/** 收尾那张卡上的三个数。 */
export function summaryCounts(s: StageState) {
  return {
    presented: s.presented.length,
    committed: s.explorations.filter((c) => c.status === "committed").length,
    decided: s.decisions.filter((d) => d.status === "confirmed").length,
  };
}

export type { Agenda, DecisionDraft, ExplorationCard, VoiceState };
