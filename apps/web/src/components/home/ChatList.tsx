"use client";

/**
 * 左栏「对话」那边（同事伙伴设计第 1 节）：上组是我去问过的同事（头像是对方的伙伴，对方回了我亮蓝点）；
 * 下组「来问 {伙伴名} 的」是来问我伙伴的同事（头像是对方本人，要我出面时亮黄点）。顺序照接口给的。
 * 每行两行字：名字、最近一句（前面带谁说的，不折行，右端渐隐）。
 */
import type { TChatListResponse, TChatRow } from "@warmap/contracts";
import { PersonAvatar } from "@/components/avatar/PersonAvatar";
import { BuddyMark } from "@/components/buddy/BuddyMark";
import { chatHref } from "@/lib/home/colleagueChats";
import type { View } from "./view";
import c from "./chats.module.css";
import h from "@/styles/home.module.css";

/** 「对话」两个字后面那颗点：有人等我出面是黄的；否则对方回了我、有人想加我是蓝的。 */
export function chatsDot(list: TChatListResponse | null): "attention" | "stopped" | null {
  if (!list) return null;
  if (list.inbound.some((row) => row.waiting > 0)) return "attention";
  return list.mine.some((row) => row.unread) || list.requests.length ? "stopped" : null;
}

/** 最近一句前面带谁说的：with 是我去问他的伙伴，from 是他来问我的伙伴。 */
export function previewLine(row: TChatRow, side: "with" | "from", myBuddy: string): string {
  const name = row.peer.displayName;
  const who = side === "with"
    ? { asker: "我", asker_buddy: `${myBuddy} 替你问的`, buddy: `${name}的伙伴`, owner: name }
    : { asker: name, asker_buddy: `${name}的伙伴`, buddy: myBuddy, owner: "我" };
  return `${who[row.last.author]}：${row.last.text}`;
}

export function ChatList({ list, view, myBuddy, go }: { list: TChatListResponse; view: View; myBuddy: string; go: (href: string) => void }) {
  const line = (row: TChatRow, side: "with" | "from") => {
    const current = view.kind === "chat" && view.side === side && view.personId === row.peer.personId;
    const mark = side === "with"
      ? <span className={c.mark}><BuddyMark buddy={row.peerBuddy} place="note" still /></span>
      : <PersonAvatar personId={row.peer.personId} className={c.avatar}>{[...row.peer.displayName][0] ?? ""}</PersonAvatar>;
    const dot = side === "with" ? (row.unread ? <span className={h.subDot} data-tone="stopped" role="img" aria-label="有新回复"><i aria-hidden /></span> : null)
      : row.waiting > 0 ? <span className={h.subDot} data-tone="attention" role="img" aria-label="等你"><i aria-hidden /></span> : null;
    return (
      <li key={row.id}>
        <button type="button" className={c.chatRow} aria-current={current ? "page" : undefined} onClick={() => go(chatHref(side, row.peer.personId))} data-tree-row="">
          {mark}
          <span className={c.chatText}><span className={c.chatName}>{row.peer.displayName}</span><span className={c.preview}>{previewLine(row, side, myBuddy)}</span></span>
          {dot}
        </button>
      </li>
    );
  };
  return (
    <>
      <ul className={c.chatList}>{list.mine.map((row) => line(row, "with"))}</ul>
      {list.inbound.length ? (
        <>
          <p className={h.groupTitle}>{`来问 ${myBuddy} 的`}</p>
          <ul className={c.chatList}>{list.inbound.map((row) => line(row, "from"))}</ul>
        </>
      ) : null}
    </>
  );
}
