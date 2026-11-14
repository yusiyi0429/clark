"use client";

import { useId, useRef, useState } from "react";
import { ExternalLink, FileText, Forward, MessageSquare, Repeat2, Send } from "lucide-react";
import type { TReplyTeamDeliveryRequest, TRequestListItem, TTeamDelivery, TTeamDeliveryAttachment, TTeamDeliveryRecipient, TTeamDeliveryReply } from "@warmap/contracts";
import { monthDayTime } from "@/lib/companyTime";
import { sizeText } from "@/lib/home/attachments";
import { publicLink } from "@/lib/home/teamIntent";
import { replyTeamDelivery, retryRecipient, teamError } from "@/lib/home/teamDelivery";
import { emptyTeamFiles, TeamFilePicker, type TeamFiles } from "./PartnerTeamFiles";
import s from "./partnerTeam.module.css";

export type TeamForward = { text: string; sourceUrl?: string; recipientIds?: string[] };
const STATUS: Record<TTeamDeliveryRecipient["status"], string> = { pending: "已送达 · 待回复", delivered: "已送达", needs_info: "需补充", answered: "已回复", failed: "送达失败" };
const REPLY_LABEL: Record<TTeamDeliveryReply["status"], string> = { needs_info: "需要补充或澄清", answered: "回复", clarification: "补充说明" };
export const teamAnchor = (id: string) => "team-request-" + id;

function Clock({ at }: { at: string }) {
  return <time dateTime={at} title={at}>{monthDayTime(at)}</time>;
}

function Attachments({ files, onAccess }: { files: TTeamDeliveryAttachment[]; onAccess?: (fileName: string) => void }) {
  const [failure, setFailure] = useState<{ id: string; text: string } | null>(null);
  const [loading, setLoading] = useState<string | null>(null);
  if (!files.length) return null;
  const open = async (file: TTeamDeliveryAttachment) => {
    setLoading(file.id); setFailure(null);
    try {
      const response = await fetch(file.href, { cache: "no-store" });
      if (response.status === 401) { window.location.assign("/access"); return; }
      if (!response.ok) {
        const fallback = response.status === 404 || response.status === 403 ? "目前无法读取这个文件版本" : "文件没有打开，请重试";
        throw new Error((await response.json().catch(() => undefined))?.message || fallback);
      }
      const url = URL.createObjectURL(await response.blob());
      const download = document.createElement("a");
      download.href = url; download.download = file.fileName;
      document.body.append(download); download.click(); download.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    } catch (cause) { setFailure({ id: file.id, text: teamError(cause, "文件没有打开，请重试") }); }
    finally { setLoading(null); }
  };
  return <ul className={s.fileList} aria-label="可打开的附件">{files.map((file) => <li key={file.id}>
    <div className={s.attachment}>
      <a href={file.href} download={file.fileName} aria-busy={loading === file.id} onClick={(event) => {
        if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
        event.preventDefault(); if (!loading) void open(file);
      }}><FileText size={14} aria-hidden /><span>{file.fileName}</span></a>
      <small>{sizeText(file.size)} · 版本 {file.sha256.slice(0, 8)}</small>
      {failure?.id === file.id ? <p role="alert" className={s.error}>{failure.text}{" "}
        {onAccess ? <button type="button" className={s.linkButton} onClick={() => onAccess(file.fileName)}>向发送人索取文件</button> : null}</p> : null}
    </div>
  </li>)}</ul>;
}

function ReplyForm({ deliveryId, recipientId, kind, onSaved, onClose }: {
  deliveryId: string; recipientId: string; kind: TTeamDeliveryReply["status"]; onSaved: (item: TTeamDelivery) => void; onClose: () => void;
}) {
  const [text, setText] = useState("");
  const [selection, setSelection] = useState<TeamFiles>(emptyTeamFiles);
  const [clientId, setClientId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const locked = useRef(false);
  const fieldId = useId();
  const changed = () => { setClientId(crypto.randomUUID()); setError(""); };
  const canSubmit = !!(text.trim() || selection.files.length || selection.sources.length);
  const submit = async () => {
    if (locked.current || !canSubmit) return;
    locked.current = true; setBusy(true); setError("");
    const body: TReplyTeamDeliveryRequest = {
      clientId, status: kind, ...(kind === "clarification" ? { recipientId } : {}), ...(text.trim() ? { text: text.trim() } : {}),
      ...(selection.sources.length ? { sourceAttachments: selection.sources.map(({ id, sha256 }) => ({ id, sha256 })) } : {}),
    };
    try { onSaved(await replyTeamDelivery(deliveryId, body, selection.files)); onClose(); }
    catch (cause) { setError(teamError(cause, "回复没能送达，请重试")); }
    finally { locked.current = false; setBusy(false); }
  };
  return <form className={s.replyForm} aria-label={REPLY_LABEL[kind]} onSubmit={(event) => { event.preventDefault(); void submit(); }}
    onKeyDown={(event) => { if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); } }}>
    <label htmlFor={fieldId} className={s.label}>{kind === "needs_info" ? "还缺什么，或想请对方澄清什么？" : kind === "clarification" ? "给这位同事的补充说明" : "你的回复"}
      <textarea id={fieldId} autoFocus className={s.field} rows={3} maxLength={20_000} disabled={busy} value={text} onChange={(event) => { changed(); setText(event.target.value); }} />
    </label>
    <TeamFilePicker selection={selection} disabled={busy} onChange={(next) => { changed(); setSelection(next); }} />
    {error ? <p className={s.error} role="alert">{error}</p> : null}
    <div className={s.actions}><button type="button" className={s.linkButton} disabled={busy} onClick={onClose}>取消</button>
      <button type="submit" className={s.primary} disabled={busy || !canSubmit}>{busy ? "正在发送…" : kind === "answered" ? "提交回复" : kind === "needs_info" ? "请求补充" : "发送说明"}</button></div>
  </form>;
}

function Recipient({ delivery, person, sent, onSaved, onForward }: {
  delivery: TTeamDelivery; person: TTeamDeliveryRecipient; sent: boolean; onSaved: (item: TTeamDelivery) => void; onForward: (content: TeamForward) => void;
}) {
  const [writing, setWriting] = useState<TTeamDeliveryReply["status"] | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [error, setError] = useState("");
  const retry = async () => {
    if (retrying) return;
    setRetrying(true); setError("");
    try { onSaved(await retryRecipient(delivery.id, person.personId)); }
    catch (cause) { setError(teamError(cause, "投递重试失败")); }
    finally { setRetrying(false); }
  };
  const question = delivery.kind === "question";
  return <li className={s.person}>
    <div className={s.personHeading}><strong>{sent ? person.displayName : "我的进度"}</strong>
      <span className={s.status} data-failed={person.status === "failed" || undefined}>{STATUS[person.status]}</span></div>
    {person.error ? <p className={s.error}>{person.error}</p> : null}
    {error ? <p className={s.error} role="alert">{error}</p> : null}
    {sent && person.status === "failed" ? <button className={s.linkButton} type="button" disabled={retrying} onClick={() => void retry()}>{retrying ? "正在重试…" : "重试给" + person.displayName + "的投递"}</button> : null}
    {person.replies.length ? <ol className={s.replies} aria-label={person.displayName + "的往来"}>
      {person.replies.map((reply) => <li key={reply.id} id={"team-reply-" + reply.id}>
        <div className={s.replyHead}><b>{reply.status === "clarification" ? delivery.sender.displayName : person.displayName} · {REPLY_LABEL[reply.status]}</b><Clock at={reply.createdAt} /></div>
        {reply.text ? <p className={s.body}>{reply.text}</p> : null}
        <Attachments files={reply.attachments} />
        {sent && reply.status !== "clarification" && reply.text.trim() ? <button type="button" className={s.linkButton} onClick={() => onForward({ text: reply.text })}><Forward size={14} aria-hidden />转发这条回复</button> : null}
      </li>)}
    </ol> : null}
    {writing ? <ReplyForm key={writing} deliveryId={delivery.id} recipientId={person.personId} kind={writing} onSaved={onSaved} onClose={() => setWriting(null)} /> :
      question && person.status !== "failed" ? <div className={s.rowTools}>
        {!sent ? <>
          <button type="button" className={s.secondary} onClick={() => setWriting("answered")}>{person.status === "answered" ? "追加回复" : "回复"}</button>
          <button type="button" className={s.linkButton} onClick={() => setWriting("needs_info")}>缺材料或需澄清</button>
        </> : person.status === "needs_info" ? <button type="button" className={s.secondary} onClick={() => setWriting("clarification")}>给{person.displayName}补充说明</button> : null}
      </div> : null}
  </li>;
}

export function TeamDeliveryCard({ delivery, sent, onSaved, onForward }: {
  delivery: TTeamDelivery; sent: boolean; onSaved: (item: TTeamDelivery) => void; onForward: (content: TeamForward) => void;
}) {
  const question = delivery.kind === "question";
  const title = (sent ? "我" : delivery.sender.displayName) + (question ? "发起的征集" : "分享的资料");
  const source = delivery.sourceUrl && publicLink(delivery.sourceUrl);
  const askAccess = (name: string) => onForward({ recipientIds: [delivery.sender.personId], text: "请给我一份可以打开的「" + name + "」。" });
  return <article id={teamAnchor(delivery.id)} tabIndex={-1} className={s.card} aria-label={title}>
    <header className={s.cardHead}>{question ? <MessageSquare size={16} aria-hidden /> : <Send size={16} aria-hidden />}<h3>{title}</h3><Clock at={delivery.createdAt} /></header>
    {delivery.text ? <p className={s.body}>{delivery.text}</p> : null}
    {source ? <div className={s.source}><a href={source} target="_blank" rel="noreferrer"><ExternalLink size={13} aria-hidden />{source}</a>
      {!sent ? <button className={s.linkButton} type="button" onClick={() => askAccess("来源资料")}>向发送人申请可读版本</button> : null}</div> : null}
    <Attachments files={delivery.attachments} onAccess={sent ? undefined : askAccess} />
    {delivery.dueAt ? <p className={s.note}>回复截止 <Clock at={delivery.dueAt} />（北京时间）</p> : null}
    {sent || question ? <ul className={s.recipients} aria-label="按收件人查看进度">{delivery.recipients.map((p) =>
      <Recipient key={p.personId} delivery={delivery} person={p} sent={sent} onSaved={onSaved} onForward={onForward} />)}</ul> : null}
    {!sent && !question && (delivery.text || source) ? <button type="button" className={s.linkButton}
      onClick={() => onForward({ text: delivery.text, ...(source ? { sourceUrl: source } : {}) })}><Forward size={14} aria-hidden />转发文字和来源</button> : null}
  </article>;
}

/** 保留固定收集原轮次（表头、成员自己的一行、确认和汇总都在原页）。 */
export function CollectionRoundCard({ item, sent }: { item: TRequestListItem; sent: boolean }) {
  const state = sent ? "已确认 " + item.recipientsDone + "/" + item.recipientNames.length : item.myStatus === "done" ? "已确认"
    : item.fieldsFilled ? "已填 " + item.fieldsFilled.filled + "/" + item.fieldsFilled.required + " 栏 · 待确认" : "待填写";
  return <article className={s.card} aria-label={"固定收集：" + item.title}>
    <header className={s.cardHead}><Repeat2 size={16} aria-hidden /><h3>{item.title}</h3><Clock at={item.sentAt ?? item.createdAt} /></header>
    <p className={s.note}>固定收集 · {sent ? "我发起" : item.initiatorName + "发起"} · {state}</p>
    <a className={s.linkButton} href={"/me/requests/" + encodeURIComponent(item.id)}>{sent ? "查看本轮汇总" : item.myStatus === "done" ? "查看已确认的内容" : "填写并确认本轮收集"}</a>
  </article>;
}
