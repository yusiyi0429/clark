"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import type { Card } from "@/lib/api/client";
import { ColumnComposer } from "./ColumnComposer";
import { ConversationColumn, conversationStyles as cs, type ConversationChannel } from "./ConversationColumn";
import { ConversationDock } from "./ConversationDock";
import { ConversationHistorySheet } from "./ConversationHistorySheet";
import { AttachmentStatus } from "./ConversationAttachments";
import { ConversationHistoryState, conversationOwner } from "./ConversationHistoryState";
import { ConversationNotice, ConversationStatusSlot, JumpToLatest } from "./Transcript";
import { ConversationTimeline } from "./ConversationTimeline";
import { ArchiveEntry, ConversationArchive, NewConversationKey, useArchivePanel } from "./ConversationArchive";
import { SelectionToolbar, useSelectionQuote } from "@/components/SelectionQuote";
import { useConversationScroll } from "./useConversationScroll";
import { useReferences } from "./references";
import { useExitPresence } from "@/lib/motion";
import { useColumnMode } from "./useColumnMode";
import { useDeskColumnWidth, useViewportWidth } from "./desk/useDeskLayout";
import { DESK_MIN_VIEWPORT } from "./desk/deskLayout";
import { useConversation, type ConversationData } from "./useConversation";
import { useStableCallback } from "./stableCallback";
import { useMissionGroup } from "./useMissionGroup";
import { useThreadGroup } from "./useTaskGroup";
import { ThreadMembersMenu } from "./ThreadMembersMenu";
import { TaskGroupTranscript } from "./TaskGroupTranscript";
import { MissionGroupTranscript } from "./MissionGroupTranscript";
import { MissionGroupComposer } from "./MissionGroupComposer";
import { PresenceCapsule } from "@/components/coagent/PresenceCapsule";
import { useListening } from "@/components/coagent/presence";
import { useCoAgentSkin } from "@/components/coagent/skin";
import type { DetailGroup } from "./missionCardGroup";
import { MESSAGE_REPLY, type QuotePrefill, type QuoteSource, type TextQuote } from "./quotes";
import groupStyles from "@/styles/mission-group.module.css";
import w from "@/styles/app-shell.module.css";

/** 对话层退场时长：与 app-shell.module.css 里 historySink 的时长一致。 */
export const SHEET_EXIT_MS = 220;

export type ConversationTarget = { scope: string; label: string; group?: DetailGroup; messageContext?: string };
const GLOBAL: ConversationTarget = { scope: "global", label: "天枢" };
/** 没有引用上下文时的空列表：身份固定，输入条（memo）不因它重画。 */
const NO_CARDS: Card[] = [];

export type ConversationUiState = {
  keyboard: boolean;
  setKeyboard: (keyboard: boolean) => void;
  historyOpen: boolean;
  setHistoryOpen: (open: boolean) => void;
  /** 在二级页里改看全局对话（「在全局讨论 · N」）。 */
  globalView: boolean;
  setGlobalView: (global: boolean) => void;
  railMobileOpen: boolean;
  setRailMobileOpen: (open: boolean) => void;
  /** 深度讨论（并排）开没开：外壳持有，换页、打开对话层时收起；右列在 <1280、收起、窄屏时也收起它。 */
  deskOpen?: boolean;
  setDeskOpen?: (open: boolean) => void;
  /** 对话层放大（首页全局对话等）：外壳持有，收起对话层、换页时收起；<1280 不提供，变窄自动收起。 */
  sheetWide?: boolean;
  setSheetWide?: (wide: boolean) => void;
  /** New selection focuses private input; independent references remain until sent/removed. */
  prefill: QuotePrefill | null;
  consumePrefill: (nonce?: number) => void;
  quotes: TextQuote[];
  removeQuotes: (ids: string[]) => void;
  /** 发送失败放回引用（D5）：不覆盖期间新加的引用。 */
  restoreQuotes: (quotes: TextQuote[]) => void;
  /** 对话正文里划词「引用」（B4）：进这条对话自己的引用条，对话层 / 右列保持原样，不跳到别的对话。 */
  quoteInConversation: (text: string, source: QuoteSource & { scope: string }) => void;
};

/**
 * 对话的外壳层（clark `workspace.tsx` 的对话编排）：
 * 首页 = 全局对话（天枢）+ 对话层；二级页 = 右列（ConversationColumn）+ 右列底下的两行输入条。
 * 全局输入条的打字面和对话层一起开合（D6）：从语音胶囊进入打字（键盘键、「点击说话」、新引用）就升起对话层；
 * 收起对话层（⌄、点空白、Esc）输入条回到胶囊，草稿留着。没有外置气泡，消息与出错说明都在对话层里。
 * 引用只为全局对话准备；在二级页已引用时，输入条上方出现「在全局讨论 · N」。
 */
export function ConversationHost({
  page,
  detailOpen,
  rail = detailOpen,
  agentTitle,
  pageSubject,
  ui,
}: {
  page: ConversationTarget | null;
  detailOpen: boolean;
  /** 是否用右列（二级页里的浏览面，如雷达列表，不用）。 */
  rail?: boolean;
  /** 右列页头上 Agent 的名字：统一「天枢」。 */
  agentTitle: string;
  /** 页面本身是全局对话、但有明确对象时（战场页）右列页头写的对象名，如「增长战场」；不给就不写。 */
  pageSubject?: string | null;
  ui: ConversationUiState;
}) {
  const onPage = Boolean(detailOpen && page && !ui.globalView);
  const target = onPage && page ? page : GLOBAL;
  // 右列页头标题下那一行：这条对话围绕谁。对象页 = 对象标题；战场页 = 战场名；二级页里改看全局对话 = 全局；其余全局页不写。
  const subject = !onPage ? "全局" : target.scope !== "global" ? target.label : pageSubject ?? null;
  return <ScopedConversation key={target.scope} target={target} detailOpen={detailOpen} rail={rail} agentTitle={agentTitle} subject={subject} ui={ui} />;
}

function ScopedConversation({ target, detailOpen, rail, agentTitle, subject, ui }: { target: ConversationTarget; detailOpen: boolean; rail: boolean; agentTitle: string; subject: string | null; ui: ConversationUiState }) {
  const router = useRouter();
  const [viewingMaterial, setViewingMaterial] = useState<{ id: string; editable: boolean; format?: string } | null>(null);
  useEffect(() => {
    const current = [...document.querySelectorAll<HTMLElement>("[data-material-scope]")]
      .find((element) => element.dataset.materialScope === target.scope);
    setViewingMaterial(current?.dataset.viewingMaterialId ? { id: current.dataset.viewingMaterialId,
      editable: current.dataset.viewingMaterialEditable === "true", format: current.dataset.viewingMaterialFormat } : null);
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ scope: string; id: string | null; editable: boolean; format?: string }>).detail;
      if (detail?.scope === target.scope) setViewingMaterial(detail.id ? { id: detail.id, editable: detail.editable, format: detail.format } : null);
    };
    window.addEventListener("viewing-material-changed", changed);
    return () => window.removeEventListener("viewing-material-changed", changed);
  }, [target.scope]);
  const data = useConversation(target.scope, viewingMaterial, target.messageContext);
  useEffect(() => {
    const refreshObject = (event: Event) => {
      if ((event as CustomEvent<{ scope: string }>).detail?.scope === target.scope) router.refresh();
    };
    window.addEventListener("conversation-object-changed", refreshObject);
    return () => window.removeEventListener("conversation-object-changed", refreshObject);
  }, [target.scope, router]);
  const { setHistoryOpen } = ui;
  /** 全局输入条那一块：对话层的 ↓ 按它的上沿定位（D3）。 */
  const dockRef = useRef<HTMLDivElement>(null);
  const references = useReferences();
  const global = target.scope === "global";
  const items = references?.items ?? NO_CARDS;
  const discussGlobal = useStableCallback(() => {
    ui.setGlobalView(true);
    ui.setHistoryOpen(true);
  });

  /** 听写出错（没授权、没听清）：输入条交上来，在对话层里说（D6）。 */
  const [dictationError, setDictationError] = useState<string | null>(null);
  // 新引用 / 起草（引用提问、划词引用、起草文档）在没有右列的页面上：打字面和对话层一起出来。
  const usesDock = !rail || ui.historyOpen;
  useEffect(() => {
    if (ui.prefill && usesDock) setHistoryOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只响应新的预填
  }, [ui.prefill?.nonce]);

  // 收起对话层：淡出下移播完（SHEET_EXIT_MS）再卸载，与打开对称；有右列的页面收起后换成右列，不留退场。
  const sheet = useExitPresence(ui.historyOpen, SHEET_EXIT_MS);
  // 对话层放大：≥1280 才有 ⤢；变窄到 <1280 自动收起，变宽回来不自己再放大。
  const viewport = useViewportWidth();
  const canWide = Boolean(ui.setSheetWide) && viewport >= DESK_MIN_VIEWPORT;
  const { sheetWide = false, setSheetWide } = ui;
  useEffect(() => {
    if (sheetWide && !canWide) setSheetWide?.(false);
  }, [sheetWide, canWide, setSheetWide]);

  const closeHistory = useStableCallback(() => {
    ui.setHistoryOpen(false);
    ui.setGlobalView(false);
    ui.setKeyboard(false);
  });
  const openHistory = useStableCallback(() => {
    ui.setKeyboard(true);
    ui.setHistoryOpen(true);
  });
  // 交给输入条（memo）的回调与列表身份不变：流式中这里每帧重画，输入条不跟着重画。
  const keyboardChange = useStableCallback((keyboard: boolean) => (keyboard ? openHistory() : closeHistory()));
  const removeReference = useStableCallback((id: string) => references?.remove(id));
  const clearReferences = useStableCallback(() => references?.clear());
  const restoreReferences = useStableCallback((cards: Card[]) => references?.add(cards));
  const wideExit = useStableCallback(() => setSheetWide?.(false));
  const scopeQuotes = useMemo(() => ui.quotes.filter((item) => item.source?.scope === target.scope), [ui.quotes, target.scope]);

  if (rail && !ui.historyOpen) {
    return <RailConversation data={data} target={target} agentTitle={agentTitle} subject={subject} ui={ui} references={global ? [] : items} onDiscussGlobal={discussGlobal} />;
  }

  return (
    <>
      {sheet.mounted ? (
        <>
          <button type="button" className={w.historyBackdrop} data-testid="conversation-backdrop" aria-label="关闭对话记录" onClick={closeHistory}
            data-leaving={sheet.leaving || undefined} tabIndex={sheet.leaving ? -1 : undefined} />
          <ConversationHistorySheet data={data} label={target.label} global={global} onClose={closeHistory} composerRef={dockRef} leaving={sheet.leaving}
            wide={canWide && sheetWide} onWide={canWide ? setSheetWide : undefined}
            notice={dictationError} onQuote={(text) => ui.quoteInConversation(text, { scope: target.scope, intent: MESSAGE_REPLY })} />
        </>
      ) : null}
      <ConversationDock
        data={data}
        label={target.label}
        global={global}
        detail={detailOpen}
        keyboard={ui.historyOpen}
        onKeyboardChange={keyboardChange}
        historyOpen={ui.historyOpen}
        onDictationError={setDictationError}
        references={items}
        onRemoveReference={removeReference}
        onClearReferences={clearReferences}
        onRestoreReferences={restoreReferences}
        pendingGlobalReferences={!global && items.length ? items.length : 0}
        onDiscussGlobal={discussGlobal}
        prefill={ui.prefill}
        onPrefillUsed={ui.consumePrefill}
        textQuotes={scopeQuotes}
        onRemoveQuotes={ui.removeQuotes}
        onRestoreQuotes={ui.restoreQuotes}
        dockRef={dockRef}
        wide={canWide && sheetWide}
        onWideExit={wideExit}
      />
    </>
  );
}

/** 胶囊为新人讲来龙去脉出现多久（含凝回去之前），和凝回去要多久（coagent-capsule.module.css 的 capsuleOut）。 */
const CATCH_UP_MS = 4200;
const CAPSULE_OUT_MS = 320;

/** 二级页：右列放当前对象的对话，输入条在右列底下。 */
function RailConversation({
  data,
  target,
  agentTitle,
  subject,
  ui,
  references,
  onDiscussGlobal,
}: {
  data: ConversationData;
  target: ConversationTarget;
  agentTitle: string;
  subject: string | null;
  ui: ConversationUiState;
  references: Card[];
  onDiscussGlobal: () => void;
}) {
  const column = useColumnMode();
  // 深度讨论：≥1280、右列展开、不在窄屏才有 ⤢；私聊、群聊都能展开。变窄 / 收起时外壳那边一起收起，变宽回来不自己再展开。
  const deskColumn = useDeskColumnWidth();
  const { deskOpen: deskWanted = false, setDeskOpen } = ui;
  const canDesk = Boolean(setDeskOpen) && !column.narrow && column.mode === "expanded" && deskColumn !== null;
  const deskOpen = canDesk && deskWanted;
  useEffect(() => {
    if (deskWanted && !canDesk) setDeskOpen?.(false);
  }, [deskWanted, canDesk, setDeskOpen]);
  const [composerHeight, setComposerHeight] = useState(90);
  const [selectedChannel, setChannel] = useState("agent");
  // 新引用在这一帧就进入私聊，不能先挂载公开输入条；下方 effect 保留消费后的频道。
  const openedGroupDeepLink = useRef<string | null>(null);
  const taskGroup = target.group?.kind === "task" ? target.group : undefined;
  const otherThread = target.group?.kind === "thread" ? target.group : undefined;
  const threadGroup = taskGroup || otherThread;
  const personalContext = target.group && target.group.kind !== "task" && target.group.kind !== "thread" ? target.group : undefined;
  const missionGroup = personalContext?.canDiscuss !== false ? personalContext : undefined;
  const hasGroup = !!(threadGroup || missionGroup);
  const channel = ui.prefill || !hasGroup ? "agent" : selectedChannel;
  const groupVisible = channel === "group" && (column.narrow ? ui.railMobileOpen : column.mode === "expanded");
  const group = useMissionGroup(missionGroup, groupVisible);
  const thread = useThreadGroup(otherThread?.objectType ?? "task", taskGroup?.taskId ?? otherThread?.objectId, groupVisible);
  const listening = useListening(target.scope);
  const [skin] = useCoAgentSkin();
  // 新人第一次进群、群里有 Co-Agent 讲的来龙去脉：群聊看得见时，胶囊出现几秒，那段话同时亮一下。每段只一次。
  const [catchUp, setCatchUp] = useState<{ id: number; leaving: boolean } | null>(null);
  const shownCatchUps = useRef(new Set<number>());
  useEffect(() => {
    const id = thread.catchUp;
    if (!groupVisible) { setCatchUp(null); return; }
    if (id === null || shownCatchUps.current.has(id)) return;
    shownCatchUps.current.add(id);
    setCatchUp({ id, leaving: false });
    const leave = window.setTimeout(() => setCatchUp({ id, leaving: true }), CATCH_UP_MS);
    const gone = window.setTimeout(() => setCatchUp(null), CATCH_UP_MS + CAPSULE_OUT_MS);
    return () => { window.clearTimeout(leave); window.clearTimeout(gone); };
  }, [thread.catchUp, groupVisible]);
  const capsule = listening || catchUp
    ? <PresenceCapsule skin={skin} pose={catchUp && (!catchUp.leaving || !listening) ? "speaking" : "listening"} leaving={!listening && !!catchUp?.leaving} />
    : undefined;
  const members = threadGroup ? (thread.view?.members ?? threadGroup.members) : (group.view?.members ?? missionGroup?.members ?? []);
  const groupLabel = otherThread?.objectType === "issue" ? "议题群聊" : otherThread?.objectType === "meeting" ? "会议群聊" : "事项群组";
  const channels: ConversationChannel[] = [
    { id: "agent", kind: "agent", label: "天枢", title: agentTitle, ...(subject ? { subtitle: `围绕：${subject}` } : {}), unread: 0 },
    ...(hasGroup ? [{ id: "group", kind: "group" as const, label: `${groupLabel} · ${members.length + (missionGroup ? 1 : 0)}`,
      title: otherThread ? `${target.label} · ${members.length} 人` : `${groupLabel} · ${members.length + (missionGroup ? 1 : 0)}`,
      unread: threadGroup ? (thread.view?.unread ?? 0) : (group.view?.unread ?? 0) }] : []),
  ];
  useEffect(() => {
    if (!hasGroup || new URLSearchParams(window.location.search).get("channel") !== "group") return;
    if (openedGroupDeepLink.current !== target.scope) {
      openedGroupDeepLink.current = target.scope;
      setChannel("group");
    } else if (channel !== "group") return;
    if (column.narrow) ui.setRailMobileOpen(true);
    else column.setMode("expanded");
    // 首次通知深链选择群聊；水合或宽窄变化只展开当前群聊，不覆盖用户后来选择的私聊。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.scope, column.narrow, hasGroup]);
  useEffect(() => {
    if (!threadGroup) return;
    const open = (event: Event) => {
      const detail = (event as CustomEvent<{ objectType: string; objectId: string }>).detail;
      if (detail?.objectType !== (otherThread?.objectType ?? "task") || detail.objectId !== (taskGroup?.taskId ?? otherThread?.objectId)) return;
      setChannel("group");
      if (column.narrow) ui.setRailMobileOpen(true);
      else column.setMode("expanded");
    };
    window.addEventListener("open-thread-channel", open);
    return () => window.removeEventListener("open-thread-channel", open);
  }, [threadGroup, taskGroup?.taskId, otherThread?.objectType, otherThread?.objectId, column, ui]);
  // 在议题页刚拉人建群：群一出现就切到群聊，让人看到新成员和开场介绍。只认这一页自己的群。
  const openGroupFor = useRef<string | null>(null);
  useEffect(() => {
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ objectType: string; objectId: string }>).detail;
      if (detail && `${detail.objectType}:${detail.objectId}` === target.scope) openGroupFor.current = detail.objectId;
    };
    window.addEventListener("thread-members-changed", changed);
    return () => window.removeEventListener("thread-members-changed", changed);
  }, [target.scope]);
  useEffect(() => {
    if (!otherThread || openGroupFor.current !== otherThread.objectId) return;
    openGroupFor.current = null;
    setChannel("group");
    if (column.narrow) ui.setRailMobileOpen(true);
    else column.setMode("expanded");
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在群出现的那一下切换
  }, [otherThread?.objectId]);
  useEffect(() => {
    if (!missionGroup) return;
    const open = (event: Event) => {
      if ((event as CustomEvent<{ cardId: string }>).detail?.cardId !== missionGroup.cardId) return;
      setChannel("group");
      if (column.narrow) ui.setRailMobileOpen(true);
      else column.setMode("expanded");
    };
    window.addEventListener("open-mission-group-channel", open);
    return () => window.removeEventListener("open-mission-group-channel", open);
  }, [missionGroup?.cardId, column, ui]);
  useEffect(() => {
    if (!missionGroup?.reference) return;
    setChannel("group");
    if (column.narrow) ui.setRailMobileOpen(true);
    else column.setMode("expanded");
    // 只响应用户新选出的引用，刷新不主动展开。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [missionGroup?.reference?.nonce]);

  useEffect(() => {
    if (!ui.prefill) return;
    // 「引用并对话」明确进入私聊；公开频道的输入条不会消费 Agent 的预填内容。
    setChannel("agent");
    if (column.narrow) ui.setRailMobileOpen(true);
    else column.setMode("expanded");
    // 只响应新的引用，消费预填后仍留在私聊；普通重绘不切换频道。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ui.prefill?.nonce]);

  // 滚动（与全局对话层同一套）：私聊开始回答时刚发的那条推到顶部、回答中不跟随；群聊发送时（消息等服务端回来才出现）照旧回到底部并跟随；换频道回到底部。
  const sendingHere = channel === "agent" ? data.streaming : Boolean(threadGroup ? thread.sending : group.sending);
  // 全局对话（战场页右栏等）：页头左上角一颗很小的「+ 新对话」；空白对话里有归档过的对话时多一行很淡的「查看历史对话」。
  const globalAgent = channel === "agent" && target.scope === "global";
  const archive = useArchivePanel(data.streaming);
  const scroll = useConversationScroll({ streaming: sendingHere, resetKey: channel });
  // 划词引用（B4）：只在私聊正文里，引用进这条右列对话。
  const selection = useSelectionQuote(scroll.scrollRef, { within: "[data-chat-role]" });

  // 页脚只标谁看得到：私聊「仅你可见」，群组「成员可见」。
  const owner = conversationOwner(target.scope, target.label);

  return (
    <>
      <ConversationColumn
        testId="topic-conversation-rail"
        ariaLabel={`${target.label} · 对话`}
        channels={channels}
        channel={channel}
        onChannel={setChannel}
        mode={column.mode}
        onMode={column.setMode}
        mobileOpen={ui.railMobileOpen}
        onMobileOpen={ui.setRailMobileOpen}
        composerHeight={composerHeight}
        coagent={capsule}
        coagentBrief={!listening}
        deskWidth={deskOpen ? deskColumn : null}
        onDesk={canDesk ? setDeskOpen : undefined}
        headerAction={channel === "group" && threadGroup && !thread.left ? <ThreadMembersMenu objectType={otherThread?.objectType ?? "task"} objectId={taskGroup?.taskId ?? otherThread!.objectId} viewerId={threadGroup.viewerId} members={(thread.view?.members ?? threadGroup.members.map((member) => ({ ...member, title: null })))} onChanged={() => void thread.refresh()} />
          : globalAgent ? <NewConversationKey data={data} className={cs.newKey} /> : undefined}
      >
        {channel === "agent" ? <AttachmentStatus data={data} className={cs.error} /> : null}
        <div className={cs.log} ref={scroll.scrollRef} onMouseUp={channel === "agent" ? selection.onMouseUp : undefined} role="log" aria-label={channel === "group" ? `${groupLabel}公开讨论` : `与${agentTitle}的对话`} aria-live="polite" aria-relevant="additions text">
          <div ref={scroll.contentRef}>
          {channel === "group" ? threadGroup ? <TaskGroupTranscript messages={thread.view?.messages ?? []} highlightId={catchUp?.id} /> : <MissionGroupTranscript entries={group.view?.entries ?? []} />
            : globalAgent && archive.open ? <ConversationArchive data={data} onClose={archive.hide} /> : <>
            <ConversationTimeline data={data} />
            <ConversationHistoryState data={data} empty={<>
              <p className={cs.empty}>暂无消息</p>
              {globalAgent ? <ArchiveEntry data={data} onOpen={archive.show} /> : null}
            </>} />
            {data.switchError ? <ConversationNotice text={data.switchError} /> : null}
            {data.error && !data.streaming ? <ConversationNotice text={data.error} action={data.recovery} /> : null}
            {/* 回答进行中，思考与进度排在时间线里本轮正文之后、本轮卡片之前（ConversationTimeline）；这里只在没有回答进行时留出同样高度的空位。 */}
            {data.streaming ? null : <ConversationStatusSlot />}
          </>}
          </div>
          {/* 发送后置顶用的留白：放在内容之后，高度由 useConversationScroll 直接写。 */}
          <div ref={scroll.reserveRef} aria-hidden />
          {channel === "agent" ? <SelectionToolbar selected={selection.selected} label="回复" onQuote={() => {
            if (selection.selected) ui.quoteInConversation(selection.selected.text, { scope: target.scope, intent: MESSAGE_REPLY });
            selection.clear();
          }} /> : null}
        </div>
        {/* ↓ 按右列 panel 定位，底边贴着输入条上沿（--conversation-composer-height，D3）；Agent 输出中是三点。 */}
        <JumpToLatest visible={!scroll.atBottom} onJump={scroll.jumpToLatest} streaming={channel === "agent" && data.streaming} className={cs.latestJump} />
        <p className={`${cs.footnote} ${target.group ? groupStyles.groupFootnote : ""}`} data-conversation-owner={channel === "group" ? "group" : owner.global ? "global" : "object"}>{channel === "group" ? threadGroup && thread.left ? "已退出该群组" : "成员可见" : "仅你可见"}</p>
      </ConversationColumn>
      {channel === "group" && target.group ? <MissionGroupComposer cardId={taskGroup?.taskId ?? otherThread?.objectId ?? missionGroup!.cardId} taskId={taskGroup?.taskId ?? otherThread?.objectId} viewerId={target.group.viewerId} phase={threadGroup ? "open" : missionGroup!.phase} channels={channels} channel={channel} onChannel={setChannel} narrow={column.narrow} mobileOpen={ui.railMobileOpen} onMobileOpen={ui.setRailMobileOpen} onHeightChange={setComposerHeight} reference={missionGroup?.reference ?? null} onRemoveReference={missionGroup?.onRemoveReference ?? (() => {})} busy={threadGroup ? thread.sending : group.sending} readOnly={thread.left} error={threadGroup ? thread.error : group.error} onSend={threadGroup ? (body) => thread.send(body) : group.send} /> : <ColumnComposer
        data={data}
        label={target.label}
        channels={channels}
        channel={channel}
        onChannel={setChannel}
        narrow={column.narrow}
        mobileOpen={ui.railMobileOpen}
        onMobileOpen={ui.setRailMobileOpen}
        references={references}
        onDiscussGlobal={onDiscussGlobal}
        onHeightChange={setComposerHeight}
        prefill={ui.prefill}
        onPrefillUsed={ui.consumePrefill}
        textQuotes={ui.quotes.filter((item) => item.source?.scope === target.scope)}
        onRemoveQuotes={ui.removeQuotes}
        onRestoreQuotes={ui.restoreQuotes}
        draftOwnerId={target.group?.viewerId}
        allowAttachments={!target.group}
      />}
    </>
  );
}
