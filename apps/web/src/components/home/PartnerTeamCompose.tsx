"use client";

import { useState } from "react";
import { Modal } from "@heroui/react";
import { RefreshCw, X } from "lucide-react";
import type { TRequestPerson, TSendTeamDeliveryRequest } from "@warmap/contracts";
import { HeroButton } from "@/components/HeroButton";
import { DateTimePicker } from "@/components/ui/DatePicker";
import { fromPickerValue } from "@/components/collections/collectionApi";
import { publicLink, type TeamKind } from "@/lib/home/teamIntent";
import { emptyTeamFiles, TeamFilePicker, type TeamFiles } from "./PartnerTeamFiles";
import h from "@/styles/home.module.css";
import s from "./partnerTeam.module.css";

export type TeamDraft = TeamFiles & {
  clientId: string;
  kind: TeamKind;
  recipientIds: string[];
  text: string;
  sourceUrl: string;
  dueAt: string;
  original: string;
  unresolved: string[];
  error: string;
};

export const newTeamDraft = (kind: TeamKind = "share"): TeamDraft => ({
  ...emptyTeamFiles(), clientId: crypto.randomUUID(), kind, recipientIds: [], text: "", sourceUrl: "", dueAt: "", original: "", unresolved: [], error: "",
});

export function draftPayload(draft: TeamDraft): TSendTeamDeliveryRequest | null {
  const text = draft.text.trim();
  const link = draft.sourceUrl.trim();
  if (!draft.recipientIds.length || draft.recipientIds.length > 50 || (link && !publicLink(link))) return null;
  if (!text && (draft.kind === "question" || !(link || draft.files.length || draft.sources.length))) return null;
  return {
    clientId: draft.clientId, kind: draft.kind, recipientIds: draft.recipientIds,
    ...(text ? { text } : {}), ...(link ? { sourceUrl: link } : {}),
    ...(draft.kind === "question" && draft.dueAt ? { dueAt: fromPickerValue(draft.dueAt) } : {}),
    ...(draft.sources.length ? { sourceAttachments: draft.sources.map(({ id, sha256 }) => ({ id, sha256 })) } : {}),
  };
}

export function TeamCompose({ draft, people, directoryError, onDirectory, busy, onChange, onSend, onClose, onWeekly }: {
  draft: TeamDraft; people: TRequestPerson[] | null; directoryError: string; onDirectory: () => void;
  busy: boolean; onChange: (patch: Partial<TeamDraft>) => void; onSend: () => void; onClose: () => void; onWeekly: (prompt: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [fixed, setFixed] = useState(false);
  const question = draft.kind === "question";
  const shown = (people ?? []).filter((person) => (person.displayName + " " + person.personId).toLocaleLowerCase().includes(query.trim().toLocaleLowerCase()));
  const selected = new Set(draft.recipientIds);
  const duplicateNames = new Set(people?.map((person) => person.displayName).filter((name, index, names) => names.indexOf(name) !== index));
  const valid = Boolean(draftPayload(draft));
  const toggle = (id: string) => onChange({ recipientIds: selected.has(id) ? draft.recipientIds.filter((item) => item !== id) : [...draft.recipientIds, id], unresolved: [] });
  const title = fixed ? "固定收集" : question ? "向同事征集信息" : "发给同事";
  return (
    <Modal isOpen onOpenChange={(open) => { if (!open && !busy) onClose(); }}>
      <Modal.Backdrop className={h.dialogBackdrop} isDismissable={!busy} isKeyboardDismissDisabled={busy}>
        <Modal.Container size="md">
          <Modal.Dialog className={s.dialog} aria-label={title}>
            <header className={s.heading}><h2>{title}</h2><button type="button" className={s.icon} aria-label="关闭同事收发" disabled={busy} onClick={onClose}><X size={16} aria-hidden /></button></header>
            <div role="group" aria-label="发送意图" className={s.modes}>
              <button type="button" disabled={busy} aria-pressed={!fixed && !question} onClick={() => { setFixed(false); if (question) onChange({ kind: "share" }); }}>分享资料</button>
              <button type="button" disabled={busy} aria-pressed={!fixed && question} onClick={() => { setFixed(false); if (!question) onChange({ kind: "question" }); }}>临时征集</button>
              <button type="button" disabled={busy} aria-pressed={fixed} onClick={() => setFixed(true)}>固定收集</button>
            </div>
            {fixed ? <div className={s.fixedChoice}>
              <button type="button" className={s.secondary} onClick={() => onWeekly("请发起每周开销收集")}>起草每周开销收集</button>
              <button type="button" className={s.secondary} onClick={() => onWeekly("请发起每周进展收集")}>起草每周进展收集</button>
              <a href="/me/schedules">查看已有定时收集</a>
            </div> : <form className={s.form} onSubmit={(event) => { event.preventDefault(); if (!busy && valid) onSend(); }}>
              {draft.original ? <details className={s.original}><summary>我的原话</summary><p>{draft.original}</p></details> : null}
              <fieldset className={s.people} disabled={busy}>
                <legend>{"收件人" + (selected.size ? " · 已选 " + selected.size + " 人" : "")}</legend>
                <input type="search" className={s.field} aria-label="搜索同事姓名或成员 ID" placeholder="搜索同事姓名或成员 ID" value={query} onChange={(event) => setQuery(event.target.value)} />
                {draft.unresolved.length ? <p className={s.note}>请在名册中核对「{draft.unresolved.join("、")}」的收件人。</p> : null}
                {directoryError ? <p role="alert" className={s.error}>{directoryError} <button type="button" className={s.linkButton} onClick={onDirectory}><RefreshCw size={12} aria-hidden />重试</button></p>
                  : !people ? <small role="status">正在读取同事名册…</small>
                  : !shown.length ? <small>{query ? "没有找到匹配的同事" : "名册中没有可选的同事"}</small>
                  : <div className={s.choices}>{shown.map((person) => <label key={person.personId} className={s.choice}>
                    <input type="checkbox" checked={selected.has(person.personId)} disabled={busy || (!selected.has(person.personId) && selected.size >= 50)} onChange={() => toggle(person.personId)} />
                    <span>{person.displayName}{duplicateNames.has(person.displayName) ? <small> · {person.personId}</small> : null}</span>
                  </label>)}</div>}
                {selected.size ? <p className={s.note}>发给 {(people ?? []).filter((person) => selected.has(person.personId)).map((person) => duplicateNames.has(person.displayName) ? person.displayName + "（" + person.personId + "）" : person.displayName).join("、")}</p> : null}
              </fieldset>
              <label className={s.label}>{question ? "需要同事回复的问题" : "正文或随附说明"}
                <textarea className={s.field} rows={3} maxLength={20_000} value={draft.text} required={question} disabled={busy}
                  placeholder={question ? "请说明想知道什么，或需要哪些材料" : "可以只发送文件或链接"}
                  onChange={(event) => onChange({ text: event.target.value })} />
              </label>
              <label className={s.label}>来源链接（选填）
                <input className={s.field} type="url" maxLength={2048} placeholder="https://" value={draft.sourceUrl} disabled={busy} onChange={(event) => onChange({ sourceUrl: event.target.value })} />
              </label>
              {draft.sourceUrl.trim() && !publicLink(draft.sourceUrl.trim()) ? <p className={s.error}>请填写 http 或 https 来源链接</p> : null}
              {question ? <div className={s.label}>回复截止（选填，北京时间）
                <DateTimePicker label="回复截止" value={draft.dueAt} onChange={(dueAt) => onChange({ dueAt })} disabled={busy} size="compact" placeholder="选择日期" />
                {draft.dueAt ? <button type="button" className={s.linkButton} disabled={busy} onClick={() => onChange({ dueAt: "" })}>清除截止时间</button> : null}
              </div> : null}
              <TeamFilePicker selection={draft} onChange={onChange} disabled={busy} />
              {draft.error ? <p className={s.error} role="alert">{draft.error}</p> : null}
              <footer className={s.actions}><HeroButton type="button" variant="tertiary" isDisabled={busy} onPress={onClose}>取消</HeroButton>
                <HeroButton type="submit" variant="primary" isDisabled={busy || !valid || !people}>{busy ? "正在发送…" : question ? "发送征集" : "发送资料"}</HeroButton></footer>
            </form>}
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}
