"use client";

import { useCallback, useLayoutEffect, useRef, type RefObject } from "react";
import { ChevronDown, Maximize2, Minimize2 } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import { BuddyMark } from "@/components/buddy/BuddyMark";
import type { Buddy } from "@/components/buddy/useBuddy";
import { SelectionToolbar, useSelectionQuote } from "@/components/SelectionQuote";
import { AttachmentStatus } from "./ConversationAttachments";
import { ConversationHistoryState, conversationOwner } from "./ConversationHistoryState";
import { ConversationNotice, ConversationStatusSlot, JumpToLatest, useComposerClearance } from "./Transcript";
import { ConversationTimeline } from "./ConversationTimeline";
import { CitationSurfaceProvider } from "./citations";
import { RichSurfaceProvider } from "./richBlocks/surface";
import { useConversationScroll, type ScrollAnchor } from "./useConversationScroll";
import { resizeWindow } from "./resizeGate";
import { prefersReducedMotion } from "@/lib/motion";
import type { ConversationData } from "./useConversation";
import { useVoice, type VoiceChannel } from "./voiceChannel";
import w from "@/styles/app-shell.module.css";
import t from "@/styles/conversation-transcript.module.css";

/**
 * 对话记录（clark `ConversationHistorySheet`）：从输入条升起的浅色阅读面，非模态。
 * 没有页头横条（D1）：正文从顶部开始；顶上正中是本人的伙伴（回答进行中在说话），左上是放大 ⤢（有时才有），右上一颗圆形液态玻璃的「收起 ⌄」（11/03 用户定：去掉左上的天枢标识、⤢ 挪到左边）。
 * 页头的伙伴和输入条的小麦克风是同一次听写（voice，11/03 用户定）：点伙伴开始听，在听时再点停下、文字留在输入框；在听时它变大、跟着说话的声音动。
 * 点对话层外的空白处、Esc 也收起（宿主在对话层外放一层透明的点击区，不盖遮罩）。附件键在输入条上（D2）。记录归谁写在 data-conversation-owner 上。
 * 输入条上方没有气泡（D6）：听写出错（notice）、发送失败（data.error）都作为轻提示写在这里。
 * 载入中、没读到、真的没有记录分开画。提案卡插在触发它的那轮回答之后（ConversationTimeline，B5）。
 * 一条连续的对话（已定设计第 1 节）：没有「新建对话」「+」，也没有历史对话列表；换话题说一句话就行。
 * 划词引用（B4）：选中消息正文浮出「引用」，交给 onQuote 进本对话的输入框上方，对话层不关。
 * 滚动（useConversationScroll）：打开时停在底部并跟随；发送后刚发的那条推到顶部、回答进行中不跟随；不在真实末尾时浮出 ↓。
 * ↓ 按对话层定位，底边贴在输入条（composerRef）上沿之上 12px，跟着输入条长高变矮（D3）；输出中是三点。
 * 放大（深度讨论 v2，≥1280 才有 ⤢）：对话层靠右、占视口约 58%、上下顶满，左边露出首页（不盖遮罩）；
 * 回答里的来源变成可点的轻量链接，点了在左边打开依据面板（CitationPanel），讨论与证据同屏。
 * 放大 / 收起的 240ms 里（data-resizing，见 resizeWindow）：外框照常变宽变高（阴影、圆角、两角圆键都跟着边走），
 * 滚动区一开始就是终态尺寸、贴着外框左上角，正文只在第一帧按终值排一次；流式上屏、思考追加、各处 ResizeObserver
 * 都等过渡结束再一次补齐（resizeGate）。
 */
export function ConversationHistorySheet({ data, label, global, onClose, anchor = "end", onQuote, composerRef, notice, leaving = false, wide = false, onWide, buddy = null, voice }: {
  data: ConversationData; label: string; global: boolean; onClose: () => void;
  /** 打开时停在哪：底部（默认），或最后一条回答的开头（从首页气泡点开）。 */
  anchor?: ScrollAnchor;
  /** 划词「引用」：这段进本对话的引用条。没给就不浮出。 */
  onQuote?: (text: string) => void;
  /** 全局输入条那一块（含其中的引用行）：↓ 贴着它的上沿。 */
  composerRef?: RefObject<HTMLElement | null>;
  /** 输入条交上来的轻提示（听写没授权、没听清）。 */
  notice?: string | null;
  /** 正在收起（退场动画中）：不再可交互，播完由宿主卸载。 */
  leaving?: boolean;
  /** 放大着（宿主只在 ≥1280 时给 true）。 */
  wide?: boolean;
  /** 给了才画 ⤢ / ⤡。 */
  onWide?: (wide: boolean) => void;
  /** 本人的伙伴：页头正中画它，没选时是默认胶囊。 */
  buddy?: Buddy | null;
  /** 和输入条共用的听写：给了，页头的伙伴就能点（点它 = 点小麦克风）；没给时它只是标识。 */
  voice?: VoiceChannel;
}) {
  const empty = data.historyStatus !== "loading" && data.historyStatus !== "error" && data.messages.length === 0 && !data.streaming;
  const owner = conversationOwner(global ? "global" : data.scope, label);
  const scroll = useConversationScroll({ streaming: data.streaming, anchor });
  const selection = useSelectionQuote(scroll.scrollRef, { within: "[data-chat-role]" });
  const sheet = useRef<HTMLElement>(null);
  useComposerClearance(sheet, composerRef);
  // 放大 / 收起：开一个过渡窗口（打开对话层不算；减少动效时没有过渡，也不开）。
  const shownWide = useRef(wide);
  useLayoutEffect(() => {
    if (shownWide.current === wide) return;
    shownWide.current = wide;
    const element = sheet.current;
    if (!element || prefersReducedMotion()) return;
    return resizeWindow(element);
  }, [wide]);
  const expand = useCallback(() => onWide?.(true), [onWide]);

  return (
    <section ref={sheet} className={`${w.sheet} ${w.historySheet}`} role="dialog" aria-modal="false" aria-label={`${label}的对话记录`} data-testid="conversation-sheet"
      data-leaving={leaving || undefined} inert={leaving || undefined} aria-hidden={leaving || undefined}
      data-empty={empty} data-history={data.historyStatus ?? "ready"} data-conversation-owner={owner.global ? "global" : "object"} data-tone="light"
      data-wide={wide || undefined}>
      {/* 顶部不放拖拽条也不放页头：一道磨砂渐隐，正文滚上来在这里淡出，不撞两颗圆键。 */}
      <div className={w.sheetFade} aria-hidden data-testid="conversation-sheet-fade" />
      {voice ? <SheetBuddy buddy={buddy} speaking={data.streaming} voice={voice} />
        : <span className={w.sheetBuddy} data-testid="conversation-sheet-buddy"><BuddyMark buddy={buddy} place="sheet" active={data.streaming} /></span>}
      {onWide ? (
        <HeroButton variant="ghost" size="sm" isIconOnly className={`${w.glassButton} ${w.sheetWideKey}`} onPress={() => onWide(!wide)}
          data-desk-key title={wide ? "收起" : "深度讨论"} aria-label={wide ? "收起" : "深度讨论"} aria-expanded={wide}>
          {wide ? <Minimize2 size={16} aria-hidden /> : <Maximize2 size={16} aria-hidden />}
        </HeroButton>
      ) : null}
      <HeroButton variant="ghost" size="sm" isIconOnly className={`${w.glassButton} ${w.sheetCollapse}`} onPress={onClose} aria-label="收起对话记录">
        <ChevronDown size={20} strokeWidth={1.9} />
      </HeroButton>
      <div className={w.sheetScroll} ref={scroll.scrollRef} data-testid="conversation-scroll" onMouseUp={onQuote ? selection.onMouseUp : undefined}>
        <div className={w.historyContent} ref={scroll.contentRef}>
          <CitationSurfaceProvider linked={wide} surface="sheet" expand={onWide && !wide ? expand : undefined}>
            {/* 富内容块：放大时完整铺开；收起时大块是缩略卡，点了放大（≥1280）或底部 sheet。 */}
            <RichSurfaceProvider expanded={wide} expand={onWide && !wide ? expand : undefined}>
              <ConversationTimeline data={data} />
            </RichSurfaceProvider>
          </CitationSurfaceProvider>
          <ConversationHistoryState data={data} empty={
            <div className={w.chatWelcome} />
          } />
          {data.error && !data.streaming ? <ConversationNotice text={data.error} action={data.recovery} /> : null}
          {notice ? <ConversationNotice text={notice} /> : null}
          <AttachmentStatus data={data} className={t.meta} />
          {/* 回答进行中，思考与进度排在时间线里本轮正文之后、本轮卡片之前（ConversationTimeline）；这里只在没有回答进行时留出同样高度的空位。 */}
          {data.streaming ? null : <ConversationStatusSlot />}
        </div>
        {/* 发送后置顶用的留白：放在内容之后，高度由 useConversationScroll 直接写。 */}
        <div ref={scroll.reserveRef} aria-hidden data-testid="conversation-scroll-reserve" />
        {onQuote ? <SelectionToolbar selected={selection.selected} label="回复" onQuote={() => {
          if (selection.selected) onQuote(selection.selected.text);
          selection.clear();
        }} /> : null}
      </div>
      <JumpToLatest visible={!scroll.atBottom} onJump={scroll.jumpToLatest} streaming={data.streaming} className={w.historyJump} />
    </section>
  );
}

/** 页头正中可以点的伙伴：自己订阅听写的状态和响度（每 80ms 一帧），只有它跟着重画。 */
function SheetBuddy({ buddy, speaking, voice }: { buddy: Buddy | null; speaking: boolean; voice: VoiceChannel }) {
  const { listening, level } = useVoice(voice);
  const label = listening ? "停止听写，文字留在输入框" : "语音输入";
  return (
    <button type="button" className={w.sheetBuddy} data-testid="conversation-sheet-buddy" onClick={voice.toggle}
      aria-label={label} title={label} aria-pressed={listening}>
      <BuddyMark buddy={buddy} place="sheet" active={speaking} listening={listening} level={level} />
    </button>
  );
}

