"use client";

/**
 * 对话里的会议卡（apps/api/src/meetingDraft.ts 起草，草稿整份在卡上，不落库）：名称、时间、主持人、参会人、挂到，「改」「约好」。
 * - 约好：走约会议同一个建会接口（带 draftId，同一张卡只建一场；飞书日程随建会约上），原地变成已约，带去会议页的链接。
 * - 改：打开约会议面板，草稿先填好；在面板里约好的，卡按 draftId 读回已约（meeting-changed 时再读一次）。
 * - 刷新、重放历史：按 draftId 读这张卡约好没有，读到之前两个按钮都不能点。
 * - 人名没对上、对上不止一个的排在参会人后面（虚线）；有这样的名字、没有主持人或没挂点时不能直接约，点「改」补。
 * - 挂到：成员默认挂自己的 Mission（「换」）；CEO 默认不挂，在卡上「选」（同约会议面板的 WorldAnchorPicker）。
 */
import { useEffect, useRef, useState } from "react";
import { Check } from "lucide-react";
import type { TConversationCard, TPickedWorldAnchor, TWorldAnchor, TWorldAnchorOption } from "@warmap/contracts";
import { COMPANY_TIMEZONE, companyMonth } from "@/lib/companyTime";
import { refreshWorkspace } from "@/lib/toast";
import { useWorkspace } from "@/components/shell/WorkspaceContext";
import { BOOK_ERROR } from "./MeetingBookingSheet";
import { bookMeeting, listPersonDirectory, listWorldAnchorOptions, meetingDraftStatus } from "./meetingDecisionApi";
import { WorldAnchorPicker } from "./WorldAnchorPicker";
import d from "./meeting-decisions.module.css";
import e from "@/styles/entry-cards.module.css";

type Draft = Extract<TConversationCard, { kind: "meeting_draft" }>;
type Booked = { id: string; title: string; href: string };

const clock = (iso: string) => new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: COMPANY_TIMEZONE });
/** 「10 月 27 日 周二 15:00–15:30」（公司时区）。 */
function span(startIso: string, endIso: string): string {
  const start = new Date(startIso);
  const [month, day] = start.toLocaleDateString("sv-SE", { timeZone: COMPANY_TIMEZONE }).slice(5).split("-").map(Number);
  const weekday = start.toLocaleDateString("zh-CN", { weekday: "short", timeZone: COMPANY_TIMEZONE });
  return `${month} 月 ${day} 日 ${weekday} ${clock(startIso)}–${clock(endIso)}`;
}

export function MeetingDraftCard({ card }: { card: Draft }) {
  const { navigate, viewerId, bookMeetingFrom, ceo } = useWorkspace();
  /** undefined：还在读这张卡约好没有。 */
  const [booked, setBooked] = useState<Booked | null | undefined>(undefined);
  const [anchor, setAnchor] = useState<TWorldAnchor | null>(card.anchor);
  const [picking, setPicking] = useState(false);
  const [options, setOptions] = useState<TWorldAnchorOption[] | null>(null);
  const [people, setPeople] = useState<{ personId: string; displayName: string }[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  /** 点了「约好」还没回来：连点只发一次。 */
  const sending = useRef(false);

  useEffect(() => {
    let live = true;
    const check = () => void meetingDraftStatus(card.draftId).then((meeting) => { if (live && meeting) setBooked(meeting); else if (live) setBooked((current) => current ?? null); },
      () => { if (live) setBooked((current) => current ?? null); });
    check();
    window.addEventListener("meeting-changed", check);
    return () => { live = false; window.removeEventListener("meeting-changed", check); };
  }, [card.draftId]);
  // 挑挂点时才取选项（开会那个月的）和人员名册（别人的 Mission 下面写负责人）。
  useEffect(() => {
    if (!picking || options) return;
    let live = true;
    void listWorldAnchorOptions(companyMonth(new Date(card.scheduledAt))).then((next) => { if (live) setOptions(next); }, () => { if (live) setError("没有读到对象"); });
    void listPersonDirectory().then((next) => { if (live) setPeople(next); }, () => undefined);
    return () => { live = false; };
  }, [picking, options, card.scheduledAt]);

  const host = card.host;
  const hostMissing = card.unresolved.find((item) => item.host);
  const others = card.unresolved.filter((item) => !item.host);
  const ready = booked === null && !busy && Boolean(host) && !card.unresolved.length && Boolean(anchor);

  const book = async () => {
    if (!ready || !host || !anchor || sending.current) return;
    sending.current = true;
    setBusy(true); setError("");
    try {
      const result = await bookMeeting({
        title: card.title, scheduledAt: card.scheduledAt, endsAt: card.endsAt, leadDriId: host.personId,
        ...(card.participants.length ? { participants: card.participants.map((person) => person.personId) } : {}),
        anchors: [{ kind: anchor.kind as TPickedWorldAnchor["kind"], id: anchor.id }],
        draftId: card.draftId,
      });
      if ("code" in result) { setError(BOOK_ERROR[result.code] ?? "没有约成"); return; }
      const id = result.card.objectRef.id;
      setBooked({ id, title: result.card.title, href: result.card.navigation?.[0]?.href ?? `/meetings/${id}` });
      window.dispatchEvent(new Event("meeting-changed"));
      refreshWorkspace();
    } catch {
      setError("没有约成");
    } finally {
      sending.current = false;
      setBusy(false);
    }
  };
  const edit = () => bookMeetingFrom?.({ draftId: card.draftId, title: card.title, scheduledAt: card.scheduledAt, endsAt: card.endsAt,
    leadDriId: host?.personId ?? null, participants: card.participants.map((person) => person.personId), anchors: anchor ? [anchor] : [] });
  const nameOf = (personId: string) => people.find((person) => person.personId === personId)?.displayName ?? "";
  const live = booked === null;

  return (
    <section className={e.card} aria-label={booked ? "已约的会" : "会议草稿"} data-testid="meeting-draft" data-status={booked ? "booked" : "draft"}>
      <header className={e.head}><h3>{card.title}</h3></header>
      <dl className={e.rows}>
        <dt>时间</dt>
        <dd>{span(card.scheduledAt, card.endsAt)}</dd>
        <dt>主持人</dt>
        <dd>{host ? host.displayName : <ul className={d.bookPeople} data-readonly><li data-off title={hostMissing?.reason === "ambiguous" ? "对上不止一个人" : "人员目录里没有"}>{hostMissing?.name}？</li></ul>}</dd>
        <dt>参会人</dt>
        <dd>
          {card.participants.length || others.length ? (
            <ul className={d.bookPeople} data-readonly aria-label="参会人">
              {card.participants.map((person) => <li key={person.personId}>{person.displayName}</li>)}
              {others.map((item) => <li key={item.name} data-off data-unresolved={item.reason} title={item.reason === "ambiguous" ? "对上不止一个人" : "人员目录里没有"}>{item.name}？</li>)}
            </ul>
          ) : "—"}
        </dd>
        <dt>挂到</dt>
        <dd>
          {anchor && !picking ? (
            <div className={d.bookAnchor} data-anchor-row>
              <span>{anchor.title}</span>
              {live ? <button type="button" onClick={() => setPicking(true)}>换</button> : null}
            </div>
          ) : null}
          {!anchor && !picking ? (live ? <button type="button" className={d.link} onClick={() => setPicking(true)}>选</button> : "—") : null}
          {picking && options ? (
            <WorldAnchorPicker options={options} value={anchor ? [anchor] : []} viewerId={viewerId ?? ""} nameOf={nameOf} company={ceo}
              onChange={(next) => { setAnchor(next[0] ?? null); if (next[0]?.kind !== "po") setPicking(false); }} />
          ) : null}
        </dd>
      </dl>
      {error ? <p className={d.worldError} role="alert">{error}</p> : null}
      {booked ? (
        <div className={e.foot}>
          <span className={e.done}><Check size={14} strokeWidth={2.6} aria-hidden="true" />已约</span>
          <a className={e.open} href={booked.href} onClick={(event) => { event.preventDefault(); navigate(booked.href); }}>去会议页</a>
        </div>
      ) : (
        <div className={d.bookActions}>
          {bookMeetingFrom ? <button type="button" className={d.ghost} disabled={!live || busy} onClick={edit}>改</button> : null}
          <button type="button" className={d.primary} disabled={!ready} onClick={() => void book()}>约好</button>
        </div>
      )}
    </section>
  );
}
