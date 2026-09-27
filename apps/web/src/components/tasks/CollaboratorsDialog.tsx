"use client";

import { useState } from "react";
import { Modal } from "@heroui/react";
import { Button } from "ts-design/primitives";
import type { components } from "@/lib/api/schema";
import { browserApi } from "@/lib/api/client";
import s from "./task-detail.module.css";

type Person = components["schemas"]["TaskPerson"];

export function CollaboratorsDialog({ taskId, options, isOpen, onClose, onAdded }: { taskId: string; options: Person[]; isOpen: boolean; onClose: () => void; onAdded: () => void }) {
  const [selected, setSelected] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const add = async () => {
    if (!selected.length) return;
    setBusy(true); setError("");
    try {
      const { data, error: failure } = await browserApi.POST("/api/me/tasks/{id}/collaborators", { params: { path: { id: taskId } }, body: { personIds: selected } });
      if (data) { setSelected([]); window.dispatchEvent(new Event("member-tasks-changed")); onClose(); onAdded(); }
      else setError(failure?.message ?? "邀请没发出，请重试。");
    } catch { setError("邀请没发出，请重试。"); }
    finally { setBusy(false); }
  };
  return <Modal isOpen={isOpen} onOpenChange={(open) => { if (!open) onClose(); }}><Modal.Backdrop isDismissable><Modal.Container><Modal.Dialog className={s.dialog} aria-label="邀请协作成员"><Modal.CloseTrigger /><Modal.Header><Modal.Heading>邀请协作成员</Modal.Heading></Modal.Header><Modal.Body><p>协作成员可查看任务资料，并参与群组对话。</p><div className={s.people} role="group" aria-label="选择协作成员">{options.map((person) => <label key={person.personId}><input type="checkbox" checked={selected.includes(person.personId)} onChange={(event) => setSelected((current) => event.target.checked ? [...current, person.personId] : current.filter((id) => id !== person.personId))} />{person.name}</label>)}</div>{options.length === 0 ? <p className={s.muted}>暂无可邀请的同事。</p> : null}{error ? <p className={s.error} role="alert">{error}</p> : null}</Modal.Body><Modal.Footer><Button variant="secondary" onPress={onClose}>取消</Button><Button variant="primary" isDisabled={busy || !selected.length} onPress={() => void add()}>{busy ? "邀请中…" : "加入协作与群聊"}</Button></Modal.Footer></Modal.Dialog></Modal.Container></Modal.Backdrop></Modal>;
}
