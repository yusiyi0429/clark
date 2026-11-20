"use client";

/**
 * 找人（同事伙伴设计第 1 节，左栏对话那边的「+」）：按名字或做什么搜，停 300ms、满两个字才搜。
 * 每行头像、名字、命中原因；行尾关系（好友、等他同意、想加你），没关系时「加好友」，再一个「发消息」进和他伙伴的对话。
 */
import { useEffect, useState } from "react";
import type { TColleagueSearchResponse, TFriendRelation } from "@warmap/contracts";
import { PersonAvatar } from "@/components/avatar/PersonAvatar";
import { chatHref, requestFriend, searchColleagues } from "@/lib/home/colleagueChats";
import { showWorkspaceToast } from "@/lib/toast";
import c from "./chats.module.css";

const RELATION: Record<Exclude<TFriendRelation, "none">, string> = { friends: "好友", pending_out: "等他同意", pending_in: "想加你" };

export function ChatFind({ go }: { go: (href: string) => void }) {
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<TColleagueSearchResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const text = query.trim();
    if ([...text].length < 2) { setFound(null); setError(null); return; }
    const controller = new AbortController();
    const timer = window.setTimeout(() => {
      searchColleagues(text, controller.signal).then((result) => { setFound(result); setError(null); },
        (cause) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "没有搜到，请重试"); });
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [query]);

  const add = async (personId: string) => {
    try {
      const friend = await requestFriend(personId);
      setFound((current) => current && { ...current, people: current.people.map((person) => (person.personId === personId ? { ...person, relation: friend.relation } : person)) });
    } catch (cause) {
      showWorkspaceToast({ text: cause instanceof Error ? cause.message : "没有加上，请重试" });
    }
  };

  return (
    <div className={c.find}>
      <input className={c.search} type="search" value={query} aria-label="搜名字或做什么" placeholder="搜名字或做什么" autoFocus
        onChange={(event) => setQuery(event.target.value)} />
      {error ? <p className={c.more}>{error}</p> : null}
      {found?.people.map((person) => (
        <div key={person.personId} className={c.person}>
          <PersonAvatar personId={person.personId} className={c.avatar}>{[...person.displayName][0] ?? ""}</PersonAvatar>
          <span className={c.named}>{person.displayName}{person.matched.length ? <span className={c.why}>{person.matched.join(" · ")}</span> : null}</span>
          <span className={c.acts}>
            {person.relation === "none"
              ? <button type="button" onClick={() => void add(person.personId)}>加好友</button>
              : <span className={c.relation}>{RELATION[person.relation]}</span>}
            <button type="button" onClick={() => go(chatHref("with", person.personId))}>发消息</button>
          </span>
        </div>
      ))}
      {found && found.more > 0 ? <p className={c.more}>{`还有 ${found.more} 位`}</p> : null}
    </div>
  );
}
