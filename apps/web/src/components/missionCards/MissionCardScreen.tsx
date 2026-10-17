"use client";

/** 整页移植 clark mission-cards/workspace；数据、权限、意见与阶段由 API 持有。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "ts-design/primitives";
import type { TMissionCardField, TPersonalMissionCardPayload, TTaskView } from "@warmap/contracts";
import { browserApi, type Card, type CardAction } from "@/lib/api/client";
import { monthDayTime } from "@/lib/companyTime";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { InHeader, MaterialMenu, type MaterialTab } from "@/components/shell/MaterialTabs";
import { CardDocument, fieldNames, missionFieldText, selectedFieldQuote, type PersonalMission } from "./CardDocument";
import type { Correction, CorrectionDraft } from "./CorrectionPanel";
import { MissionDraftStatus } from "./MissionWorkflowActions";
import { PeopleMenu } from "./PeopleMenu";
import { MissionRoundProgress } from "./MissionRoundProgress";
import { RoundClock } from "./RoundClock";
import { useRoundNow } from "./useRoundNow";
import { useMissionAnnotations } from "./MissionAnnotations";
import s from "./mission-card.module.css";

type RoundAction = Pick<CardAction, "actionId" | "actionType" | "label">;
const taskViews: MaterialTab[] = [
  { id: "details", label: "任务细节", title: "任务细节" },
];
function requestError(cause: unknown, fallback: string): string {
  if (!(cause instanceof Error) || cause instanceof TypeError || /failed to fetch|fetch failed|networkerror|network request failed|load failed/i.test(cause.message)) return fallback;
  return cause.message;
}
/** 更正失败时服务端的 message 与 fieldErrors 原样显示。 */
function failureText(failure: { message?: string; fieldErrors?: Record<string, string> } | undefined, fallback: string): string {
  if (!failure?.message) return fallback;
  return [failure.message, ...Object.entries(failure.fieldErrors ?? {}).map(([key, text]) => `${key}：${text}`)].join("；");
}
export function MissionCardScreen({ initialCard, entry }: { initialCard: Card; entry: "member" | "ceo" }) {
  const workspace = useWorkspace();
  const router = useRouter();
  const [view, setView] = useState(initialCard);
  const payload = view.payload as TPersonalMissionCardPayload;
  const { round, card } = payload;
  const [pending, setPending] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [linkedItems, setLinkedItems] = useState<Record<string, TTaskView[]> | undefined>();
  const [correction, setCorrection] = useState<CorrectionDraft | null>(null);
  const [correctionError, setCorrectionError] = useState("");
  const [correctionHistory, setCorrectionHistory] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<{ id: string; note: string } | null>(null);
  const [correctionDecisionError, setCorrectionDecisionError] = useState<{ correctionId: string; message: string } | null>(null);
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const refreshEpoch = useRef(0);
  const actionInFlight = useRef(false);
  const leaveCard = () => workspace.close();
  const acceptView = useCallback((next: Card) => setView((current) => next.id === current.id && next.version < current.version ? current : next), []);
  const now = useRoundNow(round.closesAt, round.serverNow, round.phase === "open" ? () => void refresh() : undefined);
  const effectivePhase = round.phase === "open" && round.closesAt && now >= Date.parse(round.closesAt) ? "closed" : round.phase;
  const shownPayload = useMemo(() => effectivePhase === round.phase ? payload : { ...payload, round: { ...round, phase: effectivePhase } }, [payload, round, effectivePhase]);
  const isOwner = workspace.viewerId === card.ownerId;
  const ownerReview = isOwner && effectivePhase === "open";
  const ownerConfirmed = Boolean(card.ownerConfirmedAt);
  const refresh = useCallback(() => {
    if (refreshInFlight.current) return refreshInFlight.current;
    const epoch = refreshEpoch.current;
    refreshInFlight.current = (async () => {
      try {
        const { data, response, error: failure } = await browserApi.GET("/api/mission-cards/{cardId}", { params: { path: { cardId: card.cardId } } });
        if (response.status === 401) { router.push("/access"); return; }
        if (response.status === 403 || response.status === 404) {
          if (epoch === refreshEpoch.current) { workspace.showToast?.("任务准备状态已变化，正文恢复仅本人可见。"); workspace.close(); }
          return;
        }
        if (!response.ok || !data?.cards[0]) throw new Error(failure?.message ?? "暂时无法刷新任务卡，请稍后重试");
        if (epoch === refreshEpoch.current) acceptView(data.cards[0]);
      } catch (cause) { if (epoch === refreshEpoch.current) setError(requestError(cause, "暂时无法刷新任务卡，请检查网络后重试。")); }
      finally { refreshInFlight.current = null; }
    })();
    return refreshInFlight.current;
  }, [card.cardId, router, acceptView, workspace.close, workspace.showToast]);
  const focusTarget = (elementId: string) => {
    const element = document.getElementById(elementId);
    element?.focus({ preventScroll: true });
    element?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  };
  useEffect(() => {
    const search = new URLSearchParams(window.location.search);
    const feedbackId = search.get("feedback"), correctionId = search.get("correction");
    const target = feedbackId ? `feedback-${feedbackId}` : correctionId ? `correction-${correctionId}` : null;
    if (!target) return;
    // 先让共同工作台完成入场与关闭按钮定位，再把焦点交给实际待处理的意见或更正申请。
    let frame = window.requestAnimationFrame(() => { frame = window.requestAnimationFrame(() => focusTarget(target)); });
    return () => window.cancelAnimationFrame(frame);
  }, [card.cardId]);
  useEffect(() => {
    if (effectivePhase !== "closed" && effectivePhase !== "drafting" && !["queued", "running"].includes(round.coAgentReview?.status ?? "")) return;
    void refresh();
    const timer = setInterval(() => void refresh(), 3_000);
    return () => clearInterval(timer);
  }, [effectivePhase, round.coAgentReview?.status, refresh]);
  useEffect(() => {
    if (effectivePhase !== "open") return;
    const poll = () => { if (document.visibilityState === "visible") void refresh(); };
    const timer = window.setInterval(poll, 15_000);
    window.addEventListener("focus", poll);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", poll); };
  }, [effectivePhase, round.coAgentReview?.status, refresh]);
  const annotations = useMissionAnnotations(card.cardId, round.round);
  const revisionKey = annotations.revisions.map((revision) => revision.id).join(":");
  const annotationStateKey = annotations.notes.map((annotation) => `${annotation.id}:${annotation.status}`).join(":");
  useEffect(() => { if (revisionKey || annotationStateKey) void refresh(); }, [revisionKey, annotationStateKey, refresh]);
  useEffect(() => {
    const changed = (event: Event) => {
      if ((event as CustomEvent<{ scope: string }>).detail?.scope !== `mission-card:${card.cardId}`) return;
      void refresh(); void annotations.refresh();
    };
    window.addEventListener("mission-card-changed", changed);
    const roundChanged = () => { void refresh(); void annotations.refresh(); };
    window.addEventListener("mission-round-changed", roundChanged);
    return () => { window.removeEventListener("mission-card-changed", changed); window.removeEventListener("mission-round-changed", roundChanged); };
  }, [card.cardId, refresh, annotations.refresh]);
  const loadLinkedItems = useCallback(async () => {
    const { data } = await browserApi.GET("/api/mission-cards/{cardId}/items", { params: { path: { cardId: card.cardId } } });
    if (data) setLinkedItems(Object.fromEntries(data.missions.map((mission) => [mission.missionId, mission.items])));
  }, [card.cardId]);
  useEffect(() => { void loadLinkedItems().catch(() => undefined); }, [loadLinkedItems]);
  const cards = useMemo(() => [view], [view]);
  const group = useMemo(() => ({ cardId: card.cardId, viewerId: workspace.viewerId ?? card.ownerId, members: card.members, phase: effectivePhase === "drafting" ? "draft" as const : effectivePhase, round: round.round, reference: null, onRemoveReference: () => undefined, onRefresh: refresh, canDiscuss: false }), [card.cardId, card.ownerId, workspace.viewerId, card.members, effectivePhase, round.round, refresh]);
  const title = `${card.ownerName} · ${Number(round.period.slice(5))}月任务`;
  useRegisterDetail({ scope: `mission-card:${card.cardId}`, label: title, mark: null, cards, group });

  const quote = (mission: PersonalMission, field: TMissionCardField, text: string, sourceRound = round.round) => {
    if (text.length > 2000) { setError("这段超过 2000 字，请划选其中一段引用。"); return; }
    workspace.quote(text, { label: `${mission.title} · ${fieldNames[field]}`, objectType: "mission-card", objectId: card.cardId, missionId: mission.missionId, field, sourceRound, sourceVersion: mission.version });
    setError("");
  };
  const select = (mission: PersonalMission, field: TMissionCardField, node: HTMLElement) => {
    const text = selectedFieldQuote(node, window.getSelection());
    if (text) quote(mission, field, text);
  };
  // 更正草稿打开时生成 clientId；原样重试复用，改了文字或原因就是新的一次提交（同修改建议）。
  const openCorrection = (mission: PersonalMission, field: TMissionCardField) => {
    if (!isOwner || !payload.correctionAccess.canRequest || effectivePhase !== "confirmed") return;
    setCorrection((current) => current?.missionId === mission.missionId && current.field === field ? current : { missionId: mission.missionId, field, sourceVersion: mission.version, text: missionFieldText(mission, field), reason: "", clientId: crypto.randomUUID() });
    setCorrectionError(""); setNotice("");
  };
  const sendCorrection = async () => {
    if (!correction || posting || !correction.text.trim() || !correction.reason.trim() || !isOwner || !payload.correctionAccess.canRequest || effectivePhase !== "confirmed") return;
    setPosting(true); setCorrectionError(""); setNotice("");
    try {
      const { response, error: failure } = await browserApi.POST("/api/mission-cards/{cardId}/corrections", { params: { path: { cardId: card.cardId } }, body: { clientId: correction.clientId, missionId: correction.missionId, field: correction.field, proposed: correction.text, reason: correction.reason.trim(), sourceVersion: correction.sourceVersion } });
      if (!response.ok) throw new Error(failureText(failure, "更正没有提交成功，请重试；输入已保留。"));
      setCorrection(null); setNotice(`更正申请已保存，需由${round.deciderName}退回本人准备后修改。`);
      void refresh();
    } catch (cause) { setCorrectionError(requestError(cause, "暂时无法连接服务器，请稍后重试；输入已保留。")); }
    finally { setPosting(false); }
  };
  const decideCorrection = async (item: Correction, decision: "apply" | "reject") => {
    const note = rejecting?.id === item.id ? rejecting.note.trim() : "";
    if (actionInFlight.current || decision !== "reject" || !payload.correctionAccess.canReject || !note) return;
    actionInFlight.current = true;
    refreshEpoch.current++;
    setPending(true); setCorrectionDecisionError(null); setNotice("");
    try {
      const { response, error: failure } = await browserApi.POST("/api/mission-cards/{cardId}/corrections/{correctionId}/decision", { params: { path: { cardId: card.cardId, correctionId: item.id } }, body: decision === "reject" ? { decision, note } : { decision } });
      if (!response.ok) throw new Error(failureText(failure, "这条更正没有处理成功，请重试"));
      setRejecting(null); setNotice("已记录不采纳和原因。");
      await refresh();
      window.dispatchEvent(new Event("mission-round-changed"));
      router.refresh();
    } catch (cause) { setCorrectionDecisionError({ correctionId: item.id, message: requestError(cause, "暂时无法连接服务器，请稍后重试。") }); }
    finally { actionInFlight.current = false; setPending(false); }
  };
  const runAction = async (action: RoundAction) => {
    if (actionInFlight.current || action.actionType !== "mission-round.draft") return;
    actionInFlight.current = true; refreshEpoch.current++;
    setPending(true); setError(""); setNotice("");
    try {
      const { response, error: failure } = await browserApi.POST("/api/mission-rounds/actions/execute", { body: { actionId: action.actionId } });
      if (response.status === 401) { router.push("/access"); return; }
      if (!response.ok) throw new Error(failure?.message ?? "起草未开始，请重试。");
      await refreshInFlight.current; await refresh();
      window.dispatchEvent(new Event("mission-round-changed")); router.refresh();
    } catch (cause) { setError(requestError(cause, "暂时无法连接服务器，请稍后重试。")); }
    finally { actionInFlight.current = false; setPending(false); }
  };
  const toggleOwnerReview = async () => {
    if (actionInFlight.current || annotations.pending || !(ownerConfirmed ? payload.selfReview.canCancel : payload.selfReview.canConfirm)) return;
    actionInFlight.current = true; refreshEpoch.current++; setPending(true); setError(""); setNotice("");
    try {
      const { data, response, error: failure } = await browserApi.POST("/api/mission-cards/{cardId}/owner-confirmation", { params: { path: { cardId: card.cardId } }, body: { confirmed: !ownerConfirmed, round: round.round, missionVersions: Object.fromEntries(card.missions.map((mission) => [mission.missionId, mission.version])) } });
      if (response.status === 401) { router.push("/access"); return; }
      if (!response.ok || data?.cards[0]?.kind !== "personal-mission-card") { await refreshInFlight.current; await refresh(); throw new Error(failure?.message ?? "本人确认未保存，请重试"); }
      refreshEpoch.current++;
      acceptView(data.cards[0]);
      setNotice(ownerConfirmed ? "已取消本人确认" : "本人确认已保存。");
      window.dispatchEvent(new Event("mission-round-changed")); router.refresh();
    } catch (cause) { setError(requestError(cause, "暂时无法连接服务器，请稍后重试。")); }
    finally { actionInFlight.current = false; setPending(false); }
  };
  return <div className={s.screen}>
    <DetailFrame title={title} subtitle={round.battlefieldName} onBack={leaveCard} actions={<div className={s.headerActions}>{effectivePhase !== "confirmed" ? <RoundClock round={shownPayload.round} now={now} /> : null}{ownerReview ? <Button variant={ownerConfirmed ? "ghost" : "primary"} className={s.headerPrimary} isDisabled={pending || annotations.pending || !(ownerConfirmed ? payload.selfReview.canCancel : payload.selfReview.canConfirm)} aria-describedby={payload.selfReview.blockedReason ? "mission-self-review-state" : undefined} aria-label={ownerConfirmed ? "取消本人确认" : "确认我的任务"} onPress={() => void toggleOwnerReview()}>{ownerConfirmed ? "取消确认" : "确认我的任务"}</Button> : null}{round.approver || round.cards.some((row) => !row.mine) ? <MissionRoundProgress key={round.roundId} round={shownPayload.round} entry={entry} compact onNavigate={workspace.navigate} onRefresh={() => void refresh()} /> : null}</div>}>
      <InHeader><span data-mission-people><PeopleMenu round={shownPayload.round} cardId={card.cardId} onSelect={(id) => workspace.navigate(`${entry === "member" ? "/me" : ""}/mission-cards/${id}`)} /></span><span data-mission-view><MaterialMenu tabs={taskViews} selected="details" onSelect={() => undefined} label="任务视图" switchLabel="切换任务视图" /></span></InHeader>
      <div className={s.content}>
        <section className={s.goals} aria-label="任务目标"><div><h2>长期目标</h2><p>{round.goals?.sixMonthOutcome || "长期目标尚未提供"}</p></div><div><h2>本月目标</h2><p>{round.goals?.monthOutcome || "本月目标尚未提供"}</p></div></section>
        <MissionDraftStatus payload={shownPayload} pending={pending} onAction={(action) => void runAction(action)} />
        {payload.confirmation && effectivePhase === "confirmed" ? <details className={s.readonly}><summary>任务组合已确定 · {payload.confirmation.byName} · {monthDayTime(payload.confirmation.at)}</summary><p>{payload.confirmation.note}</p></details> : null}
        {isOwner && payload.selfReview.returnReason ? <p className={s.readonly} role="status">战场 DRI 请你继续核对：{payload.selfReview.returnReason}</p> : null}
        {isOwner && !round.approver && ["closed", "reviewing"].includes(effectivePhase) && !round.counts.unreviewed ? <p className={s.readonly} role="status">{round.coAgentReview?.status === "failed" ? "Co-Agent 核对未完成，战场 DRI 可重试；任务与记录已保留。" : round.coAgentReview?.status === "completed" ? "本人已确认，Co-Agent 已核对，等待战场 DRI 确认任务组合。" : "全员本人已确认，Co-Agent 正在统一核对。"}</p> : null}
        {ownerReview && payload.selfReview.blockedReason ? <p id="mission-self-review-state" className={s.readonly} role="status">{payload.selfReview.blockedReason}</p> : null}
        {error ? <p className={s.error} role="alert">{error}</p> : null}
        {notice ? <p className={s.notice} role="status">{notice}</p> : null}
        {annotations.error ? <p className={s.annotationError} role="status">{annotations.error}<button type="button" onClick={() => void annotations.refresh()}>重新读取</button></p> : null}
        <CardDocument payload={shownPayload} linkedItems={linkedItems} viewerId={workspace.viewerId} controls={{ annotations: { notes: annotations.notes, revisions: annotations.revisions, onSave: annotations.save, onAnswer: annotations.answer, onRetry: annotations.retry, onResolve: annotations.resolve, closedReason: payload.annotationAccess.closedReason }, onQuote: quote, onPropose: () => undefined, onSelect: select, pending,
          corrections: { draft: correction, draftError: correctionError, history: correctionHistory, rejecting, decisionError: correctionDecisionError, busy: posting || pending, onOpen: openCorrection, onEdit: (patch) => setCorrection((current) => current && { ...current, ...patch, clientId: crypto.randomUUID() }), onCancel: () => setCorrection(null), onSubmit: () => void sendCorrection(), onHistory: setCorrectionHistory, onRejecting: setRejecting, onDecide: (item, decision) => void decideCorrection(item, decision) },
 }} />
      </div>
    </DetailFrame>
  </div>;
}
