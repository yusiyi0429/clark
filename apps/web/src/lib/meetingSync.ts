import type { Card } from "@/lib/api/client";

/**
 * 同一场会的「会后决定」有两个处理面：首页左栏的战略变更卡、会议页的「会议共识」。
 * 任何一处的确认 / 忽略 / 撤回在服务端提交成功后，都在这里广播最新的会议 Card，另一处收到后合并（版本不比手里旧才换）。
 * source 标明是谁发的：左栏的广播会议页要收，会议页的广播左栏要收，自己发的自己不收。
 * 注意：左栏自己不在提交当下换 Card（撤回窗口里那一行得留在卡上），所以只有会议页等「别处」立刻收左栏的广播。
 */
export const MEETING_CARD_COMMITTED = "meeting-card-committed";
export type MeetingCardSource = "rail" | "page";
export type MeetingCardCommitted = { card: Card; source: MeetingCardSource };

type Bus = Pick<EventTarget, "addEventListener" | "removeEventListener" | "dispatchEvent">;
const globalBus = (): Bus | null => (typeof window === "undefined" ? null : window);

export function announceMeetingCard(card: Card, source: MeetingCardSource, bus: Bus | null = globalBus()): void {
  if (card.kind !== "meeting") return;
  bus?.dispatchEvent(new CustomEvent<MeetingCardCommitted>(MEETING_CARD_COMMITTED, { detail: { card, source } }));
}

/** 收别处（source 不是 self）广播的会议 Card；返回取消订阅。 */
export function listenMeetingCard(self: MeetingCardSource, handler: (card: Card) => void, bus: Bus | null = globalBus()): () => void {
  if (!bus) return () => undefined;
  const listener = (event: Event) => {
    const detail = (event as CustomEvent<MeetingCardCommitted | undefined>).detail;
    if (detail && detail.source !== self) handler(detail.card);
  };
  bus.addEventListener(MEETING_CARD_COMMITTED, listener);
  return () => bus.removeEventListener(MEETING_CARD_COMMITTED, listener);
}

/** 用更新（或同版本）的 Card 换掉列表里同一个对象；旧版本不覆盖新版本，没有这个对象时原样返回。 */
export function mergeNewerCard(cards: Card[], updated: Card): Card[] {
  return cards.some((card) => card.id === updated.id && card.version <= updated.version)
    ? cards.map((card) => (card.id === updated.id ? updated : card))
    : cards;
}
