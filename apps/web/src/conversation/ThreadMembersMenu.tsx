"use client";

import { useState } from "react";
import { Modal } from "@heroui/react";
import { UserPlus } from "lucide-react";
import { Button, Popover } from "ts-design/primitives";
import { TianshuPortalTheme } from "ts-design";
import { browserApi } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { useConfirm } from "@/components/ConfirmDialog";
import { showWorkspaceToast } from "@/lib/toast";
import s from "@/styles/thread-members.module.css";

type ObjectType = "issue" | "meeting" | "task";

/** 拉人成功后的一行提示：写清拉了谁、进了哪个群。 */
export function inviteDoneText(objectType: ObjectType, names: string[]): string {
  const group = objectType === "issue" ? "议题群聊" : objectType === "meeting" ? "会议群聊" : "事项群组";
  const who = names.length > 3 ? `${names.slice(0, 3).join("、")}等 ${names.length} 人` : names.join("、");
  return who ? `已邀请${who}加入${group}` : `已更新${group}成员`;
}
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
      if (!data) return setError("可邀请名单读取失败，请重试。");
      setPeople(data.people); setOpen(false); setInviting(true);
    } catch { setError("可邀请名单读取失败，请重试。"); }
  };
  const closeInvite = () => { setInviting(false); setSelected([]); setNote(""); setError(""); };
  const add = async () => {
    if (!selected.length) return;
    setBusy(true); setError("");
    try {
      const { data, error: failure } = await browserApi.POST("/api/threads/{objectType}/{objectId}/members", {
        params: { path: { objectType, objectId } }, body: { personIds: selected, ...(note.trim() ? { note: note.trim() } : {}) },
      });
      if (!data) return setError(failure?.message ?? "邀请未成功，请重试。");
      const names = people.filter((person) => selected.includes(person.personId)).map((person) => person.displayName);
      closeInvite(); onChanged();
      window.dispatchEvent(new CustomEvent("thread-members-changed", { detail: { objectType, objectId } }));
      showWorkspaceToast({ text: inviteDoneText(objectType, names) });
    } catch { setError("邀请未成功，请重试。"); }
    finally { setBusy(false); }
  };
  const leave = async () => {
    setOpen(false);
    if (!(await ask("退出后无法查看或发送该群消息；再次受邀加入后可查看全部记录。", "退出群聊"))) return;
    setBusy(true); setError("");
    try {
      const { response, error: failure } = await browserApi.POST("/api/threads/{objectType}/{objectId}/leave", { params: { path: { objectType, objectId } } });
      if (response.status !== 204) { setError(failure?.message ?? "退出未成功，请重试。"); setOpen(true); return; }
      onChanged();
    } catch { setError("退出未成功，请重试。"); setOpen(true); }
    finally { setBusy(false); }
  };

  const avatars = <span className={s.avatars} aria-hidden>{members.slice(0, 3).map((person) => <i key={person.personId}>{person.displayName.slice(0, 1)}</i>)}</span>;
  return <div className={s.root}>
    {inviteOnly
      ? <Button variant="secondary" className={`${s.trigger} ${s.invite}`} aria-label="邀请成员" onPress={() => void showInvite()}>
        {/* 手机宽的页头里只留图标（thread-members.module.css），把宽度让给标题；读屏名不变。 */}
        <UserPlus size={18} strokeWidth={1.8} aria-hidden className={s.inviteIcon} />
        <span className={s.inviteLabel}>邀请成员</span>
      </Button>
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
                <Button variant="primary" isDisabled={busy} onPress={() => void showInvite()}>邀请成员</Button>
              </div>
            </Popover.Dialog>
          </TianshuPortalTheme>
        </Popover.Content>
      </Popover>}
    {inviteOnly && error && !inviting ? <p className={s.error} role="alert">{error}</p> : null}
    <Modal isOpen={inviting} onOpenChange={(next) => { if (!next) closeInvite(); }}>
      <Modal.Backdrop isDismissable>
        <Modal.Container>
          <Modal.Dialog className={s.dialog} aria-label="邀请成员">
            <Modal.CloseTrigger aria-label="关闭" />
            <Modal.Header><Modal.Heading>邀请成员</Modal.Heading></Modal.Header>
            <Modal.Body>
              <p className={s.muted}>新成员可查看此前的全部讨论。可填写邀请原因，Co-Agent 据此向新成员说明背景。</p>
              <div className={s.people} role="group" aria-label="选择同事">{people.map((person) => <label key={person.personId}><input type="checkbox" aria-label={person.displayName} checked={selected.includes(person.personId)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, person.personId] : current.filter((id) => id !== person.personId))} />{person.displayName}</label>)}</div>
              {people.length === 0 ? <p className={s.muted}>暂无可邀请的同事。</p> : null}
              <textarea className={s.note} value={note} maxLength={200} rows={3} placeholder="邀请原因（可选）" aria-label="邀请原因" onChange={(event) => setNote(event.target.value)} />
              {error ? <p className={s.error} role="alert">{error}</p> : null}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onPress={closeInvite}>取消</Button>
              <Button variant="primary" isDisabled={busy || !selected.length} onPress={() => void add()}>{busy ? "正在邀请…" : "确认邀请"}</Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
    {dialog}
  </div>;
}
