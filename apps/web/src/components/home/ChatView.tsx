"use client";

/**
 * 同事对话页（设计稿 buddy-friends 第 2、4 节）：一段 = 问的人 × 主人的伙伴，一直往下聊；两边看同一段。
 * - with（/me/work/chats/with/<id>）：我去问他的伙伴。问句下面按伙伴答到哪画（在答、没答上来、问满、转本人）；伙伴的话下面能「问本人」。
 * - from（/me/work/chats/from/<id>）：他来问我的伙伴。我的伙伴的话能改、能收回；他问的每句能「回这句」；打开时停在最早等我的那句。
 * 每句上面一行写谁说的（chatWho），我这边说的靠右、不写。对方已离开：只读，没有输入框和按钮。
 * 页头点对方名字出好友面板（FriendPanel）。
 */
import { Fragment, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Popover } from "@heroui/react";
import { Button as Pressable } from "react-aria-components";
import type { TChatMessage, TChatView } from "@warmap/contracts";
import { PersonAvatar } from "@/components/avatar/PersonAvatar";
import { BuddyMark } from "@/components/buddy/BuddyMark";
import { briefFlash } from "@/components/meeting/readingScroll";
import type { Buddy } from "@/components/buddy/useBuddy";
import { HeroButton } from "@/components/HeroButton";
import { BuddyBubble, TypingBubble, UserBubble } from "@/conversation/ReplyBubbles";
import { CHAT_WAIT_WORD, askChatOwner, correctMessage, ownerReply, retractMessage, retryChatAnswer, sendChatMessage } from "@/lib/home/colleagueChats";
import { showWorkspaceToast } from "@/lib/toast";
import h from "@/styles/home.module.css";
import c from "./chats.module.css";
import { FriendPanel } from "./FriendSheet";
import { InputBar } from "./InputBar";
import { useColleagueChat } from "./useColleagueChat";
import { useViewChrome } from "./view";

type Side = "with" | "from";
const isQuestion = (message: TChatMessage) => message.author === "asker" || message.author === "asker_buddy";

/** 这句上面那一行：谁说的、转没转本人、对方本人看没看过或改没改过；我这边说的（with 的我、from 的我本人）为 null。asked 是伙伴这句答的那句问话。 */
export function chatWho(message: TChatMessage, side: Side, names: { peer: string; myBuddy: string }, asked?: TChatMessage): string | null {
  const { peer, myBuddy } = names;
  const wait = asked?.wait ?? null;
  if (side === "with") {
    switch (message.author) {
      case "asker": return null;
      case "asker_buddy": return `${myBuddy} 替你问的`;
      case "owner": return peer;
      case "buddy":
        if (message.retracted) return `${peer}收回了一句`;
        return [`${peer}的伙伴`, ...(wait ? [`转${peer}本人`] : []), message.correction ? "他改过" : message.seen ? "他看过" : "他还没看"].join(" · ");
    }
  }
  switch (message.author) {
    case "asker": return peer;
    case "asker_buddy": return `${peer}的伙伴问的`;
    case "owner": return null;
    case "buddy":
      if (message.retracted) return `${myBuddy} · 收回了`;
      return [myBuddy, ...(wait ? ["转给你", CHAT_WAIT_WORD[wait.reason]] : []), ...(message.correction ? ["改过"] : [])].join(" · ");
  }
}

/** 页面上能做的几件事；没做成的由调用方提示，send、correct 回 false 或报错时输入框把字放回去。 */
export type ChatActions = {
  send: (text: string, replyTo?: string) => Promise<boolean>;
  retry: (messageId: string) => Promise<void>;
  askOwner: (messageId: string) => Promise<void>;
  correct: (messageId: string, text: string) => Promise<boolean>;
  retract: (messageId: string) => Promise<void>;
};

const quoteOf = (message: TChatMessage) => ({ id: message.id, label: `回复 ${[...message.text].slice(0, 20).join("")}` });

/**
 * 主人这边输入框引的那句：choice 为 "waiting" 时引这段现在最早等我的那句（打开时、每回完一句后都回到它），是句子 id 时引点了「回这句」的那句，
 * null 是本人点掉了引用（单说一句，不结清哪件）。问的人这边不引。
 */
export function chatQuote(chat: TChatView, choice: "waiting" | string | null): { id: string; label: string } | null {
  const id = chat.side !== "from" ? null : choice === "waiting" ? chat.firstWaiting : choice;
  const message = id ? chat.messages.find((entry) => entry.id === id) : undefined;
  return message ? quoteOf(message) : null;
}

/** 只管显示的那一层：拿到一段对话和几件事，画页头、句子、输入框。 */
export function ChatBody({ chat, buddy, actions }: { chat: TChatView; buddy: Buddy | null; actions: ChatActions }) {
  const chrome = useViewChrome();
  const { side, peer, messages } = chat;
  const names = { peer: peer.displayName, myBuddy: buddy?.name?.trim() || "伙伴" };
  const byId = new Map(messages.map((message) => [message.id, message]));
  const readOnly = peer.left;
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState<string | null>(null);
  const [friendOpen, setFriendOpen] = useState(false);
  const [choice, setChoice] = useState<"waiting" | string | null>("waiting");
  const quote = chatQuote(chat, choice);
  const run = async (work: () => Promise<unknown>) => {
    setBusy(true);
    try { await work(); } finally { setBusy(false); }
  };

  // 打开时停在最早等我的那句（from，闪一下），否则到最新；之后只在句数变多时到最新。按上次看到的句数判，同一句数再跑（StrictMode 跑两遍）什么都不做。
  const log = useRef<HTMLDivElement>(null);
  const counted = useRef<number | null>(null);
  useLayoutEffect(() => {
    const element = log.current;
    if (!element) return;
    const last = counted.current;
    counted.current = messages.length;
    const target = last === null && side === "from" && chat.firstWaiting ? element.querySelector<HTMLElement>(`[data-id="${chat.firstWaiting}"]`) : null;
    if (target) {
      target.scrollIntoView({ block: "center" });
      briefFlash(target.querySelector<HTMLElement>("[data-bubble]") ?? target);
    } else if (last === null || messages.length > last) element.scrollTop = element.scrollHeight;
  }, [messages.length, side, chat.firstWaiting]);

  const personMark = <PersonAvatar personId={peer.personId} className={c.avatar}>{[...peer.displayName][0] ?? ""}</PersonAvatar>;
  const buddyMark = <BuddyMark buddy={chat.peerBuddy} place="note" still />;
  const button = (label: string, onClick: () => unknown) => (
    <button key={label} type="button" disabled={busy} onClick={() => void run(async () => { await onClick(); })}>{label}</button>
  );
  const row = (key: string, mine: boolean, mark: ReactNode, who: string | null, body: ReactNode, acts: ReactNode[] = []) => (
    <div key={key} className={c.row} data-mine={mine || undefined} data-id={key}>
      {mine ? null : <span className={c.mark}>{mark}</span>}
      <div className={c.body} data-editing={editing === key || undefined}>
        {who ? <div className={c.who}>{who}</div> : null}
        {body}
        {acts.length && !readOnly ? <div className={c.acts}>{acts}</div> : null}
      </div>
    </div>
  );
  const bubble = (mine: boolean, text: string, sources: string[] = []) => {
    const inner = <><p className={c.text}>{text}</p>{sources.length ? <p className={c.source}>出处：{sources.join("；")}</p> : null}</>;
    return mine ? <UserBubble>{inner}</UserBubble> : <BuddyBubble>{inner}</BuddyBubble>;
  };

  // 问的人这边：问句下面伙伴答到哪。
  const answerRow = (message: TChatMessage) => {
    const key = `${message.id}:answer`;
    switch (message.answer) {
      case "answering": return row(key, false, buddyMark, null, <TypingBubble />);
      case "failed": return row(key, false, buddyMark, null, <div className={c.status}>没答上来</div>,
        [button("重试", () => actions.retry(message.id)), button("问本人", () => actions.askOwner(message.id))]);
      case "limited": return row(key, false, buddyMark, null, <div className={c.status}>今天问满了</div>, [button("问本人", () => actions.askOwner(message.id))]);
      case "asked_owner": return row(key, false, buddyMark, null, <div className={c.status}>转{peer.displayName}本人</div>);
      default: return null;
    }
  };

  const line = (message: TChatMessage) => {
    const asked = message.replyTo ? byId.get(message.replyTo) : undefined;
    const who = chatWho(message, side, names, asked);
    const mine = side === "with" ? isQuestion(message) : !isQuestion(message);
    const mark = message.author === "buddy" || message.author === "asker_buddy" ? buddyMark : personMark;
    let body: ReactNode = bubble(mine, message.text, message.sources);
    let acts: ReactNode[] = [];
    if (message.author === "buddy" && message.retracted) {
      // 问的人这边只剩谁收回的那一行；主人自己看得到收回的原话，淡着。
      body = side === "from" ? <div className={c.gone}><p className={c.text}>{message.text}</p></div> : null;
    } else if (message.author === "buddy" && side === "with") {
      if (!asked?.wait) acts = [button("问本人", () => actions.askOwner(message.id))];
    } else if (message.author === "buddy") {
      if (editing === message.id) body = <EditBox text={message.text} onCancel={() => setEditing(null)}
        onSubmit={async (text) => { if (await actions.correct(message.id, text)) setEditing(null); }} />;
      else acts = [...(message.correction ? [] : [button("改", () => setEditing(message.id))]), button("收回", () => actions.retract(message.id))];
    } else if (side === "from" && isQuestion(message)) {
      acts = [button("回这句", () => setChoice(message.id))];
    }
    return (
      <Fragment key={message.id}>
        {row(message.id, mine, mark, who, body, acts)}
        {/* 更正是主人自己的话，紧跟在被改的那句下面；那句收回了也留着。 */}
        {message.correction ? row(message.correction.id, side === "from", personMark, side === "with" ? peer.displayName : null, bubble(side === "from", message.correction.text)) : null}
        {side === "with" && isQuestion(message) ? answerRow(message) : null}
      </Fragment>
    );
  };

  const send = async (text: string, files: File[]) => {
    if (files.length) { showWorkspaceToast({ text: "对话里不带文件" }); return false; }
    const ok = await actions.send(text, quote?.id);
    // 发完回到「引最早等我的那句」：读回来的这段里还有等着的就引下一件。
    if (ok) setChoice("waiting");
    return ok;
  };
  return (
    <div className={c.chat} data-testid="chat-view">
      <header className={h.viewHead}>
        {chrome.lead}
        <span className={c.mark}>{side === "with" ? buddyMark : personMark}</span>
        <h1 className={h.viewTitle} tabIndex={-1}>
          {peer.left ? <>{peer.displayName}<span className={c.leftWord}>已离开</span></> : (
            <Popover isOpen={friendOpen} onOpenChange={setFriendOpen}>
              <Pressable className={c.nameButton} data-testid="chat-peer-name">{peer.displayName}</Pressable>
              <Popover.Content placement="bottom start" offset={6} className={h.pop}>
                <Popover.Dialog aria-label={peer.displayName} className={c.friendDialog}><FriendPanel personId={peer.personId} onClose={() => setFriendOpen(false)} /></Popover.Dialog>
              </Popover.Content>
            </Popover>
          )}
        </h1>
        {chrome.trail}
      </header>
      <div className={c.log} ref={log}><div className={c.inner}>{messages.map(line)}</div></div>
      {readOnly ? null : (
        <div className={c.composer}>
          <InputBar textRequired placeholder={side === "with" ? `发给${peer.displayName}的伙伴` : `回${peer.displayName}`} onSend={send}
            quote={quote ? { key: quote.id, label: quote.label, onClear: () => setChoice(null) } : null} />
        </div>
      )}
    </div>
  );
}

/** 字框高度随内容：先放开再量 scrollHeight（加上边框）；最矮、最高由样式管，超过最高才在框里滚。 */
const fitHeight = (field: HTMLTextAreaElement) => {
  field.style.height = "auto";
  field.style.height = `${field.scrollHeight + field.offsetHeight - field.clientHeight}px`;
};

/** 主人改伙伴的一句：就地出预填原话的框。 */
function EditBox({ text, onSubmit, onCancel }: { text: string; onSubmit: (text: string) => Promise<void>; onCancel: () => void }) {
  const [value, setValue] = useState(text);
  const [busy, setBusy] = useState(false);
  const field = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => { if (field.current) fitHeight(field.current); }, []);
  const changed = !!value.trim() && value.trim() !== text.trim();
  return (
    <div className={c.edit}>
      <textarea ref={field} className={c.field} value={value} aria-label="改这句" autoFocus
        onChange={(event) => { setValue(event.target.value); fitHeight(event.target); }} />
      <div className={c.acts}>
        <button type="button" disabled={busy || !changed} onClick={() => { setBusy(true); void onSubmit(value.trim()).finally(() => setBusy(false)); }}>提交</button>
        <button type="button" disabled={busy} onClick={onCancel}>取消</button>
      </div>
    </div>
  );
}

/** 读一段对话、把几件事接到路由上；没做成的出一条提示。 */
export function ChatView({ side, personId, buddy }: { side: Side; personId: string; buddy: Buddy | null; go: (href: string) => void }) {
  const { chat, error, setChat, reload } = useColleagueChat(side, personId);
  if (!chat) {
    return (
      <div className={h.missing} aria-busy={!error || undefined}>
        {error ? <p className={h.planFailed}>{error}<HeroButton variant="ghost" size="sm" onPress={reload}>重试</HeroButton></p> : null}
      </div>
    );
  }
  const chatId = chat.id;
  const apply = async (work: () => Promise<TChatView>) => {
    try { setChat(await work()); return true; }
    catch (cause) { showWorkspaceToast({ text: cause instanceof Error ? cause.message : "没有做成，请重试" }); return false; }
  };
  const actions: ChatActions = {
    send: async (text, replyTo) => {
      const clientId = crypto.randomUUID();
      setChat(side === "with" ? await sendChatMessage(personId, { clientId, text }) : await ownerReply(chatId!, { clientId, text, ...(replyTo ? { replyTo } : {}) }));
      return true;
    },
    retry: async (messageId) => { await apply(() => retryChatAnswer(chatId!, messageId)); },
    askOwner: async (messageId) => { await apply(() => askChatOwner(chatId!, messageId)); },
    correct: (messageId, text) => apply(() => correctMessage(chatId!, messageId, { clientId: crypto.randomUUID(), text })),
    retract: async (messageId) => { await apply(() => retractMessage(chatId!, messageId)); },
  };
  return <ChatBody chat={chat} buddy={buddy} actions={actions} />;
}
