"use client";

import { useEffect, useRef, useState } from "react";
import type { Card } from "@/lib/api/client";
import { ColumnComposer } from "./ColumnComposer";
import { ConversationColumn, conversationStyles as cs, type ConversationChannel } from "./ConversationColumn";
import { ConversationDock } from "./ConversationDock";
import { ConversationHistorySheet } from "./ConversationHistorySheet";
import { AttachmentStatus } from "./ConversationAttachments";
import { ConversationNotice, ConversationThinking, ConversationTurns } from "./Transcript";
import { useReferences } from "./references";
import { useColumnMode } from "./useColumnMode";
import { useConversation, type ConversationData } from "./useConversation";
import { useMissionGroup } from "./useMissionGroup";
import { MissionGroupTranscript } from "./MissionGroupTranscript";
import { MissionGroupComposer } from "./MissionGroupComposer";
import type { PersonalMissionGroup } from "./missionCardGroup";
import groupStyles from "@/styles/mission-group.module.css";
import w from "@/styles/app-shell.module.css";

export type ConversationTarget = { scope: string; label: string; group?: PersonalMissionGroup };
const GLOBAL: ConversationTarget = { scope: "global", label: "我的 Agent" };

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
  /** 待放进输入条的引用追问；输入条用过后清掉，换对象时也清掉。 */
  prefill: { text: string; nonce: number } | null;
  consumePrefill: () => void;
};

/**
 * 对话的外壳层（clark `workspace.tsx` 的对话编排）：
 * 首页 = 全局对话（我的 Agent）+ 历史层；二级页 = 右列（ConversationColumn）+ 右列底下的两行输入条。
 * 引用只为全局对话准备；在二级页已引用时，输入条上方出现「在全局讨论 · N」。
 */
export function ConversationHost({
  page,
  detailOpen,
  rail = detailOpen,
  agentTitle,
  ui,
}: {
  page: ConversationTarget | null;
  detailOpen: boolean;
  /** 是否用右列（二级页里的浏览面，如雷达列表，不用）。 */
  rail?: boolean;
  /** 右列页头上 Agent 的名字：「CEO Agent」「DRI Agent」。 */
  agentTitle: string;
  ui: ConversationUiState;
}) {
  const target = detailOpen && page && !ui.globalView ? page : GLOBAL;
  return <ScopedConversation key={target.scope} target={target} detailOpen={detailOpen} rail={rail} agentTitle={agentTitle} ui={ui} />;
}

function ScopedConversation({ target, detailOpen, rail, agentTitle, ui }: { target: ConversationTarget; detailOpen: boolean; rail: boolean; agentTitle: string; ui: ConversationUiState }) {
  const data = useConversation(target.scope);
  const references = useReferences();
  const global = target.scope === "global";
  const items = references?.items ?? [];
  const discussGlobal = () => {
    ui.setGlobalView(true);
    ui.setHistoryOpen(true);
  };

  if (rail && !ui.historyOpen) {
    return <RailConversation data={data} target={target} agentTitle={agentTitle} ui={ui} references={global ? [] : items} onDiscussGlobal={discussGlobal} />;
  }

  const closeHistory = () => {
    ui.setHistoryOpen(false);
    ui.setGlobalView(false);
  };

  return (
    <>
      {ui.historyOpen ? (
        <>
          <button type="button" className={w.historyBackdrop} data-testid="conversation-backdrop" aria-label="关闭对话记录" onClick={closeHistory} />
          <ConversationHistorySheet data={data} label={target.label} global={global} onClose={closeHistory} />
        </>
      ) : null}
      <ConversationDock
        data={data}
        label={target.label}
        global={global}
        detail={detailOpen}
        keyboard={ui.keyboard}
        onKeyboardChange={ui.setKeyboard}
        historyOpen={ui.historyOpen}
        onToggleHistory={() => (ui.historyOpen ? closeHistory() : ui.setHistoryOpen(true))}
        references={items}
        onRemoveReference={(id) => references?.remove(id)}
        onClearReferences={() => references?.clear()}
        onRestoreReferences={(cards) => references?.add(cards)}
        pendingGlobalReferences={!global && items.length ? items.length : 0}
        onDiscussGlobal={discussGlobal}
        prefill={ui.prefill}
        onPrefillUsed={ui.consumePrefill}
      />
    </>
  );
}

/** 二级页：右列放当前对象的对话，输入条在右列底下。 */
function RailConversation({
  data,
  target,
  agentTitle,
  ui,
  references,
  onDiscussGlobal,
}: {
  data: ConversationData;
  target: ConversationTarget;
  agentTitle: string;
  ui: ConversationUiState;
  references: Card[];
  onDiscussGlobal: () => void;
}) {
  const column = useColumnMode();
  const [composerHeight, setComposerHeight] = useState(90);
  const [channel, setChannel] = useState(target.group ? "group" : "agent");
  const end = useRef<HTMLDivElement>(null);
  const group = useMissionGroup(target.group, channel === "group" && (column.narrow ? ui.railMobileOpen : column.mode === "expanded"));
  const members = group.view?.members ?? target.group?.members ?? [];
  const channels: ConversationChannel[] = [
    { id: "agent", kind: "agent", label: "我的 Agent", title: agentTitle, unread: 0 },
    ...(target.group ? [{ id: "group", kind: "group" as const, label: `事项群组 · ${members.length + 1}`, title: `事项群组 · ${members.length + 1}`, unread: group.view?.unread ?? 0 }] : []),
  ];
  useEffect(() => {
    if (!target.group?.reference) return;
    setChannel("group");
    if (column.narrow) ui.setRailMobileOpen(true);
    else column.setMode("expanded");
    // 只响应用户新选出的引用，刷新不主动展开。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target.group?.reference?.nonce]);

  useEffect(() => {
    end.current?.scrollIntoView({ block: "nearest" });
  }, [data.messages, data.streaming, group.view?.entries.length, channel]);

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
      >
        {channel === "agent" ? <AttachmentStatus data={data} className={cs.error} /> : null}
        <div className={cs.log} role="log" aria-label={channel === "group" ? "事项群组公开讨论" : `与${agentTitle}的对话`} aria-live="polite" aria-relevant="additions text">
          {channel === "group" ? <MissionGroupTranscript entries={group.view?.entries ?? []} /> : <>
            {data.messages.length ? <ConversationTurns messages={data.messages} /> : !data.streaming ? <p className={cs.empty}>暂无消息</p> : null}
            {data.error && !data.streaming ? <ConversationNotice text={data.error} /> : null}
            {data.streaming ? <ConversationThinking stage={data.stage} startedAt={data.startedAt} onStop={data.stop} /> : null}
          </>}
          <div ref={end} />
        </div>
        <p className={`${cs.footnote} ${target.group ? groupStyles.groupFootnote : ""}`}>{channel === "group" ? `成员可见：${members.map((member) => member.displayName).join("、")}、Co-Agent` : target.group ? "仅你可见 · 只读：不改这张卡、不进集中 Review" : "仅你可见 · 只读：不改左侧内容、不形成决定"}</p>
      </ConversationColumn>
      {channel === "group" && target.group ? <MissionGroupComposer cardId={target.group.cardId} viewerId={target.group.viewerId} phase={target.group.phase} channels={channels} channel={channel} onChannel={setChannel} narrow={column.narrow} mobileOpen={ui.railMobileOpen} onMobileOpen={ui.setRailMobileOpen} onHeightChange={setComposerHeight} reference={target.group.reference ?? null} onRemoveReference={target.group.onRemoveReference} busy={group.sending} error={group.error} onSend={group.send} /> : <ColumnComposer
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
        draftOwnerId={target.group?.viewerId}
        allowAttachments={!target.group}
      />}
    </>
  );
}
