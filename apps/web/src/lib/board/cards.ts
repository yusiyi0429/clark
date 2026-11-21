/**
 * 卡（执行事项）在看板上的位置和标记（V2 设计第 3 节，契约 taskCardView.ts）。
 * 列和标记由云端算好放在 card.stage / card.wait；老事项（home-plan 里还没带 card 的）按 status 推一个：
 * 没开始 → 待开始；进行中且外部工具提交了验收 → 验收中；进行中 → 进行中；做完 → 已完成。
 * 标记不成列，带标记的排在格子最上面。这张卡正在这台电脑的本机程序上跑时，执行过程以本机为准（第 2 节「怎么看」）。
 */
import type { TCardStage, TCardWait, TTaskCard, TTaskView } from "@warmap/contracts";
import type { TLocalSessionSummary } from "@/lib/local/runner";
import { cardRole } from "@/lib/team/roles";

export type CardStage = TCardStage;
export type CardWait = TCardWait;
/** home-plan 的事项（之后会带 card，老事项没有）或看板接口的 CardTaskView（一定有 card）。 */
export type CardItem = TTaskView & { card?: TTaskCard | null };

export const STAGES: { id: CardStage; label: string }[] = [
  { id: "todo", label: "待开始" },
  { id: "doing", label: "进行中" },
  { id: "review", label: "验收中" },
  { id: "done", label: "已完成" },
];

export const WAIT_LABEL: Record<CardWait, string> = {
  approval: "等你批准",
  reply: "等你回复",
  paused: "已暂停",
  review_failed: "验收未过",
  blocked: "受阻",
  needs_person: "等你补",
};
/** 要你动手的排前面。 */
const WAIT_ORDER: CardWait[] = ["needs_person", "approval", "reply", "review_failed", "paused", "blocked"];
/** 等你补、等你批准、等你回复用强调色；已暂停、验收未过、受阻用提醒色。 */
export const waitTone = (wait: CardWait) => (wait === "approval" || wait === "reply" || wait === "needs_person" ? "wait" : "warn");
/** 前四种算「待处理」（Task 名字旁边的小数字）。 */
export const isPendingWait = (wait: CardWait | null | undefined) => !!wait && wait !== "blocked";

export function stageOf(item: CardItem): CardStage {
  if (item.card) return item.card.stage;
  if (item.status === "done") return "done";
  if (item.status === "not_started") return "todo";
  return item.awaitingAcceptance ? "review" : "doing";
}

/**
 * 本机会话的摘要能看出的标记：有权限请求挂着 → 等你批准；一轮停了在等话 → 等你回复；进程退了 → 已暂停。
 * 会话停了、退了还挂着的批准是失效的（第 54 条），不算等你批准。
 */
export function localWaitOf(session: Pick<TLocalSessionSummary, "status" | "pendingPermissions"> | null): CardWait | null {
  if (!session) return null;
  if (session.status === "waiting_permission" || (session.pendingPermissions > 0 && (session.status === "running" || session.status === "starting"))) return "approval";
  if (session.status === "idle") return "reply";
  if (session.status === "exited" || session.status === "failed") return "paused";
  return null;
}

export function waitOf(item: CardItem, session: TLocalSessionSummary | null = null): CardWait | null {
  const cloud = item.card ? item.card.wait : item.blocker ? "blocked" : null;
  const stage = stageOf(item);
  if (stage === "done" || stage === "review") return null;
  // 验收未过、受阻只有云端知道；其余执行过程以本机为准（本机的更新）。
  if (session && cloud !== "review_failed" && cloud !== "blocked") return localWaitOf(session);
  return cloud;
}

export type BoardCard = { item: CardItem; stage: CardStage; wait: CardWait | null; session: TLocalSessionSummary | null };

export function boardCards(items: CardItem[], sessions: TLocalSessionSummary[] = []): BoardCard[] {
  return items.map((item) => {
    const session = sessions.find((entry) => entry.subject.kind === "card" && entry.subject.cardId === item.id) ?? null;
    // 本机已经开工、云端还没收到第一条同步：先放进「进行中」。
    const cloudStage = stageOf(item);
    const stage = cloudStage === "todo" && session ? "doing" : cloudStage;
    return { item, stage, wait: waitOf(item, session), session };
  });
}

/** 一格里的顺序：带标记的在最上面（按要你动手的先后），其余照原顺序。 */
export function sortCell(cards: BoardCard[]): BoardCard[] {
  const rank = (card: BoardCard) => (card.wait ? WAIT_ORDER.indexOf(card.wait) : WAIT_ORDER.length);
  return cards.map((card, index) => ({ card, index })).sort((a, b) => rank(a.card) - rank(b.card) || a.index - b.index).map(({ card }) => card);
}

export const byStage = (cards: BoardCard[], stage: CardStage) => sortCell(cards.filter((card) => card.stage === stage));
export const pendingCount = (cards: BoardCard[]) => cards.filter((card) => isPendingWait(card.wait)).length;

/** 对第几条标准：①②③…，超过 20 写数字。 */
export const circled = (n: number) => (n >= 1 && n <= 20 ? String.fromCodePoint(0x245f + n) : String(n));

/**
 * 假本机程序（开发走查）时，云端还没给 card 的老事项也当成 Claude Code 的卡，好在后端没好之前把开工走一遍。
 * 只由 LocalRunnerProvider 在用假程序时打开。
 */
let mockAgents = false;
export const setMockAgents = (on: boolean) => { mockAgents = on; };

/** 配了岗位或 claude_code 的由本机的 Claude Code 按岗位干；self 或没设（老事项）是本人自己做。 */
export const isAgentCard = (item: CardItem) => item.card?.executor === "claude_code" || !!cardRole(item) || (mockAgents && !item.card);

/** 已完成的卡：「已纳入 v2」或「v2 准备中」。 */
export function deliverableLabel(item: CardItem): string | null {
  const inclusion = item.card?.deliverable;
  if (!inclusion) return null;
  return inclusion.state === "included" ? `已纳入 v${inclusion.versionNumber}` : `v${inclusion.versionNumber} 准备中`;
}

/**
 * 能不能在这里指挥本机（开始、插话、停下、批权限）：本机程序连着、配好对，而且不是手机宽度（第 13 节：手机上不指挥本机）。
 * 这张卡在本机上的会话还要在这台电脑上（hasSession）。
 */
export const canCommand = ({ ready, handheld, hasSession = true }: { ready: boolean; handheld: boolean; hasSession?: boolean }) => ready && !handheld && hasSession;
/** 「开始」只给 Claude Code 干的卡。 */
export const canStartCard = ({ ready, handheld, item }: { ready: boolean; handheld: boolean; item: CardItem }) => canCommand({ ready, handheld }) && isAgentCard(item);

/** 卡在别的电脑上跑：云端摘要里的设备不是这台。 */
export function elsewhere(item: CardItem, deviceId: string | null): string | null {
  const run = item.card?.run;
  if (!run || run.endedAt) return null;
  return deviceId && run.deviceId === deviceId ? null : run.deviceName;
}
