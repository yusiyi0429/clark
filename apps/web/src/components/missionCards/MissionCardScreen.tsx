"use client";

/** 整页移植 clark mission-cards/workspace；数据、权限、意见与阶段由 API 持有。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { CircleHelp } from "lucide-react";
import { Button } from "ts-design/primitives";
import type { TMissionCardField, TPersonalMissionCardPayload, TTaskView } from "@warmap/contracts";
import { browserApi, type Card, type CardAction } from "@/lib/api/client";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { InHeader, MaterialMenu, type MaterialTab } from "@/components/shell/MaterialTabs";
import { useConfirm } from "@/components/ConfirmDialog";
import type { MissionGroupReference } from "@/conversation/missionCardGroup";
import { CardDocument, fieldNames, missionFieldText, selectedFieldQuote, type PersonalMission } from "./CardDocument";
import type { Correction, CorrectionDraft } from "./CorrectionPanel";
import { MissionDraftStatus, MissionWorkflowActions } from "./MissionWorkflowActions";
import { PeopleMenu } from "./PeopleMenu";
import { RoundClock } from "./RoundClock";
import { useRoundNow } from "./useRoundNow";
import { clearRoundNote, readRoundNote, saveRoundNote } from "./roundNoteDraft";
import { useMissionAnnotations } from "./MissionAnnotations";
import { useSeenMarks } from "@/lib/useSeenMarks";
import { RELEASE, releaseSeenKey } from "@/lib/releaseNotes";
import { MissionCardTour, MISSION_CARD_TOUR_KEY } from "@/components/tours/MissionCardTour";
import s from "./mission-card.module.css";

type Proposal = { missionId: string; field: TMissionCardField; sourceRound: number; sourceVersion: number; text: string; clientId?: string };
type RoundAction = Pick<CardAction, "actionId" | "actionType" | "label">;
const taskViews: MaterialTab[] = [
  { id: "details", label: "任务细节", title: "任务细节" },
  { id: "execution", label: "执行拆分", title: "执行拆分 · 下一版本由 Co-Agent 基于当前任务生成", isDisabled: true, hint: "即将开放" },
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
  const [reference, setReference] = useState<MissionGroupReference | null>(null);
  const [proposal, setProposal] = useState<Proposal | null>(null);
  const [pending, setPending] = useState(false);
  const [posting, setPosting] = useState(false);
  const [error, setError] = useState("");
  const [proposalError, setProposalError] = useState("");
  const [notice, setNotice] = useState("");
  const [linkedItems, setLinkedItems] = useState<Record<string, TTaskView[]> | undefined>();
  const [noteDraft, setNoteDraft] = useState({ roundKey: "", text: "" });
  const [decisionError, setDecisionError] = useState<{ feedbackId: string; message: string } | null>(null);
  const [correction, setCorrection] = useState<CorrectionDraft | null>(null);
  const [correctionError, setCorrectionError] = useState("");
  const [correctionHistory, setCorrectionHistory] = useState<string | null>(null);
  const [rejecting, setRejecting] = useState<{ id: string; note: string } | null>(null);
  const [correctionDecisionError, setCorrectionDecisionError] = useState<{ correctionId: string; message: string } | null>(null);
  const { ask, dialog } = useConfirm();
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const refreshEpoch = useRef(0);
  const actionInFlight = useRef(false);
  const noteViewer = workspace.viewerId ?? card.ownerId;
  const leaveCard = () => workspace.close();
  const roundKey = `${noteViewer}:${round.roundId}:${round.round}`;
  const note = noteDraft.roundKey === roundKey ? noteDraft.text : "";
  const acceptView = useCallback((next: Card) => setView((current) => next.id === current.id && next.version < current.version ? current : next), []);
  const now = useRoundNow(round.closesAt, round.serverNow, round.phase === "open" ? () => void refresh() : undefined);
  const effectivePhase = round.phase === "open" && round.closesAt && now >= Date.parse(round.closesAt) ? "closed" : round.phase;
  const shownPayload = useMemo(() => effectivePhase === round.phase ? payload : { ...payload, round: { ...round, phase: effectivePhase } }, [payload, round, effectivePhase]);
  const isOwner = workspace.viewerId === card.ownerId;
  const ownerReview = isOwner && effectivePhase === "open";
  const ownerConfirmed = Boolean(card.ownerConfirmedAt);
  const agentNote = effectivePhase === "open" ? ownerConfirmed ? isOwner ? "仅你可见 · 已完成审核，取消确认后可继续修改" : "仅你可见 · 该任务已完成审核，等待本人取消确认后修改" : payload.selfReview.canEdit || payload.annotationAccess.canApply ? "仅你可见 · 改法明确后立即修改，完成审核后冻结正文" : "仅你可见 · 讨论与引用可用，正文由本人或拍板人修改" : effectivePhase === "confirmed" ? "仅你可见 · 任务已确认，修改请走正式更正" : effectivePhase === "draft" || effectivePhase === "drafting" ? "仅你可见 · 审核尚未下发，正文暂不可修改" : "仅你可见 · 任务已汇总，修改需重新开放审核";
  const refresh = useCallback(() => {
    if (refreshInFlight.current) return refreshInFlight.current;
    const epoch = refreshEpoch.current;
    refreshInFlight.current = (async () => {
      try {
        const { data, response, error: failure } = await browserApi.GET("/api/mission-cards/{cardId}", { params: { path: { cardId: card.cardId } } });
        if (response.status === 401) { router.push("/access"); return; }
        if (!response.ok || !data?.cards[0]) throw new Error(failure?.message ?? "暂时无法刷新任务卡，请稍后重试");
        if (epoch === refreshEpoch.current) acceptView(data.cards[0]);
      } catch (cause) { if (epoch === refreshEpoch.current) setError(requestError(cause, "暂时无法刷新任务卡，请检查网络后重试。")); }
      finally { refreshInFlight.current = null; }
    })();
    return refreshInFlight.current;
  }, [card.cardId, router, acceptView]);
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
    setNoteDraft({ roundKey, text: readRoundNote(noteViewer, round.roundId, round.round) });
  }, [roundKey, noteViewer, round.roundId, round.round]);
  const startProcessing = () => {
    // 已确定后「从第一条开始」处理更正申请；集中 Review 时处理意见。第一条都可能在另一张卡上。
    const kind = round.phase === "confirmed" ? "correction" : "feedback";
    const target = round.cards.find((row) => kind === "correction" ? row.pendingCorrections > 0 && row.firstPendingCorrectionId : row.pending > 0 && row.firstPendingFeedbackId);
    const id = kind === "correction" ? target?.firstPendingCorrectionId : target?.firstPendingFeedbackId;
    if (!target || !id) return;
    if (target.cardId === card.cardId) focusTarget(`${kind}-${id}`);
    else workspace.navigate(`${entry === "member" ? "/me" : ""}/mission-cards/${target.cardId}?${kind}=${encodeURIComponent(id)}`);
  };
  useEffect(() => {
    if (effectivePhase !== "closed" && effectivePhase !== "drafting") return;
    void refresh();
    const timer = setInterval(() => void refresh(), 3_000);
    return () => clearInterval(timer);
  }, [effectivePhase, refresh]);
  useEffect(() => {
    if (effectivePhase !== "open") return;
    const poll = () => { if (document.visibilityState === "visible") void refresh(); };
    const timer = window.setInterval(poll, 15_000);
    window.addEventListener("focus", poll);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", poll); };
  }, [effectivePhase, refresh]);
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
  const { seen, mark } = useSeenMarks();
  const [tourOpen, setTourOpen] = useState(false);
  useEffect(() => {
    if (!seen?.has(releaseSeenKey(RELEASE.id)) || seen.has(MISSION_CARD_TOUR_KEY)) return;
    // 更新说明有退场动画；等它真正离开再开始，避免两个模态叠在一起。
    const show = () => {
      if (document.querySelector('[role="dialog"], dialog[open]')) return;
      observer.disconnect(); setTourOpen(true);
    };
    const observer = new MutationObserver(show);
    observer.observe(document.body, { childList: true, subtree: true });
    show();
    return () => observer.disconnect();
  }, [seen]);
  const loadLinkedItems = useCallback(async () => {
    const { data } = await browserApi.GET("/api/mission-cards/{cardId}/items", { params: { path: { cardId: card.cardId } } });
    if (data) setLinkedItems(Object.fromEntries(data.missions.map((mission) => [mission.missionId, mission.items])));
  }, [card.cardId]);
  useEffect(() => { void loadLinkedItems().catch(() => undefined); }, [loadLinkedItems]);
  const removeReference = useCallback(() => setReference(null), []);
  const cards = useMemo(() => [view], [view]);
  const group = useMemo(() => ({ cardId: card.cardId, viewerId: workspace.viewerId ?? card.ownerId, members: card.members, phase: effectivePhase === "drafting" ? "draft" as const : effectivePhase, round: round.round, reference, onRemoveReference: removeReference, onRefresh: refresh, agentNote }), [card.cardId, card.ownerId, workspace.viewerId, card.members, effectivePhase, round.round, reference, removeReference, refresh, agentNote]);
  const title = `${card.ownerName} · ${Number(round.period.slice(5))}月任务`;
  useRegisterDetail({ scope: `mission-card:${card.cardId}`, label: title, mark: null, cards, group });

  const quote = (mission: PersonalMission, field: TMissionCardField, text: string) => {
    if (text.length > 2000) { setError("这段超过 2000 字，请划选其中一段引用。"); return; }
    workspace.quote(`${mission.title} · ${fieldNames[field]}：${text}`);
    setError("");
  };
  const select = (mission: PersonalMission, field: TMissionCardField, node: HTMLElement) => {
    const text = selectedFieldQuote(node, window.getSelection());
    if (text) quote(mission, field, text);
  };
  const propose = (mission: PersonalMission, field: TMissionCardField) => {
    setProposal((current) => current?.missionId === mission.missionId && current.field === field
      ? current.sourceRound === round.round && current.sourceVersion === mission.version ? current : { ...current, sourceRound: round.round, sourceVersion: mission.version, clientId: undefined }
      : { missionId: mission.missionId, field, sourceRound: round.round, sourceVersion: mission.version, text: missionFieldText(mission, field) });
    setProposalError(""); setNotice("");
  };
  const sendProposal = async () => {
    if (!proposal || posting || !proposal.text.trim() || effectivePhase !== "open" || proposal.sourceRound !== round.round) return;
    const clientId = proposal.clientId ?? crypto.randomUUID();
    setProposal({ ...proposal, clientId }); setPosting(true); setProposalError(""); setNotice("");
    try {
      const { response, error: failure } = await browserApi.POST("/api/mission-cards/{cardId}/feedback", { params: { path: { cardId: card.cardId } }, body: { clientId, kind: "suggestion", round: proposal.sourceRound, missionId: proposal.missionId, field: proposal.field, proposed: proposal.text, sourceVersion: proposal.sourceVersion, body: `建议修改「${fieldNames[proposal.field]}」` } });
      if (!response.ok) throw new Error(failure?.message ?? "修改建议未保存，请重试；输入已保留。");
      setProposal(null); setNotice("修改建议已记录，汇总后由拍板人处理。");
      void refresh();
    } catch (cause) { setProposalError(requestError(cause, "暂时无法连接服务器，请稍后重试；输入已保留。")); }
    finally { setPosting(false); }
  };
  // 更正草稿打开时生成 clientId；原样重试复用，改了文字或原因就是新的一次提交（同修改建议）。
  const openCorrection = (mission: PersonalMission, field: TMissionCardField) => {
    setCorrection((current) => current?.missionId === mission.missionId && current.field === field ? current : { missionId: mission.missionId, field, sourceVersion: mission.version, text: missionFieldText(mission, field), reason: "", clientId: crypto.randomUUID() });
    setCorrectionError(""); setNotice("");
  };
  const sendCorrection = async () => {
    if (!correction || posting || !correction.text.trim() || !correction.reason.trim()) return;
    setPosting(true); setCorrectionError(""); setNotice("");
    try {
      const { response, error: failure } = await browserApi.POST("/api/mission-cards/{cardId}/corrections", { params: { path: { cardId: card.cardId } }, body: { clientId: correction.clientId, missionId: correction.missionId, field: correction.field, proposed: correction.text, reason: correction.reason.trim(), sourceVersion: correction.sourceVersion } });
      if (!response.ok) throw new Error(failureText(failure, "更正没有提交成功，请重试；输入已保留。"));
      setCorrection(null); setNotice(payload.correctionAccess.canApply ? "已更正，改前改后都已留痕。" : `更正申请已提交，等${round.deciderName}处理；正文先不变。`);
      void refresh();
    } catch (cause) { setCorrectionError(requestError(cause, "暂时无法连接服务器，请稍后重试；输入已保留。")); }
    finally { setPosting(false); }
  };
  const decideCorrection = async (item: Correction, decision: "apply" | "reject") => {
    const note = rejecting?.id === item.id ? rejecting.note.trim() : "";
    if (actionInFlight.current || (decision === "reject" && !note)) return;
    actionInFlight.current = true;
    refreshEpoch.current++;
    setPending(true); setCorrectionDecisionError(null); setNotice("");
    try {
      const { response, error: failure } = await browserApi.POST("/api/mission-cards/{cardId}/corrections/{correctionId}/decision", { params: { path: { cardId: card.cardId, correctionId: item.id } }, body: decision === "reject" ? { decision, note } : { decision } });
      if (!response.ok) throw new Error(failureText(failure, "这条更正没有处理成功，请重试"));
      setRejecting(null); setNotice(decision === "apply" ? "已采纳，正文已更新。" : "已记录不采纳和原因。");
      await refresh();
      window.dispatchEvent(new Event("mission-round-changed"));
      router.refresh();
    } catch (cause) { setCorrectionDecisionError({ correctionId: item.id, message: requestError(cause, "暂时无法连接服务器，请稍后重试。") }); }
    finally { actionInFlight.current = false; setPending(false); }
  };
  const runAction = async (action: RoundAction, input?: { decision: "accept" | "decline" } | { note: string }, feedbackId?: string) => {
    if (actionInFlight.current) return;
    actionInFlight.current = true; refreshEpoch.current++;
    setPending(true); setError(""); setDecisionError(null); setNotice("");
    let failureFallback = "暂时无法连接服务器，请稍后重试；输入已保留。";
    try {
      if (action.actionType === "mission-round.reopen" && !await ask(`重新开放${round.battlefieldName}的 ${round.counts.cards} 张任务卡审核？批注与修改记录保留，每个人都需要重新完成审核，协作核对结论需要重新填写。`, "重新开放审核")) return;
      if (action.actionType === "mission-round.close") {
        failureFallback = "暂时无法读取最新审核进度，请重试后再开始汇总。";
        const { data, response, error: failure } = await browserApi.GET("/api/mission-cards/{cardId}", { params: { path: { cardId: card.cardId } } });
        if (response.status === 401) { router.push("/access"); return; }
        if (response.status === 403 || response.status === 404) { setNotice("任务卡权限已变化，已刷新工作台，请重新查看可访问的任务。"); router.refresh(); return; }
        const latest = data?.cards[0];
        if (!response.ok || latest?.kind !== "personal-mission-card") throw new Error(failure?.message ? `${failure.message}；${failureFallback}` : failureFallback);
        refreshEpoch.current++;
        acceptView(latest);
        const latestRound = (latest.payload as TPersonalMissionCardPayload).round;
        const latestClose = latest.actions.find((candidate) => candidate.actionType === "mission-round.close");
        if (!latestRound.approver) { setNotice("拍板权限已变化，已刷新审核进度，请由当前拍板人开始汇总。"); return; }
        if (!["open", "closed"].includes(latestRound.phase) || !latestClose) { setNotice("审核状态已变化，已刷新任务卡，请查看当前审核结果。"); return; }
        const unfinished = latestRound.cards.filter((row) => !row.ownerConfirmedAt).map((row) => row.ownerName);
        if (!await ask(`${unfinished.length ? `尚未完成审核：${unfinished.join("、")}。\n\n` : ""}现在开始汇总${latestRound.battlefieldName}的 ${latestRound.counts.cards} 张任务卡？汇总后正文冻结，公开意见与批注记录会保留供拍板。需要修改时可重新开放审核。`, "开始汇总")) return;
        action = latestClose;
        failureFallback = "暂时无法连接服务器，请稍后重试；输入已保留。";
      }
      const { data, response, error: failure } = await browserApi.POST("/api/mission-rounds/actions/execute", { body: { actionId: action.actionId, ...(action.actionType === "mission-round.draft" ? {} : { viewCardId: card.cardId }), ...(input ? { input } : {}) } });
      if (response.status === 401) { router.push("/access"); return; }
      if (!response.ok) {
        const latest = (failure as { latestCard?: Card } | undefined)?.latestCard;
        if (latest?.kind === "personal-mission-card") acceptView(latest);
        throw new Error(failure?.message ?? "操作未保存，请重试");
      }
      const next = data?.cards[0];
      refreshEpoch.current++;
      if (next?.kind === "personal-mission-card") acceptView(next); else { await refreshInFlight.current; await refresh(); }
      if (action.actionType === "mission-round.reopen" || action.actionType === "mission-round.confirm") { clearRoundNote(noteViewer, round.roundId, round.round); setNoteDraft({ roundKey: "", text: "" }); setReference(null); setProposal(null); }
      setNotice(action.actionType === "mission-round.open" ? "任务已下发审核，全员完成后自动汇总。" : action.actionType === "mission-round.close" ? "正在汇总，正文已冻结；修改记录保留供拍板。" : action.actionType === "mission-round.reopen" ? "已重新开放审核，每个人需要重新完成审核。" : action.actionType === "mission-round.confirm" ? "本月任务已确认，确认记录与公开意见保留可查。" : "");
      window.dispatchEvent(new Event("mission-round-changed"));
      router.refresh();
    } catch (cause) { const message = requestError(cause, failureFallback); if (feedbackId) setDecisionError({ feedbackId, message }); else setError(message); }
    finally { actionInFlight.current = false; setPending(false); }
  };
  const toggleOwnerReview = async () => {
    if (actionInFlight.current || annotations.pending || !(ownerConfirmed ? payload.selfReview.canCancel : payload.selfReview.canConfirm)) return;
    actionInFlight.current = true; refreshEpoch.current++; setPending(true); setError(""); setNotice("");
    try {
      const { data, response, error: failure } = await browserApi.POST("/api/mission-cards/{cardId}/owner-confirmation", { params: { path: { cardId: card.cardId } }, body: { confirmed: !ownerConfirmed, round: round.round, missionVersions: Object.fromEntries(card.missions.map((mission) => [mission.missionId, mission.version])) } });
      if (response.status === 401) { router.push("/access"); return; }
      if (!response.ok || data?.cards[0]?.kind !== "personal-mission-card") { await refreshInFlight.current; await refresh(); throw new Error(failure?.message ?? "审核状态未保存，请重试"); }
      refreshEpoch.current++;
      acceptView(data.cards[0]);
      setNotice(ownerConfirmed ? "已取消确认，可以继续修改并重新审核。" : (data.cards[0].payload as TPersonalMissionCardPayload).round.phase === "open" ? "已完成审核，等待其他人；需要修改可取消确认。" : "全员已完成审核，正在自动汇总。");
      window.dispatchEvent(new Event("mission-round-changed")); router.refresh();
    } catch (cause) { setError(requestError(cause, "暂时无法连接服务器，请稍后重试。")); }
    finally { actionInFlight.current = false; setPending(false); }
  };
  const workflowProps = { payload: shownPayload, actions: view.actions, viewerId: workspace.viewerId, pending, onAction: (action: RoundAction, input?: { note: string }) => void runAction(action, input), onStartProcessing: startProcessing, note, onNoteChange: (text: string) => { setNoteDraft({ roundKey, text }); saveRoundNote(noteViewer, round.roundId, round.round, text); }, error };
  return <div className={s.screen}>
    <DetailFrame title={title} subtitle={round.battlefieldName} onBack={leaveCard} actions={<div className={s.headerActions}><RoundClock round={shownPayload.round} now={now} />{ownerReview ? <Button variant={ownerConfirmed ? "ghost" : "primary"} className={s.headerPrimary} isDisabled={pending || annotations.pending || !(ownerConfirmed ? payload.selfReview.canCancel : payload.selfReview.canConfirm)} aria-describedby={payload.selfReview.blockedReason ? "mission-self-review-state" : undefined} aria-label={ownerConfirmed ? "取消审核确认" : "完成本人审核"} onPress={() => void toggleOwnerReview()}>{ownerConfirmed ? "取消确认" : "完成审核"}</Button> : round.approver ? <MissionWorkflowActions {...workflowProps} /> : null}<Button variant="ghost" isIconOnly className={s.help} aria-label="查看任务使用说明" onPress={() => setTourOpen(true)}><CircleHelp size={17} aria-hidden /></Button></div>}>
      <InHeader><span data-mission-people><PeopleMenu round={shownPayload.round} cardId={card.cardId} onSelect={(id) => workspace.navigate(`${entry === "member" ? "/me" : ""}/mission-cards/${id}`)}>{round.approver ? (dismiss) => <MissionWorkflowActions {...workflowProps} inMenu onDismiss={dismiss} /> : null}</PeopleMenu></span><span data-mission-view><MaterialMenu tabs={taskViews} selected="details" onSelect={() => undefined} label="任务视图" switchLabel="切换任务视图" /></span></InHeader>
      <div className={s.content}>
        <section className={s.goals} aria-label="任务目标"><div><h2>长期目标</h2><p>{round.goals?.sixMonthOutcome || "长期目标尚未提供"}</p></div><div><h2>本月目标</h2><p>{round.goals?.monthOutcome || "本月目标尚未提供"}</p></div></section>
        <MissionDraftStatus payload={shownPayload} pending={pending} onAction={(action) => void runAction(action)} />
        {ownerReview && payload.selfReview.blockedReason ? <p id="mission-self-review-state" className={s.readonly} role="status">{payload.selfReview.blockedReason}</p> : null}
        {error ? <p className={s.error} role="alert">{error}</p> : null}
        {notice ? <p className={s.notice} role="status">{notice}</p> : null}
        {annotations.error ? <p className={s.annotationError} role="status">{annotations.error}<button type="button" onClick={() => void annotations.refresh()}>重新读取</button></p> : null}
        <CardDocument payload={shownPayload} linkedItems={linkedItems} viewerId={workspace.viewerId} controls={{ annotations: { notes: annotations.notes, revisions: annotations.revisions, onSave: annotations.save, onAnswer: annotations.answer, onRetry: annotations.retry, onResolve: annotations.resolve, closedReason: payload.annotationAccess.closedReason }, onQuote: quote, onPropose: propose, onSelect: select, pending, decisionError, onDecide: (item, decision) => { const action = item.actions.find((candidate) => candidate.actionType === "mission-round.decide"); if (action) void runAction(action, { decision }, item.id); },
          corrections: { draft: correction, draftError: correctionError, history: correctionHistory, rejecting, decisionError: correctionDecisionError, busy: posting || pending, onOpen: openCorrection, onEdit: (patch) => setCorrection((current) => current && { ...current, ...patch, clientId: crypto.randomUUID() }), onCancel: () => setCorrection(null), onSubmit: () => void sendCorrection(), onHistory: setCorrectionHistory, onRejecting: setRejecting, onDecide: (item, decision) => void decideCorrection(item, decision) },
          proposalEditor: (mission, field) => proposal?.missionId === mission.missionId && proposal.field === field && effectivePhase !== "confirmed" ? <div className={s.proposal}>
          <label htmlFor={`proposal-${mission.missionId}-${field}`}>建议修改：{fieldNames[field]}</label>
          <textarea id={`proposal-${mission.missionId}-${field}`} value={proposal.text} maxLength={field === "title" ? 200 : 4000} rows={4} autoFocus aria-describedby={proposalError ? `proposal-error-${mission.missionId}-${field}` : undefined} onChange={(event) => setProposal({ ...proposal, text: event.target.value, clientId: undefined })} disabled={posting} />
          <p className={s.hint}>{proposal.sourceRound !== round.round ? "审核已重新开放，旧建议输入已保留。请对照当前正文重新核对后再提交。" : effectivePhase === "open" ? "汇总后由拍板人处理这条修改建议。" : "审核已结束，输入已保留，可在重新开放审核后继续。"}{field === "milestones" || field === "successEvidence" ? " 每行一项，最多 30 项，每项不超过 500 字。" : ""}</p>
          {proposalError ? <p id={`proposal-error-${mission.missionId}-${field}`} className={s.proposalError} role="alert">{proposalError}</p> : null}
          <div className={s.inlineActions}>{proposal.sourceRound !== round.round && effectivePhase === "open" ? <Button variant="ghost" className={s.secondary} isDisabled={posting} onPress={() => propose(mission, field)}>已核对，继续建议</Button> : null}<Button variant="primary" className={s.primary} isDisabled={posting || !proposal.text.trim() || effectivePhase !== "open" || proposal.sourceRound !== round.round} onPress={() => void sendProposal()}>{posting ? "正在保存…" : "提交修改建议"}</Button><Button variant="ghost" className={s.secondary} isDisabled={posting} onPress={() => setProposal(null)}>取消</Button></div>
        </div> : null }} />
      </div>
    </DetailFrame>
    {tourOpen ? <MissionCardTour isOpen onExit={() => { mark(MISSION_CARD_TOUR_KEY); setTourOpen(false); }} /> : null}
    {dialog}
  </div>;
}
