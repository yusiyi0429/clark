"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ExternalLink, FileText, Forward, MessageSquare, Repeat2, Send } from "lucide-react";
import type { TReplyTeamDeliveryRequest, TRequestListItem, TTeamDelivery, TTeamDeliveryAttachment, TTeamDeliveryRecipient, TTeamDeliveryReply } from "@warmap/contracts";
import { monthDayTime } from "@/lib/companyTime";
import { sizeText } from "@/lib/home/attachments";
import { publicLink } from "@/lib/home/teamIntent";
import { askTeamOwner, markCorrectionSeen, replyTeamDelivery, retryRecipient, retryTeamBuddy, reviewBuddyReply, teamError } from "@/lib/home/teamDelivery";
import { emptyTeamFiles, TeamFilePicker, type TeamFiles } from "./PartnerTeamFiles";
import s from "./partnerTeam.module.css";

export type TeamForward = { text: string; sourceUrl?: string; recipientIds?: string[] };
const STATUS: Record<TTeamDeliveryRecipient["status"], string> = { pending: "已送达 · 待回复", delivered: "已送达", needs_info: "需补充", answered: "已回复", failed: "送达失败" };
const REPLY_LABEL: Record<TTeamDeliveryReply["status"], string> = { needs_info: "需要补充或澄清", answered: "回复", clarification: "补充说明", follow_up: "追问" };
export const teamAnchor = (id: string) => "team-request-" + id;

/** 伙伴那条答复上的标记。who 是被问的人的名字，自己看时传「你」。 */
export function buddyLabel(who: string, state: "unseen" | "seen" | "corrected"): string {
  return who + "的伙伴答的，" + who + (state === "corrected" ? "改过" : state === "seen" ? "看过了" : "还没看");
}

/** 收件人那一行的状态词；now 是毫秒。 */
export function recipientWord(person: TTeamDeliveryRecipient, now: number): string {
  if (person.status === "pending" && person.buddy?.state === "answering") {
    const seconds = Math.max(0, Math.floor((now - Date.parse(person.buddy.askedAt)) / 1000));
    return "伙伴在答 · " + (seconds < 60 ? seconds + " 秒" : Math.floor(seconds / 60) + " 分 " + (seconds % 60) + " 秒");
  }
  if (person.status === "pending" && person.buddy?.state === "handoff") return "转本人 · 待回复";
  return STATUS[person.status];
}

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
      clientId, status: kind, ...(kind === "clarification" || kind === "follow_up" ? { recipientId } : {}), ...(text.trim() ? { text: text.trim() } : {}),
      ...(selection.sources.length ? { sourceAttachments: selection.sources.map(({ id, sha256 }) => ({ id, sha256 })) } : {}),
    };
    try { onSaved(await replyTeamDelivery(deliveryId, body, selection.files)); onClose(); }
    catch (cause) { setError(teamError(cause, "回复没能送达，请重试")); }
    finally { locked.current = false; setBusy(false); }
  };
  return <form className={s.replyForm} aria-label={REPLY_LABEL[kind]} onSubmit={(event) => { event.preventDefault(); void submit(); }}
    onKeyDown={(event) => { if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); } }}>
    <label htmlFor={fieldId} className={s.label}>{kind === "needs_info" ? "还缺什么，或想请对方澄清什么？" : kind === "clarification" ? "给这位同事的补充说明" : kind === "follow_up" ? "追问" : "你的回复"}
      <textarea id={fieldId} autoFocus className={s.field} rows={3} maxLength={20_000} disabled={busy} value={text} onChange={(event) => { changed(); setText(event.target.value); }} />
    </label>
    {kind === "follow_up" ? null : <TeamFilePicker selection={selection} disabled={busy} onChange={(next) => { changed(); setSelection(next); }} />}
    {error ? <p className={s.error} role="alert">{error}</p> : null}
    <div className={s.actions}><button type="button" className={s.linkButton} disabled={busy} onClick={onClose}>取消</button>
      <button type="submit" className={s.primary} disabled={busy || !canSubmit}>{busy ? "正在发送" : kind === "answered" ? "提交回复" : kind === "needs_info" ? "请求补充" : kind === "follow_up" ? "追问" : "发送说明"}</button></div>
  </form>;
}

/** 被问的人「改一下」：一个输入框，提交是一条更正；没成重试用同一个 clientId。 */
function CorrectionForm({ deliveryId, replyId, onSaved, onClose }: { deliveryId: string; replyId: string; onSaved: (item: TTeamDelivery) => void; onClose: () => void }) {
  const [text, setText] = useState("");
  const [clientId, setClientId] = useState(() => crypto.randomUUID());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const locked = useRef(false);
  const fieldId = useId();
  const submit = async () => {
    if (locked.current || !text.trim()) return;
    locked.current = true; setBusy(true); setError("");
    try { onSaved(await reviewBuddyReply(deliveryId, replyId, { clientId, verdict: "corrected", text: text.trim() })); onClose(); }
    catch (cause) { setError(teamError(cause, "更正没能送达，请重试")); }
    finally { locked.current = false; setBusy(false); }
  };
  return <form className={s.replyForm} aria-label="更正" onSubmit={(event) => { event.preventDefault(); void submit(); }}
    onKeyDown={(event) => { if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.preventDefault(); event.stopPropagation(); if (!busy) onClose(); } }}>
    <label htmlFor={fieldId} className={s.label}>更正
      <textarea id={fieldId} autoFocus className={s.field} rows={3} maxLength={20_000} disabled={busy} value={text}
        onChange={(event) => { setClientId(crypto.randomUUID()); setError(""); setText(event.target.value); }} />
    </label>
    {error ? <p className={s.error} role="alert">{error}</p> : null}
    <div className={s.actions}><button type="button" className={s.linkButton} disabled={busy} onClick={onClose}>取消</button>
      <button type="submit" className={s.primary} disabled={busy || !text.trim()}>{busy ? "正在发送" : "提交"}</button></div>
  </form>;
}

function Recipient({ delivery, person, sent, onSaved, onForward }: {
  delivery: TTeamDelivery; person: TTeamDeliveryRecipient; sent: boolean; onSaved: (item: TTeamDelivery) => void; onForward: (content: TeamForward) => void;
}) {
  const [writing, setWriting] = useState<TTeamDeliveryReply["status"] | null>(null);
  const [correcting, setCorrecting] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [acting, setActing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const retry = async () => {
    if (retrying) return;
    setRetrying(true); setError("");
    try { onSaved(await retryRecipient(delivery.id, person.personId)); }
    catch (cause) { setError(teamError(cause, "投递重试失败")); }
    finally { setRetrying(false); }
  };
  // 伙伴那几个按钮（重试、问本人、没问题、知道了）：同一时间只做一件，没成写在失败行。
  const act = async (key: string, call: () => Promise<TTeamDelivery>, fallback: string) => {
    if (acting) return;
    setActing(key); setError("");
    try { onSaved(await call()); }
    catch (cause) { setError(teamError(cause, fallback)); }
    finally { setActing(null); }
  };
  const question = delivery.kind === "question";
  const buddy = person.buddy;
  const corrected = new Set(person.replies.flatMap((reply) => reply.corrects ? [reply.corrects] : []));
  const latestBuddy = person.replies.filter((reply) => reply.origin === "buddy").at(-1);
  const who = sent ? person.displayName : "你";
  const heading = (reply: TTeamDeliveryReply) => reply.origin === "buddy" ? buddyLabel(who, corrected.has(reply.id) ? "corrected" : reply.reviewedAt ? "seen" : "unseen")
    : reply.corrects ? person.displayName + " · 更正"
    : (reply.status === "clarification" || reply.status === "follow_up" ? delivery.sender.displayName : person.displayName) + " · " + REPLY_LABEL[reply.status];
  const note = person.status === "pending" && buddy?.note && (buddy.state === "handoff" || (sent && (buddy.state === "failed" || buddy.state === "limited"))) ? buddy.note : null;
  return <li className={s.person}>
    <div className={s.personHeading}><strong>{sent ? person.displayName : "我的进度"}</strong>
      <span className={s.status} data-failed={person.status === "failed" || undefined}>{recipientWord(person, Date.now())}</span></div>
    {note ? <p className={s.note}>{note}</p> : null}
    {person.error ? <p className={s.error}>{person.error}</p> : null}
    {error ? <p className={s.error} role="alert">{error}</p> : null}
    {sent && person.status === "failed" ? <button className={s.linkButton} type="button" disabled={retrying} onClick={() => void retry()}>{retrying ? "正在重试" : "重试给" + person.displayName + "的投递"}</button> : null}
    {writing ? <ReplyForm key={writing} deliveryId={delivery.id} recipientId={person.personId} kind={writing} onSaved={onSaved} onClose={() => setWriting(null)} /> :
      question && person.status !== "failed" ? <div className={s.rowTools}>
        {!sent ? <>
          <button type="button" className={s.secondary} onClick={() => setWriting("answered")}>{person.status === "answered" ? "追加回复" : "回复"}</button>
          <button type="button" className={s.linkButton} onClick={() => setWriting("needs_info")}>缺材料或需澄清</button>
        </> : <>
          {person.status === "needs_info" ? <button type="button" className={s.secondary} onClick={() => setWriting("clarification")}>给{person.displayName}补充说明</button> : null}
          {latestBuddy && buddy?.state !== "answering" && !(buddy?.state === "handoff" && person.status === "pending") ? <button type="button" className={s.secondary} onClick={() => setWriting("follow_up")}>追问</button> : null}
          {buddy?.state === "failed" ? <button type="button" className={s.secondary} disabled={!!acting}
            onClick={() => void act("retry", () => retryTeamBuddy(delivery.id, person.personId), "重试没有成功，请再试一次")}>{acting === "retry" ? "正在重试" : "重试"}</button> : null}
          {buddy?.state === "failed" || buddy?.state === "limited" ? <button type="button" className={s.linkButton} disabled={!!acting}
            onClick={() => void act("owner", () => askTeamOwner(delivery.id, person.personId), "没有转给本人，请重试")}>问本人</button> : null}
        </>}
      </div> : null}
    {person.replies.length ? <details className={s.history} open={latestBuddy ? true : undefined}>
      <summary className={s.historySummary}>{person.replies.length} 条往来<span>查看回复与附件</span></summary>
      <ol className={s.replies} aria-label={person.displayName + "的往来"}>
        {person.replies.map((reply) => <li key={reply.id} id={"team-reply-" + reply.id} tabIndex={-1}>
          <div className={s.replyHead}><b>{heading(reply)}</b><Clock at={reply.createdAt} /></div>
          {reply.text ? <p className={s.body}>{reply.text}</p> : null}
          <Attachments files={reply.attachments} />
          {sent && reply.status !== "clarification" && reply.text.trim() ? <button type="button" className={s.linkButton} onClick={() => onForward({ text: reply.text })}><Forward size={14} aria-hidden />转发这条回复</button> : null}
          {sent && reply.corrects && !reply.correctionSeenAt ? <button type="button" className={s.secondary} disabled={!!acting}
            onClick={() => void act("seen", () => markCorrectionSeen(delivery.id, reply.id), "没有记上，请重试")}>知道了</button> : null}
          {!sent && reply.id === latestBuddy?.id && !corrected.has(reply.id) ? correcting
            ? <CorrectionForm deliveryId={delivery.id} replyId={reply.id} onSaved={onSaved} onClose={() => setCorrecting(false)} />
            : <div className={s.rowTools}>
              {!reply.reviewedAt && buddy?.state !== "handoff" ? <button type="button" className={s.secondary} disabled={!!acting}
                onClick={() => void act("ok", () => reviewBuddyReply(delivery.id, reply.id, { verdict: "ok" }), "没有提交上，请重试")}>没问题</button> : null}
              <button type="button" className={s.linkButton} onClick={() => setCorrecting(true)}>改一下</button>
            </div> : null}
        </li>)}
      </ol>
    </details> : null}
  </li>;
}

export function TeamDeliveryCard({ delivery, sent, onSaved, onForward }: {
  delivery: TTeamDelivery; sent: boolean; onSaved: (item: TTeamDelivery) => void; onForward: (content: TeamForward) => void;
}) {
  const card = useRef<HTMLElement>(null);
  const locatedReply = useRef<string | null>(null);
  // Reply lists can arrive after hydration. Data updates retry unresolved targets only.
  const replyIds = delivery.recipients.flatMap((person) => person.replies.map((reply) => reply.id)).join("\n");
  useEffect(() => {
    let frame: number | undefined;
    const locateReply = () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      let anchor: string;
      try { anchor = decodeURIComponent(window.location.hash.slice(1)); }
      catch { return; }
      if (!anchor.startsWith("team-reply-")) return;
      if (locatedReply.current === anchor) return;
      const target = document.getElementById(anchor);
      if (!target || !card.current?.contains(target)) return;
      // A surrounding timeline may also use disclosures; open every ancestor before scrolling.
      for (let parent = target.parentElement; parent; parent = parent.parentElement) {
        if (parent.tagName === "DETAILS") (parent as HTMLDetailsElement).open = true;
      }
      frame = window.requestAnimationFrame(() => {
        target.focus({ preventScroll: true }); target.scrollIntoView({ block: "center" });
        locatedReply.current = anchor;
      });
    };
    const navigate = () => { locatedReply.current = null; locateReply(); };
    locateReply();
    window.addEventListener("hashchange", navigate);
    return () => {
      if (frame !== undefined) window.cancelAnimationFrame(frame);
      window.removeEventListener("hashchange", navigate);
    };
  }, [delivery.id, replyIds]);
  // 有收件人「伙伴在答」时每秒重画一次，状态词里的秒数跟着走；不在答不起定时器。
  const answering = delivery.recipients.some((person) => person.status === "pending" && person.buddy?.state === "answering");
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!answering) return;
    const timer = window.setInterval(() => setTick((tick) => tick + 1), 1_000);
    return () => window.clearInterval(timer);
  }, [answering]);
  const question = delivery.kind === "question";
  const title = (sent ? "我" : delivery.sender.displayName) + (question ? "发起的征集" : "分享的资料");
  const source = delivery.sourceUrl && publicLink(delivery.sourceUrl);
  const askAccess = (name: string) => onForward({ recipientIds: [delivery.sender.personId], text: "请给我一份可以打开的「" + name + "」。" });
  return <article ref={card} id={teamAnchor(delivery.id)} tabIndex={-1} className={s.card} aria-label={title}>
    <header className={s.cardHead}>{question ? <MessageSquare size={16} aria-hidden /> : <Send size={16} aria-hidden />}<h3>{title}</h3><Clock at={delivery.createdAt} /></header>
    {delivery.text ? <p className={s.body}>{delivery.text}</p> : null}
    {source ? <div className={s.source}><a href={source} target="_blank" rel="noreferrer"><ExternalLink size={13} aria-hidden />{source}</a>
      {!sent ? <button className={s.linkButton} type="button" onClick={() => askAccess("来源资料")}>向发送人申请可读版本</button> : null}</div> : null}
    {delivery.attachments.length ? <details className={s.history}>
      <summary className={s.historySummary}>附件 · {delivery.attachments.length}<span>打开原文件</span></summary>
      <Attachments files={delivery.attachments} onAccess={sent ? undefined : askAccess} />
    </details> : null}
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
