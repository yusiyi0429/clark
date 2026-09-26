"use client";

import { useState } from "react";
import { ConversationDock } from "./ConversationDock";
import { ConversationHistorySheet } from "./ConversationHistorySheet";
import { TopicConversationRail } from "./TopicConversationRail";
import { useReferences } from "./references";
import { useConversation } from "./useConversation";
import w from "@/styles/app-shell.module.css";

export type ConversationTarget = { scope: string; label: string };
const GLOBAL: ConversationTarget = { scope: "global", label: "公司全局" };

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
 * 首页 = 全局对话 + 历史层；二级页 = 该对象的对话列，输入条移进对话列底部。
 * 引用只为全局对话准备；在二级页已引用时，输入条上方出现「在全局讨论 · N」。
 */
export function ConversationHost({
  page,
  detailOpen,
  rail = detailOpen,
  ui,
}: {
  page: ConversationTarget | null;
  detailOpen: boolean;
  /** 是否用右侧对话列（二级页里的浏览面，如雷达列表，不用）。 */
  rail?: boolean;
  ui: ConversationUiState;
}) {
  const target = detailOpen && page && !ui.globalView ? page : GLOBAL;
  return <ScopedConversation key={target.scope} target={target} detailOpen={detailOpen} rail={rail} ui={ui} />;
}

function ScopedConversation({ target, detailOpen, rail, ui }: { target: ConversationTarget; detailOpen: boolean; rail: boolean; ui: ConversationUiState }) {
  const data = useConversation(target.scope);
  const references = useReferences();
  const [composerHeight, setComposerHeight] = useState(56);
  const global = target.scope === "global";
  const items = references?.items ?? [];
  const showRail = rail && !ui.historyOpen;

  const closeHistory = () => {
    ui.setHistoryOpen(false);
    ui.setGlobalView(false);
  };
  // clark openHistory：二级页里查看本页对话 = 展开对话列（窄屏）；首页开合历史层。
  const toggleHistory = () => {
    if (ui.historyOpen) return closeHistory();
    if (rail && !global) return ui.setRailMobileOpen(true);
    ui.setHistoryOpen(true);
  };

  return (
    <>
      {showRail ? (
        <TopicConversationRail data={data} label={target.label} mobileOpen={ui.railMobileOpen} onMobileOpen={ui.setRailMobileOpen} composerHeight={composerHeight} />
      ) : null}
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
        onToggleHistory={toggleHistory}
        references={items}
        onRemoveReference={(id) => references?.remove(id)}
        onClearReferences={() => references?.clear()}
        onRestoreReferences={(cards) => references?.add(cards)}
        pendingGlobalReferences={!global && items.length ? items.length : 0}
        onDiscussGlobal={() => {
          ui.setGlobalView(true);
          ui.setHistoryOpen(true);
        }}
        onHeightChange={setComposerHeight}
        prefill={ui.prefill}
        onPrefillUsed={ui.consumePrefill}
      />
    </>
  );
}
