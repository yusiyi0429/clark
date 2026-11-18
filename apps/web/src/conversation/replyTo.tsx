"use client";

/**
 * 新首页两种对话里的「回复」（本人 11/18）：点一块的「回复」，这条对话的输入框里挂一条引用条（ChatInput 读 ReplyContext 画、发出时包成 quotedMessage）。
 * 同一时间只挂一条，再点另一块换掉；只留在这一页，不存草稿；换对话清掉（回复属于那条对话）。
 * 发出后本人那句上方一行淡色小字（SentReply），点开看全文。
 */
import { createContext, useMemo, useState, type ReactNode } from "react";
import { Popover } from "@heroui/react";
import { Reply } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import { quoteExcerpt } from "./QuoteChips";
import b from "@/styles/conversation-bubbles.module.css";
import h from "@/styles/home.module.css";

/** 挂着的那一条：id 每点一次换一个（输入框据此获得焦点、发出后只清掉发出去的那条）。 */
export type ReplyTarget = { id: string; text: string };
type Replies = { target: ReplyTarget | null; to: (text: string) => void; clear: (id: string) => void };
/** 伙伴主线、项目对话给（ReplyProvider）；别处没有，块旁边就不出「回复」「复制」。 */
export const ReplyContext = createContext<Replies | null>(null);

let nextId = 0;

export function useReplyStore(scope: string): Replies {
  const [held, setHeld] = useState<{ scope: string; target: ReplyTarget } | null>(null);
  const target = held?.scope === scope ? held.target : null;
  return useMemo(() => ({
    target,
    to: (text: string) => setHeld({ scope, target: { id: `reply-${++nextId}`, text } }),
    clear: (id: string) => setHeld((current) => (current?.target.id === id ? null : current)),
  }), [target, scope]);
}

export function ReplyProvider({ scope, children }: { scope: string; children: ReactNode }) {
  const value = useReplyStore(scope);
  return <ReplyContext.Provider value={value}>{children}</ReplyContext.Provider>;
}

/** 发出去的那句上方：回复图标加原文开头一段，淡色，最多两行往下渐隐（不出省略号）；点开看全文。 */
export function SentReply({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const excerpt = quoteExcerpt(text, 80);
  return (
    <Popover isOpen={open} onOpenChange={setOpen}>
      <HeroButton variant="ghost" size="sm" className={b.replied} aria-label={`回复 ${excerpt}`} data-testid="sent-reply">
        <Reply size={14} strokeWidth={1.8} aria-hidden /><span className={b.repliedText}>{excerpt}</span>
      </HeroButton>
      <Popover.Content placement="bottom end" offset={6} className={h.pop}>
        <Popover.Dialog aria-label="回复原文" className={b.repliedFull}>{text}</Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}
