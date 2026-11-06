"use client";

/**
 * 和伙伴的主对话（总线程，scope=global）放在一列里：对话页居中一列、Task 页左栏、手机上 Task 的「对话」页签都用它。
 * 只复用现有对话的零件（useConversation、ConversationTimeline、ColumnComposer），不改它们；输入条原本是 fixed 定位，这里在本列里重新摆。
 * 从哪一页发的，useConversation 会带上当前路径（pagePath）：Task 页的话，云端按 /me/month/tasks/<id> 给 Chat 带上这个 Task（第 10 节兜底）。
 */
import { useState, type ReactNode } from "react";
import { ColumnComposer } from "@/conversation/ColumnComposer";
import { ConversationTimeline } from "@/conversation/ConversationTimeline";
import { ConversationHistoryState } from "@/conversation/ConversationHistoryState";
import { ConversationNotice, ConversationStatusSlot, JumpToLatest } from "@/conversation/Transcript";
import type { ConversationChannel } from "@/conversation/ConversationColumn";
import { useConversation } from "@/conversation/useConversation";
import { useConversationScroll } from "@/conversation/useConversationScroll";
import type { Buddy } from "@/components/buddy/useBuddy";
import s from "@/styles/v2-chat.module.css";

const NOOP = () => undefined;

export function ChatPane({ buddy, head, extra, variant = "page" }: {
  buddy: Buddy | null;
  /** 列顶上那一块（伙伴形象、对话列表钮、Task 标签）。 */
  head?: ReactNode;
  /** 接在对话记录后面、只在网页里画的东西（Task 下要你拿主意的卡）。 */
  extra?: ReactNode;
  /** page：对话页居中一列；side：Task 页左栏。 */
  variant?: "page" | "side";
}) {
  const data = useConversation("global");
  const scroll = useConversationScroll({ streaming: data.streaming });
  const [composerHeight, setComposerHeight] = useState(52);
  const name = buddy?.name?.trim() || "伙伴";
  const channels: ConversationChannel[] = [{ id: "agent", kind: "agent", label: "天枢", title: name, unread: 0 }];
  return (
    <section className={s.pane} data-variant={variant} data-tone="light" aria-label={`和${name}的对话`} style={{ ["--pane-composer" as string]: `${composerHeight}px` }}>
      {head ? <div className={s.head}>{head}</div> : null}
      <div className={s.log} ref={scroll.scrollRef} role="log" aria-label={name} aria-live="polite" aria-relevant="additions text">
        <div className={s.inner} ref={scroll.contentRef}>
          <ConversationTimeline data={data} />
          <ConversationHistoryState data={data} empty={null} />
          {data.error && !data.streaming ? <ConversationNotice text={data.error} action={data.recovery} /> : null}
          {extra}
          {data.streaming ? null : <ConversationStatusSlot />}
        </div>
        <div ref={scroll.reserveRef} aria-hidden />
      </div>
      <JumpToLatest visible={!scroll.atBottom} onJump={scroll.jumpToLatest} streaming={data.streaming} className={s.jump} />
      <div className={s.composer}>
        <ColumnComposer data={data} label={name} channels={channels} channel="agent" onChannel={NOOP} narrow={false} mobileOpen={false}
          onMobileOpen={NOOP} references={[]} onHeightChange={setComposerHeight} />
      </div>
    </section>
  );
}
