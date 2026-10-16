"use client";

import { createContext, useCallback, useContext, useMemo, useRef, useState, type ReactNode } from "react";
import { Check, Paperclip, Quote, X } from "lucide-react";
import type { Card } from "@/lib/api/client";
import { payloadOf, type IssuePayload, type MeetingPayload, type MissionPayload, type MonthlyPlanPayload } from "@/cards/payloads";
import { HeroButton } from "@/components/HeroButton";
import { monthDayTime } from "@/lib/companyTime";
import type { Attachment } from "./useConversation";
import s from "@/styles/card-references.module.css";
import x from "@/styles/conversation-attachments.module.css";

/** 可作为对话引用的卡片（与 API 白名单一致：Signal 由其页面 scope 自动带入，不作显式引用）。 */
export const REFERENCEABLE = new Set(["issue", "meeting", "monthly-plan", "mission"]);
/** clark 的上限；API 允许 20，界面按更严的 16。 */
export const MAX_REFERENCES = 16;

const KIND_LABEL: Record<string, string> = { issue: "议题", meeting: "会议", "monthly-plan": "月度计划", mission: "Mission" };

type ReferenceApi = {
  items: Card[];
  toggle: (cards: Card[]) => void;
  /** 发送在服务端接收前失败时放回原引用（C-04）。 */
  add: (cards: Card[]) => void;
  remove: (id: string) => void;
  clear: () => void;
};

const ReferenceContext = createContext<ReferenceApi | null>(null);

/**
 * 引用篮（clark：引用只为全局对话准备草稿，不改变当前正在进行的对话）。
 * 只保存 Card，发送时变成 {cardId, version}；快照由后端生成。
 */
export function ReferenceProvider({ children, onLimit }: { children: ReactNode; onLimit: (text: string) => void }) {
  const [items, setItems] = useState<Card[]>([]);
  const current = useRef<Card[]>([]);
  const commit = (next: Card[]) => {
    current.current = next;
    setItems(next);
  };
  const toggle = useCallback(
    (cards: Card[]) => {
      const usable = cards.filter((card) => REFERENCEABLE.has(card.kind));
      if (!usable.length) return;
      const previous = current.current;
      const allSelected = usable.every((card) => previous.some((item) => item.id === card.id));
      const next = allSelected
        ? previous.filter((item) => !usable.some((card) => card.id === item.id))
        : [...previous, ...usable.filter((card) => !previous.some((item) => item.id === card.id))];
      if (next.length > MAX_REFERENCES) {
        onLimit(`最多同时批注 ${MAX_REFERENCES} 项。`);
        return;
      }
      commit(next);
    },
    [onLimit],
  );
  const api = useMemo<ReferenceApi>(
    () => ({
      items,
      toggle,
      add: (cards) => commit([...current.current, ...cards.filter((card) => !current.current.some((item) => item.id === card.id))].slice(0, MAX_REFERENCES)),
      remove: (id) => commit(current.current.filter((item) => item.id !== id)),
      clear: () => commit([]),
    }),
    [items, toggle],
  );
  return <ReferenceContext.Provider value={api}>{children}</ReferenceContext.Provider>;
}

export function useReferences(): ReferenceApi | null {
  return useContext(ReferenceContext);
}

/** 卡片旁的引用键（clark `ReferenceButton`）：打开键的兄弟节点，不嵌套按钮。一组卡片时整组引用 / 取消。 */
/** 引用按钮说的是引用了什么：一张卡写卡名；多张写「X 的 N 个议题」（或「N 项」）。 */
export function referenceTarget(title: string, cards: Card[]): string {
  if (cards.length <= 1) return title;
  const issues = cards.every((card) => card.kind === "issue");
  return `${title}${/[A-Za-z0-9]$/.test(title) ? " " : ""}的 ${cards.length} ${issues ? "个议题" : "项"}`;
}

export function ReferenceButton({ cards, title, corner = false }: { cards: Card[]; title: string; corner?: boolean }) {
  const context = useReferences();
  const usable = cards.filter((card) => REFERENCEABLE.has(card.kind));
  if (!context || !usable.length) return null;
  const selected = usable.every((card) => context.items.some((item) => item.id === card.id));
  // 整体卡、战场卡引用的是卡上列出的议题，不是这张卡本身：写清楚引用了几项（巡检 P2-25）。
  const what = referenceTarget(title, usable);
  return (
    <HeroButton
      variant="ghost"
      size="sm"
      isIconOnly
      type="button"
      className={`${s.quoteButton} ${corner ? s.corner : ""}`}
      data-reference-id={usable.map((card) => card.id).join(" ")}
      aria-label={`${selected ? "取消批注" : "批注到对话"}：${what}`}
      aria-pressed={selected}
      title={selected ? `已批注${what} · 点击移除` : `批注${what}到对话`}
      onPress={() => context.toggle(usable)}
    >
      {selected ? <Check size={14} /> : <Quote size={14} />}
    </HeroButton>
  );
}

/** 引用预览里给的一句正文：只取卡片上已有的字段，不编造。 */
function previewText(card: Card): string {
  if (card.kind === "issue") return payloadOf<IssuePayload>(card).research.doc?.summary ?? "预研尚未产出判断。";
  if (card.kind === "monthly-plan") return payloadOf<MonthlyPlanPayload>(card).companyOutcome || "公司结果尚未填写。";
  if (card.kind === "meeting") return `会议时间 ${monthDayTime(payloadOf<MeetingPayload>(card).scheduledAt)}`;
  if (card.kind === "mission") return payloadOf<MissionPayload>(card).outcome || "Mission 结果尚未填写。";
  return "";
}

/**
 * 输入条里的引用托盘（clark `ReferenceTray`）：chip 可预览、可移除，多于一张时可清空；附件同一排。
 * 待发送的文字引用（quotes，D4）也排在这一行最前面：引用都在输入框里，文字行上方。
 */
export function ReferenceTray({
  items,
  onRemove,
  onClear,
  attachments = [],
  onRemoveAttachment,
  quotes,
}: {
  items: Card[];
  onRemove: (id: string) => void;
  onClear: () => void;
  attachments?: Attachment[];
  onRemoveAttachment?: (id: string) => void;
  quotes?: ReactNode;
}) {
  const [preview, setPreview] = useState<string | null>(null);
  const item = items.find((card) => card.id === preview);
  if (!items.length && !attachments.length && !quotes) return null;
  return (
    <div
      className={s.tray}
      data-testid="reference-tray"
      onKeyDown={(event) => {
        if (event.key === "Escape" && preview) {
          event.preventDefault();
          event.stopPropagation();
          setPreview(null);
        }
      }}
    >
      <div className={s.chips} aria-label="已批注内容">
        {quotes}
        {items.map((card) => (
          <div className={s.chip} key={card.id}>
            <HeroButton
              variant="ghost"
              size="sm"
              className={s.chipTitle}
              type="button"
              onPress={() => setPreview(preview === card.id ? null : card.id)}
              aria-expanded={preview === card.id}
              title={card.title}
            >
              {card.title}
            </HeroButton>
            <HeroButton variant="ghost" size="sm" type="button" onPress={() => onRemove(card.id)} aria-label={`移除批注：${card.title}`}>
              <X size={12} />
            </HeroButton>
          </div>
        ))}
        {attachments.map((attachment) => (
          <span className={x.attachmentChip} key={attachment.id} title={attachment.fileName}>
            <Paperclip size={12} aria-hidden="true" />
            <span>{attachment.fileName}</span>
            {onRemoveAttachment ? (
              <button type="button" onClick={() => onRemoveAttachment(attachment.id)} aria-label={`移除附件：${attachment.fileName}`}>
                <X size={12} />
              </button>
            ) : null}
          </span>
        ))}
      </div>
      {items.length > 1 ? (
        <HeroButton variant="ghost" size="sm" isIconOnly className={s.clear} type="button" onPress={onClear} aria-label="清空批注" title="清空批注">
          <X size={13} />
        </HeroButton>
      ) : null}
      {item ? (
        <section className={s.preview} aria-label={`批注内容：${item.title}`}>
          <header>
            <span>{KIND_LABEL[item.kind] ?? item.kind}</span>
            <HeroButton variant="ghost" size="sm" type="button" aria-label="关闭批注预览" onPress={() => setPreview(null)}>
              <X size={15} />
            </HeroButton>
          </header>
          <h3>{item.title}</h3>
          <small>v{item.version} · 发送时由服务端生成快照</small>
          <pre>{previewText(item)}</pre>
        </section>
      ) : null}
    </div>
  );
}
