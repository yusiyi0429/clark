"use client";

import { useState } from "react";
import { Modal } from "@heroui/react";
import { Button, Popover } from "ts-design/primitives";
import { TianshuPortalTheme } from "ts-design";
import { browserApi } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { useConfirm } from "@/components/ConfirmDialog";
import s from "@/styles/thread-members.module.css";

type ObjectType = "issue" | "meeting" | "task";
type Member = components["schemas"]["ThreadView"]["members"][number];
type Candidate = components["schemas"]["ThreadCandidatesResponse"]["people"][number];

/**
 * 群成员：对话栏顶部的成员头像与人数，点开是成员名单、拉人和退出（spec §11.1）。
 * 拉人与退出用应用统一的弹窗：拉人和执行事项的「邀请协作」同一套样子，退出用 useConfirm。
 * inviteOnly：议题页页头那颗「拉人进群」，直接打开拉人弹窗（议题还没有群时 CEO 从这里建群）。
 */
export function ThreadMembersMenu({ objectType, objectId, viewerId, members, onChanged, inviteOnly = false }: {
  objectType: ObjectType; objectId: string; viewerId: string; members: Member[]; onChanged: () => void; inviteOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [inviting, setInviting] = useState(false);
  const [people, setPeople] = useState<Candidate[]>([]);
  const [selected, setSelected] = useState<string[]>([]);
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { ask, dialog } = useConfirm();

  const showInvite = async () => {
    setError("");
    try {
      const { data } = await browserApi.GET("/api/threads/{objectType}/{objectId}/candidates", { params: { path: { objectType, objectId } } });
      if (!data) return setError("暂时读不到可邀请名单，请重试。");
      setPeople(data.people); setOpen(false); setInviting(true);
    } catch { setError("暂时读不到可邀请名单，请重试。"); }
  };
  const closeInvite = () => { setInviting(false); setSelected([]); setNote(""); setError(""); };
  const add = async () => {
    if (!selected.length) return;
    setBusy(true); setError("");
    try {
      const { data, error: failure } = await browserApi.POST("/api/threads/{objectType}/{objectId}/members", {
        params: { path: { objectType, objectId } }, body: { personIds: selected, ...(note.trim() ? { note: note.trim() } : {}) },
      });
      if (!data) return setError(failure?.message ?? "没能拉人，请重试。");
      closeInvite(); onChanged();
      window.dispatchEvent(new CustomEvent("thread-members-changed", { detail: { objectType, objectId } }));
    } catch { setError("没能拉人，请重试。"); }
    finally { setBusy(false); }
  };
  const leave = async () => {
    setOpen(false);
    if (!(await ask("退出后不能再读或发这个群的消息。再次被拉进来时能看到全部记录。", "退出群聊"))) return;
    setBusy(true); setError("");
    try {
      const { response, error: failure } = await browserApi.POST("/api/threads/{objectType}/{objectId}/leave", { params: { path: { objectType, objectId } } });
      if (response.status !== 204) { setError(failure?.message ?? "没能退出，请重试。"); setOpen(true); return; }
      onChanged();
    } catch { setError("没能退出，请重试。"); setOpen(true); }
    finally { setBusy(false); }
  };

  const avatars = <span className={s.avatars} aria-hidden>{members.slice(0, 3).map((person) => <i key={person.personId}>{person.displayName.slice(0, 1)}</i>)}</span>;
  return <div className={s.root}>
    {inviteOnly
      ? <Button variant="secondary" className={s.trigger} onPress={() => void showInvite()}>拉人进群</Button>
      : <Popover isOpen={open} onOpenChange={setOpen}>
        <Button variant="ghost" className={s.trigger} aria-label={`群成员 ${members.length} 人，打开成员名单`}>{avatars}</Button>
        <Popover.Content placement="bottom end" offset={8} className={s.popover}>
          <TianshuPortalTheme>
            <Popover.Dialog className={s.panel} aria-label="群成员">
              <strong>群成员</strong>
              <ul>{members.map((person) => <li key={person.personId}><span className={s.avatar} aria-hidden>{person.displayName.slice(0, 1)}</span>{person.displayName}{person.personId === viewerId ? "（你）" : ""}</li>)}</ul>
              {error ? <p className={s.error} role="alert">{error}</p> : null}
              <div className={s.actions}>
                <Button variant="ghost" isDisabled={busy} onPress={() => void leave()}>退出群聊</Button>
                <Button variant="primary" isDisabled={busy} onPress={() => void showInvite()}>拉人进群</Button>
              </div>
            </Popover.Dialog>
          </TianshuPortalTheme>
        </Popover.Content>
      </Popover>}
    {inviteOnly && error && !inviting ? <p className={s.error} role="alert">{error}</p> : null}
    <Modal isOpen={inviting} onOpenChange={(next) => { if (!next) closeInvite(); }}>
      <Modal.Backdrop isDismissable>
        <Modal.Container>
          <Modal.Dialog className={s.dialog} aria-label="拉人进群">
            <Modal.CloseTrigger />
            <Modal.Header><Modal.Heading>拉人进群</Modal.Heading></Modal.Header>
            <Modal.Body>
              <p className={s.muted}>被拉进来的人能看到之前的全部聊天。可以写一句为什么，Co-Agent 会用它给新人介绍来龙去脉。</p>
              <div className={s.people} role="group" aria-label="选择同事">{people.map((person) => <label key={person.personId}><input type="checkbox" checked={selected.includes(person.personId)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, person.personId] : current.filter((id) => id !== person.personId))} />{person.displayName}</label>)}</div>
              {people.length === 0 ? <p className={s.muted}>暂无可邀请的同事。</p> : null}
              <textarea className={s.note} value={note} maxLength={200} rows={3} placeholder="为什么拉他们进来（可选）" aria-label="为什么拉他们进来" onChange={(event) => setNote(event.target.value)} />
              {error ? <p className={s.error} role="alert">{error}</p> : null}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onPress={closeInvite}>取消</Button>
              <Button variant="primary" isDisabled={busy || !selected.length} onPress={() => void add()}>{busy ? "正在拉人…" : "拉进群"}</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
    {dialog}
  </div>;
}
