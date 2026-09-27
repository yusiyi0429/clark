"use client";

import { useState } from "react";
import { browserApi } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import s from "@/styles/thread-members.module.css";

type ObjectType = "issue" | "meeting" | "task";
type Member = components["schemas"]["ThreadView"]["members"][number];
type Candidate = components["schemas"]["ThreadCandidatesResponse"]["people"][number];

export function ThreadMembersMenu({ objectType, objectId, viewerId, members, onChanged, inviteOnly = false }: {
  objectType: ObjectType; objectId: string; viewerId: string; members: Member[]; onChanged: () => void; inviteOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [leaving, setLeaving] = useState(false);
  const [people, setPeople] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const showInvite = async () => {
    setError("");
    try {
      const { data } = await browserApi.GET("/api/threads/{objectType}/{objectId}/candidates", { params: { path: { objectType, objectId } } });
      if (!data) return setError("暂时读不到可邀请名单");
      setPeople(data.people); setOpen(false); setInviting(true);
    } catch { setError("暂时读不到可邀请名单"); }
  };
  const add = async () => {
    if (!selected.length) return;
    setBusy(true); setError("");
    try {
      const { data, error: failure } = await browserApi.POST("/api/threads/{objectType}/{objectId}/members", {
        params: { path: { objectType, objectId } }, body: { personIds: selected, ...(note.trim() ? { note: note.trim() } : {}) },
      });
      if (!data) return setError(failure?.message ?? "没能拉人，请重试");
      setInviting(false); setOpen(false); setSelected([]); setNote(""); onChanged();
      window.dispatchEvent(new CustomEvent("thread-members-changed", { detail: { objectType, objectId } }));
    } catch { setError("没能拉人，请重试"); }
    finally { setBusy(false); }
  };
  const leave = async () => {
    setBusy(true); setError("");
    try {
      const { response, error: failure } = await browserApi.POST("/api/threads/{objectType}/{objectId}/leave", { params: { path: { objectType, objectId } } });
      if (response.status !== 204) return setError(failure?.message ?? "没能退出，请重试");
      setLeaving(false); setOpen(false); onChanged();
    } catch { setError("没能退出，请重试"); }
    finally { setBusy(false); }
  };
  return <div className={s.root}>
    <button type="button" className={s.trigger} aria-expanded={open} onClick={() => inviteOnly ? void showInvite() : setOpen(!open)}>
      <span className={s.avatars} aria-hidden>{members.slice(0, 3).map((person) => <i key={person.personId}>{person.displayName.slice(0, 1)}</i>)}</span>
      <span>{inviteOnly ? "拉人进群" : `群成员 · ${members.length}`}</span>
    </button>
    {open ? <div className={s.popover}>
      <strong>群成员</strong>
      <ul>{members.map((person) => <li key={person.personId}><span className={s.avatar}>{person.displayName.slice(0, 1)}</span>{person.displayName}{person.personId === viewerId ? "（你）" : ""}</li>)}</ul>
      <div className={s.actions}><button type="button" onClick={() => void showInvite()}>拉人进群</button><button type="button" onClick={() => setLeaving(true)}>退出群聊</button></div>
      {error ? <p role="alert">{error}</p> : null}
    </div> : null}
    {inviting ? <div className={s.backdrop} role="presentation"><section className={s.dialog} role="dialog" aria-modal="true" aria-label="拉人进群">
      <h3>拉人进群</h3><p>选一位或多位同事，告诉他们为什么要参与。</p>
      <div className={s.options}>{people.map((person) => <label key={person.personId}><input type="checkbox" checked={selected.includes(person.personId)} onChange={() => setSelected((current) => current.includes(person.personId) ? current.filter((id) => id !== person.personId) : [...current, person.personId])} />{person.displayName}</label>)}</div>
      <textarea value={note} maxLength={200} placeholder="为什么拉他们进来（可选）" onChange={(event) => setNote(event.target.value)} />
      {error ? <p role="alert">{error}</p> : null}
      <div className={s.actions}><button type="button" onClick={() => setInviting(false)}>取消</button><button type="button" disabled={!selected.length || busy} onClick={() => void add()}>确认拉人</button></div>
    </section></div> : null}
    {leaving ? <div className={s.backdrop} role="presentation"><section className={s.dialog} role="dialog" aria-modal="true" aria-label="退出群聊">
      <h3>退出群聊？</h3><p>退出后将不能读取或发送消息。再次被拉进来时可以看到历史记录。</p>
      {error ? <p role="alert">{error}</p> : null}
      <div className={s.actions}><button type="button" onClick={() => setLeaving(false)}>取消</button><button type="button" disabled={busy} onClick={() => void leave()}>确认退出</button></div>
    </section></div> : null}
  </div>;
}
