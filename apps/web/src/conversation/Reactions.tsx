"use client";

/**
 * 表情（本人 11/16，照 WhatsApp / iMessage）：
 * - 输入框下面一行的表情按钮：点开一个小面板，点一个插到光标处（EmojiButton）。
 * - 伙伴台、项目对话里的一条消息：右键、悬停出的小按钮、手机上长按，弹出六个快捷表情加「更多」；选了挂在气泡下面，再点自己挂的就取消。
 *   只是本人自己的标记（存在天枢，读历史时随消息带回 reactions），不送给模型、不通知别人。
 */
import { createContext, useContext, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import { Popover } from "@heroui/react";
import { MoreHorizontal, Smile, SmilePlus } from "lucide-react";
import type { TConversationReaction } from "@warmap/contracts";
import { HeroButton } from "@/components/HeroButton";
import { browserApi } from "@/lib/api/client";
import { showWorkspaceToast } from "@/lib/toast";
import type { Message } from "./useConversation";
import h from "@/styles/home.module.css";
import r from "@/styles/reactions.module.css";

/** 常用表情，按常用排（面板 8 列）；name 是读屏念的中文名。 */
export const EMOJIS: readonly { char: string; name: string }[] = [
  { char: "👍", name: "点赞" }, { char: "❤️", name: "爱心" }, { char: "😂", name: "笑哭" }, { char: "😮", name: "惊讶" },
  { char: "😢", name: "难过" }, { char: "🙏", name: "合十" }, { char: "😊", name: "微笑" }, { char: "😄", name: "大笑" },
  { char: "🤣", name: "笑得打滚" }, { char: "😍", name: "喜欢" }, { char: "🥰", name: "爱你" }, { char: "😘", name: "飞吻" },
  { char: "😉", name: "眨眼" }, { char: "😎", name: "酷" }, { char: "🤔", name: "思考" }, { char: "😅", name: "尴尬" },
  { char: "😭", name: "大哭" }, { char: "😡", name: "生气" }, { char: "😴", name: "困" }, { char: "🤗", name: "拥抱" },
  { char: "🙄", name: "翻白眼" }, { char: "😬", name: "紧张" }, { char: "👎", name: "不赞同" }, { char: "👌", name: "好的" },
  { char: "👏", name: "鼓掌" }, { char: "💪", name: "加油" }, { char: "🙌", name: "欢呼" }, { char: "🤝", name: "握手" },
  { char: "✌️", name: "胜利" }, { char: "👀", name: "在看" }, { char: "🔥", name: "火" }, { char: "🎉", name: "庆祝" },
  { char: "✅", name: "完成" }, { char: "❌", name: "不行" }, { char: "⭐", name: "星星" }, { char: "💯", name: "满分" },
  { char: "🚀", name: "火箭" }, { char: "☕", name: "咖啡" }, { char: "🌹", name: "玫瑰" }, { char: "😀", name: "笑脸" },
];
/** 右键、长按先出的六个。 */
export const QUICK_REACTIONS = EMOJIS.slice(0, 6);
const COLUMNS = 8;
/** 一条消息上本人最多挂几个（同契约 MESSAGE_REACTION_MAX；网页不从契约包取运行时的值）。 */
const MAX_REACTIONS = 3;
export const emojiName = (char: string) => EMOJIS.find((emoji) => emoji.char === char)?.name ?? char;

/** 在 start–end（选中的那段）插一个表情，返回新的字和光标位置。 */
export function insertEmoji(text: string, start: number, end: number, emoji: string): { text: string; caret: number } {
  return { text: text.slice(0, start) + emoji + text.slice(end), caret: start + emoji.length };
}

/** 点一个表情：挂过的取消；没挂过的加上（同一个只算一个），超过上限去掉最早挂的。 */
export function toggleReaction(current: readonly string[], emoji: string): string[] {
  return current.includes(emoji) ? current.filter((item) => item !== emoji) : [...current, emoji].slice(-MAX_REACTIONS);
}

/** 一排表情按钮：方向键在里面走（上下按列），回车、空格选。 */
function EmojiButtons({ emojis, columns, selected, onPick, label, more }: {
  emojis: readonly { char: string; name: string }[]; columns: number; selected?: readonly string[]; onPick: (emoji: string) => void; label: string;
  more?: () => void;
}) {
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    const step = { ArrowRight: 1, ArrowLeft: -1, ArrowDown: columns, ArrowUp: -columns }[event.key];
    const buttons = [...event.currentTarget.querySelectorAll("button")];
    const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
    if (at < 0) return;
    const next = event.key === "Home" ? 0 : event.key === "End" ? buttons.length - 1 : step === undefined ? -1 : at + step;
    if (next < 0 || next >= buttons.length) return;
    event.preventDefault();
    buttons[next].focus();
  };
  return (
    <div role="group" aria-label={label} className={r.emojis} style={{ gridTemplateColumns: `repeat(${columns + (more ? 1 : 0)}, 36px)` }} onKeyDown={move}>
      {emojis.map((emoji, index) => (
        <button key={emoji.char} type="button" className={r.emoji} aria-label={emoji.name} title={emoji.name} autoFocus={index === 0}
          aria-pressed={selected ? selected.includes(emoji.char) : undefined} onClick={() => onPick(emoji.char)}>{emoji.char}</button>
      ))}
      {more ? <button type="button" className={r.emoji} aria-label="更多表情" title="更多表情" onClick={more}><MoreHorizontal size={16} strokeWidth={1.8} aria-hidden /></button> : null}
    </div>
  );
}

/** 表情面板（输入框和「更多」共用）。 */
export function EmojiGrid({ onPick, selected }: { onPick: (emoji: string) => void; selected?: readonly string[] }) {
  return <EmojiButtons emojis={EMOJIS} columns={COLUMNS} selected={selected} onPick={onPick} label="表情" />;
}

/** 右键、长按先出的那一排：六个加「更多」。 */
export function QuickReactions({ onPick, onMore, selected }: { onPick: (emoji: string) => void; onMore: () => void; selected: readonly string[] }) {
  return <EmojiButtons emojis={QUICK_REACTIONS} columns={QUICK_REACTIONS.length} selected={selected} onPick={onPick} label="回应" more={onMore} />;
}

/** 输入框下面一行的表情按钮：点开面板，选一个交给 onPick（插到光标处），面板收起。 */
export function EmojiButton({ onPick, disabled = false }: { onPick: (emoji: string) => void; disabled?: boolean }) {
  const [open, setOpen] = useState(false);
  return (
    <Popover isOpen={open} onOpenChange={setOpen}>
      <HeroButton variant="ghost" size="sm" isIconOnly className={r.tool} aria-label="表情" isDisabled={disabled} data-testid="emoji-button">
        <Smile size={16} strokeWidth={1.8} aria-hidden />
      </HeroButton>
      <Popover.Content placement="top start" offset={8} className={h.pop}>
        <Popover.Dialog aria-label="表情" className={r.dialog}>
          <EmojiGrid onPick={(emoji) => { setOpen(false); onPick(emoji); }} />
        </Popover.Dialog>
      </Popover.Content>
    </Popover>
  );
}

/** buddyName：伙伴点的表情读屏念「{伙伴名} 点了 …」。 */
type Reactions = { of: (message: Message) => readonly string[]; toggle: (message: Message, emoji: string) => void; buddyName?: string };
/** 伙伴台、项目对话给（ReactionsProvider）；别处没有，消息上就不出表情。 */
export const ReactionContext = createContext<Reactions | null>(null);

const keyOf = (message: Pick<Message, "role" | "runId">) => `${message.role}:${message.runId}`;

/** 本人在这段对话里挂的表情：先在这一页改，存不上改回去。读回的历史以这一页改过的为准。 */
export function useReactionStore(scope: string): Reactions {
  const [changed, setChanged] = useState<ReadonlyMap<string, readonly string[]>>(() => new Map());
  return useMemo(() => {
    const of = (message: Message) => changed.get(keyOf(message)) ?? message.reactions ?? [];
    const set = (key: string, emojis: readonly string[]) => setChanged((current) => new Map(current).set(key, emojis));
    return {
      of,
      toggle(message, emoji) {
        const before = of(message);
        const emojis = toggleReaction(before, emoji);
        const body: TConversationReaction = { runId: message.runId!, role: message.role, emojis };
        set(keyOf(message), emojis);
        void browserApi.PUT("/api/conversations/{scope}/reactions", { params: { path: { scope } }, body })
          .then(({ error }) => { if (error) throw new Error(); })
          .catch(() => { set(keyOf(message), before); showWorkspaceToast({ text: "表情没存上" }); });
      },
    };
  }, [changed, scope]);
}

export function ReactionsProvider({ scope, buddyName, children }: { scope: string; buddyName: string; children: ReactNode }) {
  const store = useReactionStore(scope);
  const value = useMemo(() => ({ ...store, buddyName }), [store, buddyName]);
  return <ReactionContext.Provider value={value}>{children}</ReactionContext.Provider>;
}

/** 伙伴点在本人那句上的表情（设计 6.5）：只读，点了不切换；读屏念「{伙伴名} 点了 👍」。和本人自己点的分开画。 */
export function BuddyReactions({ emojis }: { emojis: readonly string[] }) {
  const name = useContext(ReactionContext)?.buddyName || "伙伴";
  return (
    <span className={r.byBuddy} data-by-buddy="">
      {emojis.map((emoji) => <span key={emoji} className={r.chip} role="img" aria-label={`${name} 点了 ${emoji}`} title={`${name} 点了 ${emoji}`}>{emoji}</span>)}
    </span>
  );
}

const LONG_PRESS_MS = 500;

/**
 * 一条消息上的表情：给气泡的事件（右键、长按）和挂在气泡下面的那一行（挂的表情、悬停出的小按钮、快捷表情浮层）。
 * edge：新首页的两种对话里这一行挂在气泡底边上（由气泡给位置），不再挂在整条下面。
 * 没有 ReactionContext、还没写进历史的（没有 runId）、留痕行这类不出。
 */
export function useMessageReaction(message: Message | null, edge = false) {
  const reactions = useContext(ReactionContext);
  const [open, setOpen] = useState(false);
  const press = useRef<ReturnType<typeof setTimeout> | null>(null);
  if (!reactions || !message?.runId || message.kind || message.sequence < 1) return null;
  const cancel = () => { if (press.current) clearTimeout(press.current); press.current = null; };
  const target = {
    "data-reactable": "",
    style: { position: "relative" as const },
    onContextMenu: (event: MouseEvent) => {
      // 选了字的右键照浏览器的（复制）。
      if (window.getSelection()?.toString()) return;
      event.preventDefault();
      setOpen(true);
    },
    onTouchStart: () => { cancel(); press.current = setTimeout(() => { press.current = null; setOpen(true); }, LONG_PRESS_MS); },
    onTouchEnd: cancel,
    onTouchMove: cancel,
  };
  const view = <MessageReactions mine={reactions.of(message)} user={message.role === "user"} edge={edge} open={open} onOpenChange={setOpen} onToggle={(emoji) => reactions.toggle(message, emoji)} />;
  return { open, target, view };
}

export function MessageReactions({ mine, user, edge = false, open, onOpenChange, onToggle }: {
  mine: readonly string[]; user: boolean; edge?: boolean; open: boolean; onOpenChange: (open: boolean) => void; onToggle: (emoji: string) => void;
}) {
  // 「更多」翻出的面板只到这一次收起；收起的动画里不换回快捷那一排，下次打开再从快捷那一排起。
  const [more, setMore] = useState(false);
  const [shown, setShown] = useState(open);
  if (open !== shown) { setShown(open); if (open) setMore(false); }
  const pick = (emoji: string) => { onOpenChange(false); onToggle(emoji); };
  return (
    <div className={r.row} data-side={user ? "end" : "start"} data-edge={edge ? "" : undefined} data-reacted={mine.length ? "" : undefined} data-testid="message-reactions">
      {mine.map((emoji) => (
        <button key={emoji} type="button" className={r.chip} aria-pressed="true" aria-label={emojiName(emoji)} title={emojiName(emoji)} onClick={() => onToggle(emoji)}>{emoji}</button>
      ))}
      <Popover isOpen={open} onOpenChange={onOpenChange}>
        <HeroButton variant="ghost" size="sm" isIconOnly className={r.add} aria-label="回应" data-testid="reaction-add">
          <SmilePlus size={16} strokeWidth={1.8} aria-hidden />
        </HeroButton>
        <Popover.Content placement={user ? "bottom end" : "bottom start"} offset={6} className={h.pop}>
          <Popover.Dialog aria-label="回应" className={r.dialog} data-testid="reaction-menu">
            {more ? <EmojiGrid onPick={pick} selected={mine} /> : <QuickReactions onPick={pick} onMore={() => setMore(true)} selected={mine} />}
          </Popover.Dialog>
        </Popover.Content>
      </Popover>
    </div>
  );
}
