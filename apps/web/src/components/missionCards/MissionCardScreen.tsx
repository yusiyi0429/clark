"use client";

/** 整页移植 clark mission-cards/workspace；数据、权限、意见与阶段由 API 持有。 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Modal } from "@heroui/react";
import { Button } from "ts-design/primitives";
import type { TMissionCardField, TPersonalMissionCardPayload } from "@warmap/contracts";
import { browserApi, type Card, type CardAction } from "@/lib/api/client";
import { monthDayTime } from "@/lib/companyTime";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { useConfirm } from "@/components/ConfirmDialog";
import type { MissionGroupReference } from "@/conversation/missionCardGroup";
import { CardDocument, fieldNames, missionFieldText, selectedFieldQuote, type PersonalMission } from "./CardDocument";
import { RoundLine } from "./RoundLine";
import { RoundClock } from "./RoundClock";
import { useRoundNow } from "./useRoundNow";
import { clearRoundNote, readRoundNote, saveRoundNote } from "./roundNoteDraft";
import s from "./mission-card.module.css";

type Proposal = { missionId: string; field: TMissionCardField; sourceVersion: number; text: string; clientId?: string };
type RoundAction = Pick<CardAction, "actionId" | "actionType" | "label">;
function requestError(cause: unknown, fallback: string): string {
  if (!(cause instanceof Error) || cause instanceof TypeError || /failed to fetch|fetch failed|networkerror|network request failed|load failed/i.test(cause.message)) return fallback;
  return cause.message;
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
  const [goalsOpen, setGoalsOpen] = useState(false);
  const [noteDraft, setNoteDraft] = useState({ roundKey: "", text: "" });
  const [decisionError, setDecisionError] = useState<{ feedbackId: string; message: string } | null>(null);
  const { ask, dialog } = useConfirm();
  const refreshInFlight = useRef<Promise<void> | null>(null);
  const actionInFlight = useRef(false);
  const noteViewer = workspace.viewerId ?? card.ownerId;
  const roundKey = `${noteViewer}:${round.roundId}:${round.round}`;
  const note = noteDraft.roundKey === roundKey ? noteDraft.text : "";
  const acceptView = useCallback((next: Card) => setView((current) => next.id === current.id && next.version < current.version ? current : next), []);
  const now = useRoundNow(round.closesAt, round.serverNow);
  const effectivePhase = round.phase === "open" && round.closesAt && now >= Date.parse(round.closesAt) ? "closed" : round.phase;
  const shownPayload = useMemo(() => effectivePhase === round.phase ? payload : { ...payload, round: { ...round, phase: effectivePhase } }, [payload, round, effectivePhase]);
  const refresh = useCallback(() => {
    if (refreshInFlight.current) return refreshInFlight.current;
    refreshInFlight.current = (async () => {
      try {
        const { data, response, error: failure } = await browserApi.GET("/api/mission-cards/{cardId}", { params: { path: { cardId: card.cardId } } });
        if (response.status === 401) { router.push("/access"); return; }
        if (!response.ok || !data?.cards[0]) throw new Error(failure?.message ?? "暂时无法刷新个人卡，请稍后重试");
        acceptView(data.cards[0]);
      } catch (cause) { setError(requestError(cause, "暂时无法刷新个人卡，请检查网络后重试。")); }
      finally { refreshInFlight.current = null; }
    })();
    return refreshInFlight.current;
  }, [card.cardId, router, acceptView]);
  const focusFeedback = (id: string) => {
    const element = document.getElementById(`feedback-${id}`);
    element?.focus({ preventScroll: true });
    element?.scrollIntoView({ block: "center", behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth" });
  };
  useEffect(() => {
    const feedbackId = new URLSearchParams(window.location.search).get("feedback");
    if (!feedbackId) return;
    // 先让共同工作台完成入场与关闭按钮定位，再把焦点交给实际待处理意见。
    let frame = window.requestAnimationFrame(() => { frame = window.requestAnimationFrame(() => focusFeedback(feedbackId)); });
    return () => window.cancelAnimationFrame(frame);
  }, [card.cardId]);
  useEffect(() => {
    setNoteDraft({ roundKey, text: readRoundNote(noteViewer, round.roundId, round.round) });
  }, [roundKey, noteViewer, round.roundId, round.round]);
  const startProcessing = () => {
    const target = round.cards.find((row) => row.pending > 0 && row.firstPendingFeedbackId);
    if (!target?.firstPendingFeedbackId) return;
    if (target.cardId === card.cardId) focusFeedback(target.firstPendingFeedbackId);
    else workspace.navigate(`${entry === "member" ? "/me" : ""}/mission-cards/${target.cardId}?feedback=${encodeURIComponent(target.firstPendingFeedbackId)}`);
  };
  useEffect(() => {
    if (effectivePhase !== "closed") return;
    void refresh();
    const timer = setInterval(() => void refresh(), 3_000);
    return () => clearInterval(timer);
  }, [effectivePhase, refresh]);
  const removeReference = useCallback(() => setReference(null), []);
  const cards = useMemo(() => [view], [view]);
  const group = useMemo(() => ({ cardId: card.cardId, viewerId: workspace.viewerId ?? card.ownerId, members: card.members, phase: effectivePhase, round: round.round, reference, onRemoveReference: removeReference, onRefresh: refresh }), [card.cardId, card.ownerId, workspace.viewerId, card.members, effectivePhase, round.round, reference, removeReference, refresh]);
  const title = `${card.ownerName} · ${Number(round.period.slice(5))} 月 Mission Card`;
  useRegisterDetail({ scope: `mission-card:${card.cardId}`, label: title, mark: null, cards, group });

  const quote = (mission: PersonalMission, field: TMissionCardField, text: string) => {
    if (text.length > 2000) { setError("这段超过 2000 字，请划选其中一段引用。"); return; }
    setReference({ missionId: mission.missionId, field, quote: text, sourceVersion: mission.version, nonce: Date.now() });
    setError("");
  };
  const select = (mission: PersonalMission, field: TMissionCardField, node: HTMLElement) => {
    const text = selectedFieldQuote(node, window.getSelection());
    if (text) quote(mission, field, text);
  };
  const propose = (mission: PersonalMission, field: TMissionCardField) => {
    setProposal((current) => current?.missionId === mission.missionId && current.field === field ? current : { missionId: mission.missionId, field, sourceVersion: mission.version, text: missionFieldText(mission, field) });
    setProposalError(""); setNotice("");
  };
  const sendProposal = async () => {
    if (!proposal || posting || !proposal.text.trim()) return;
    const clientId = proposal.clientId ?? crypto.randomUUID();
    setProposal({ ...proposal, clientId }); setPosting(true); setProposalError(""); setNotice("");
    try {
      const { response, error: failure } = await browserApi.POST("/api/mission-cards/{cardId}/feedback", { params: { path: { cardId: card.cardId } }, body: { clientId, kind: "suggestion", round: round.round, missionId: proposal.missionId, field: proposal.field, proposed: proposal.text, sourceVersion: proposal.sourceVersion, body: `建议修改「${fieldNames[proposal.field]}」` } });
      if (!response.ok) throw new Error(failure?.message ?? "修改建议未保存，请重试；输入已保留。");
      setProposal(null); setNotice("修改建议已记录，当前正文不变；截止后由拍板人集中处理。");
      void refresh();
    } catch (cause) { setProposalError(requestError(cause, "暂时无法连接服务器，请稍后重试；输入已保留。")); }
    finally { setPosting(false); }
  };
  const runAction = async (action: RoundAction, input?: { decision: "accept" | "decline" } | { note: string }, feedbackId?: string) => {
    if (actionInFlight.current) return;
    if (action.actionType === "mission-round.reopen" && !await ask(`${round.battlefieldName}的 ${round.counts.cards} 张 Mission Card 一起重新开放 48 小时（第 ${round.round + 1} 轮）。预计 ${monthDayTime(new Date(now + 48 * 3_600_000).toISOString())} 截止，实际从提交成功时起算。已有公开意见全部保留；已处理结论进入下一轮，协作核对结论需要重写；截止后留言将在下次截止时收取。不会另外通知同事。`, "重新开启 48 小时")) return;
    actionInFlight.current = true;
    setPending(true); setError(""); setDecisionError(null); setNotice("");
    try {
      const { data, response, error: failure } = await browserApi.POST("/api/mission-rounds/actions/execute", { body: { actionId: action.actionId, viewCardId: card.cardId, ...(input ? { input } : {}) } });
      if (response.status === 401) { router.push("/access"); return; }
      if (!response.ok) {
        const latest = (failure as { latestCard?: Card } | undefined)?.latestCard;
        if (latest?.kind === "personal-mission-card") acceptView(latest);
        throw new Error(failure?.message ?? "本轮操作未保存，请重试");
      }
      const next = data?.cards[0];
      if (next?.kind === "personal-mission-card") acceptView(next); else await refresh();
      if (action.actionType === "mission-round.reopen" || action.actionType === "mission-round.confirm") { clearRoundNote(noteViewer, round.roundId, round.round); setNoteDraft({ roundKey: "", text: "" }); setReference(null); setProposal(null); }
      setNotice(action.actionType === "mission-round.open" ? "全战场已统一开放 48 小时讨论。" : action.actionType === "mission-round.reopen" ? "已重新开启 48 小时讨论，已有公开意见保留。" : action.actionType === "mission-round.confirm" ? "本月 Mission Card 已确定，确认记录与公开意见保留可查。" : "");
      router.refresh();
    } catch (cause) { const message = requestError(cause, "暂时无法连接服务器，请稍后重试；本轮输入已保留。"); if (feedbackId) setDecisionError({ feedbackId, message }); else setError(message); }
    finally { actionInFlight.current = false; setPending(false); }
  };
  return <div className={s.screen}>
    <DetailFrame title={title} subtitle={round.battlefieldName} onBack={workspace.close} actions={<RoundClock round={shownPayload.round} now={now} />}>
      <div className={s.content}>
        <RoundLine payload={shownPayload} actions={view.actions} viewerId={workspace.viewerId} pending={pending} onAction={(action, input) => void runAction(action, input)} onSelectCard={(id) => workspace.navigate(`${entry === "member" ? "/me" : ""}/mission-cards/${id}`)} onViewGoals={() => setGoalsOpen(true)} onStartProcessing={startProcessing} note={note} onNoteChange={(text) => { setNoteDraft({ roundKey, text }); saveRoundNote(noteViewer, round.roundId, round.round, text); }} error={error} />
        {error && !(effectivePhase === "reviewing" && round.approver && !round.counts.pending) ? <p className={s.error} role="alert">{error}</p> : null}
        {notice ? <p className={s.notice} role="status">{notice}</p> : null}
        <CardDocument payload={shownPayload} controls={{ onQuote: quote, onPropose: propose, onSelect: select, pending, decisionError, onDecide: (item, decision) => { const action = item.actions.find((candidate) => candidate.actionType === "mission-round.decide"); if (action) void runAction(action, { decision }, item.id); }, proposalEditor: (mission, field) => proposal?.missionId === mission.missionId && proposal.field === field && effectivePhase !== "confirmed" ? <div className={s.proposal}>
          <label htmlFor={`proposal-${mission.missionId}-${field}`}>建议修改：{fieldNames[field]}</label>
          <textarea id={`proposal-${mission.missionId}-${field}`} value={proposal.text} maxLength={field === "title" ? 200 : 4000} rows={4} autoFocus aria-describedby={proposalError ? `proposal-error-${mission.missionId}-${field}` : undefined} onChange={(event) => setProposal({ ...proposal, text: event.target.value, clientId: undefined })} disabled={posting} />
          <p className={s.hint}>{effectivePhase === "open" ? "当前正文不变；截止后由拍板人集中处理。" : "讨论已截止，不能再提交修改建议；输入已保留，可在重新开放后继续。"}{field === "milestones" || field === "successEvidence" ? " 每行一项，最多 30 项，每项不超过 500 字。" : ""}</p>
          {proposalError ? <p id={`proposal-error-${mission.missionId}-${field}`} className={s.proposalError} role="alert">{proposalError}</p> : null}
          <div className={s.inlineActions}><Button variant="primary" className={s.primary} isDisabled={posting || !proposal.text.trim() || effectivePhase !== "open"} onPress={() => void sendProposal()}>{posting ? "正在保存…" : "提交修改建议"}</Button><Button variant="ghost" className={s.secondary} isDisabled={posting} onPress={() => setProposal(null)}>取消</Button></div>
        </div> : null }} />
      </div>
    </DetailFrame>
    <Modal isOpen={goalsOpen} onOpenChange={setGoalsOpen}><Modal.Backdrop isDismissable><Modal.Container><Modal.Dialog className={s.dialog} aria-label="本轮目标依据"><h2>本轮目标依据</h2>{round.goals ? <><p>{monthDayTime(round.goals.signedAt)} 月度计划已签发。{round.phase === "draft" ? "统一开放时冻结这一轮的目标依据。" : "讨论开放后不能覆盖这一轮的目标依据。"}</p><h3>六个月目标</h3><p>{round.goals.sixMonthOutcome}</p><h3>本月目标</h3><p>{round.goals.monthOutcome}</p></> : <p>本轮目标依据尚未冻结。</p>}<footer><Button variant="ghost" className={s.secondary} onPress={() => setGoalsOpen(false)}>关闭</Button></footer></Modal.Dialog></Modal.Container></Modal.Backdrop></Modal>
    {dialog}
  </div>;
}
