"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Users } from "lucide-react";
import type { TRequestListItem, TRequestPerson, TTeamDelivery } from "@warmap/contracts";
import type { TimedBlock } from "@/components/work/WorkTimeline";
import { useWorkspace } from "@/components/shell/WorkspaceContext";
import { REQUESTS_CHANGED } from "@/components/requests/requestApi";
import { chooseAnswerOption } from "@/conversation/answerOptions";
import { teamIntent, resolveTeamNames } from "@/lib/home/teamIntent";
import { listCollectionRounds, listTeamDeliveries, listTeamPeople, readTeamDelivery, sendTeamDelivery, TEAM_DELIVERY_CHANGED, teamError, type TeamBox } from "@/lib/home/teamDelivery";
import { CollectionRoundCard, TeamDeliveryCard, teamAnchor, type TeamForward } from "./PartnerTeamCard";
import { draftPayload, newTeamDraft, TeamCompose, type TeamDraft } from "./PartnerTeamCompose";
import h from "@/styles/home.module.css";
import s from "./partnerTeam.module.css";

export { isTeamDraft } from "@/lib/home/teamIntent";
export { teamAnchor } from "./PartnerTeamCard";

type TeamFeed = { received: TTeamDelivery[]; sent: TTeamDelivery[]; fixedReceived: TRequestListItem[]; fixedSent: TRequestListItem[] };
const emptyFeed: TeamFeed = { received: [], sent: [], fixedReceived: [], fixedSent: [] };
const FREQUENCY = 20_000;
const HASH = "#team-request-";

function withDelivery<T extends { id: string }>(items: T[], next: T): T[] {
  return [...items.filter((item) => item.id !== next.id), next];
}

/** 来件与发件是当前登录人的云端投影。轮次沿用原请求；单个来源暂时失败时，其余卡仍能使用。 */
function useTeamFeed(viewerId: string | null) {
  const [feed, setFeed] = useState<TeamFeed>(emptyFeed);
  const [error, setError] = useState("");
  const [hash, setHash] = useState("");
  const [anchored, setAnchored] = useState<TTeamDelivery | null>(null);
  const [anchorError, setAnchorError] = useState("");
  const [retry, setRetry] = useState(0);
  const reload = useCallback(() => setRetry((version) => version + 1), []);

  useEffect(() => {
    const sync = () => setHash(window.location.hash.startsWith(HASH) ? window.location.hash.slice(HASH.length) : "");
    sync();
    window.addEventListener("hashchange", sync);
    return () => window.removeEventListener("hashchange", sync);
  }, []);
  useEffect(() => {
    setAnchored(null); setAnchorError("");
    if (!hash) return;
    const controller = new AbortController();
    void readTeamDelivery(hash, controller.signal).then((item) => {
      if (!controller.signal.aborted) setAnchored(item);
    }, (cause) => { if (!controller.signal.aborted) setAnchorError(teamError(cause, "未能打开这条收发记录")); });
    return () => controller.abort();
  }, [hash, viewerId, retry]);

  useEffect(() => {
    const controller = new AbortController();
    let sequence = 0;
    const load = async () => {
      if (document.visibilityState === "hidden") return;
      const current = ++sequence;
      const results = await Promise.allSettled([listTeamDeliveries("received", controller.signal), listTeamDeliveries("sent", controller.signal),
        listCollectionRounds("inbox", controller.signal), listCollectionRounds("sent", controller.signal)] as const);
      if (controller.signal.aborted || current !== sequence) return;
      const [received, sent, fixedReceived, fixedSent] = results;
      setFeed((previous) => ({
        received: received.status === "fulfilled" ? received.value : previous.received, sent: sent.status === "fulfilled" ? sent.value : previous.sent,
        fixedReceived: fixedReceived.status === "fulfilled" ? fixedReceived.value : previous.fixedReceived, fixedSent: fixedSent.status === "fulfilled" ? fixedSent.value : previous.fixedSent,
      }));
      const failed = results.find((result) => result.status === "rejected");
      setError(failed?.status === "rejected" ? teamError(failed.reason, "同事收发记录暂时未更新") : "");
    };
    const events = ["focus", TEAM_DELIVERY_CHANGED, REQUESTS_CHANGED];
    const timer = window.setInterval(load, FREQUENCY);
    events.forEach((event) => window.addEventListener(event, load));
    document.addEventListener("visibilitychange", load);
    void load();
    return () => {
      controller.abort(); window.clearInterval(timer); events.forEach((event) => window.removeEventListener(event, load)); document.removeEventListener("visibilitychange", load);
    };
  }, [viewerId, retry]);

  const focusId = hash && (anchored?.id === hash || feed.received.some((item) => item.id === hash) || feed.sent.some((item) => item.id === hash)) ? hash : "";
  useEffect(() => {
    if (!focusId) return;
    const frame = window.requestAnimationFrame(() => {
      const card = document.getElementById(teamAnchor(focusId));
      card?.focus({ preventScroll: true }); card?.scrollIntoView({ block: "center" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [focusId]);

  const update = useCallback((box: TeamBox, item: TTeamDelivery) => {
    setFeed((previous) => ({ ...previous, [box]: withDelivery(previous[box], item) }));
    setAnchored((previous) => previous?.id === item.id ? item : previous);
    window.dispatchEvent(new Event(TEAM_DELIVERY_CHANGED));
  }, []);
  // 历史深链可以早于列表的窗口；按当前观察人放回原来的方向。
  const items = useMemo((): TeamFeed => {
    if (!anchored || anchored.id !== hash || feed.sent.some((item) => item.id === hash) || feed.received.some((item) => item.id === hash)) return feed;
    const box = anchored.sender.personId === viewerId ? "sent" : "received";
    return { ...feed, [box]: [...feed[box], anchored] };
  }, [anchored, feed, hash, viewerId]);
  return { items, update, reload, error: anchorError || error };
}

/** 仅挂在伙伴主对话。输入明确点名且原文已给时直接投递，其他团队输入保留在本人可改的预览里。 */
export function usePartnerTeam() {
  const { viewerId } = useWorkspace();
  const { items, update, error: feedError, reload } = useTeamFeed(viewerId);
  const [draft, setDraft] = useState<TeamDraft | null>(null);
  const composingDraft = draft !== null;
  const [busy, setBusy] = useState(false);
  const [people, setPeople] = useState<TRequestPerson[] | null>(null);
  const [directoryError, setDirectoryError] = useState("");
  const directory = useRef<Promise<TRequestPerson[]> | null>(null);
  const sending = useRef(false);
  const loadPeople = useCallback(() => {
    if (directory.current) return directory.current;
    setDirectoryError("");
    directory.current = listTeamPeople(viewerId).then((value) => { setPeople(value); return value; }, (cause) => {
      directory.current = null; setDirectoryError(teamError(cause, "没有读到同事名单")); throw cause;
    });
    return directory.current;
  }, [viewerId]);
  useEffect(() => {
    if (composingDraft) void loadPeople().catch(() => undefined);
  }, [composingDraft, loadPeople]);

  const begin = useCallback((content?: TeamForward) => {
    setDraft({ ...newTeamDraft(), text: content?.text ?? "", sourceUrl: content?.sourceUrl ?? "", recipientIds: content?.recipientIds ?? [] });
  }, []);
  const deliver = useCallback(async (value: TeamDraft) => {
    const body = draftPayload(value);
    if (!body || sending.current) return;
    sending.current = true; setBusy(true);
    try { const item = await sendTeamDelivery(body, value.files); update("sent", item); setDraft(null); }
    catch (cause) { setDraft({ ...value, error: teamError(cause, "未能确认送达，请重试") }); }
    finally { sending.current = false; setBusy(false); }
  }, [update]);

  const intercept = useCallback(async (text: string, files: File[]) => {
    const intent = teamIntent(text, files);
    if (!intent) return false;
    const value: TeamDraft = { ...newTeamDraft(intent.kind), text: intent.text, sourceUrl: intent.sourceUrl, dueAt: intent.dueAt,
      files, original: text.trim(), unresolved: intent.names };
    if (!intent.names.length) { setDraft(value); return true; }
    try {
      const resolved = resolveTeamNames(intent.names, await loadPeople());
      value.recipientIds = resolved.ids; value.unresolved = resolved.unresolved;
      if (!intent.review && !value.unresolved.length && draftPayload(value)) await deliver(value);
      else setDraft(value);
    } catch { setDraft(value); }
    return true;
  }, [deliver, loadPeople]);

  const blocks = useMemo(() => {
    const entries: TimedBlock[] = [];
    for (const box of ["received", "sent"] as const) {
      const sent = box === "sent";
      for (const item of items[box]) {
        entries.push({ key: "team-request:" + item.id, at: item.createdAt,
          node: <TeamDeliveryCard delivery={item} sent={sent} onSaved={(next) => update(box, next)} onForward={begin} /> });
      }
      for (const item of sent ? items.fixedSent : items.fixedReceived) {
        entries.push({ key: "collection-round:" + item.id, at: item.sentAt ?? item.createdAt, node: <CollectionRoundCard item={item} sent={sent} /> });
      }
    }
    return entries;
  }, [items, update, begin]);

  return {
    blocks, intercept, composing: composingDraft || busy,
    launcher: <><button type="button" className={h.sendTo} aria-haspopup="dialog" disabled={busy} onClick={() => begin()}>
      <Users size={14} aria-hidden /><b>同事收发</b></button>
      {feedError ? <button type="button" className={s.feedError} title={feedError} aria-label={feedError + "，重试"} onClick={reload}>收发未更新 · 重试</button> : null}</>,
    composer: draft ? <TeamCompose draft={draft} people={people} directoryError={directoryError}
      busy={busy} onDirectory={() => { void loadPeople().catch(() => undefined); }}
      onChange={(patch) => setDraft((previous) => previous ? { ...previous, ...patch, clientId: crypto.randomUUID(), error: "" } : null)}
      onClose={() => { if (!sending.current) setDraft(null); }} onSend={() => { void deliver(draft); }}
      onWeekly={(prompt) => { setDraft(null); chooseAnswerOption("global", prompt); }} /> : null,
  };
}
