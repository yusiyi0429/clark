"use client";

import { useMode } from "@/lib/use-mode";
import { AGENDA } from "@/lib/demo/agenda";
import { progressLabel } from "@/lib/stage/reducer";

import {
  AgendaCard,
  DecisionCard,
  EvidenceCard,
  ExplorationCardView,
  ItemCard,
  Missing,
  SummaryCard,
} from "./stage-cards";
import { StageDoc } from "./stage-doc";
import { StageMap } from "./stage-map";
import { StageProvider, useStage } from "./stage-provider";
import { VoiceBar } from "./voice-bar";

/**
 * 口述模式那块屏。
 *
 * 整屏、一次一件事、字大到最后一排看得清。它盖在工作台上面（`.stage` 是 fixed），工作台
 * 本身只是被藏起来 —— 切回去是立刻的，他刚才那段对话和右栏那几个标签都还在原地。
 *
 * 手动模式下这个组件返回 `null`：整套舞台连挂载都不挂载，所以口述模式那条 `EventSource`、
 * 那次开场请求，在他一个人用工作台的时候完全不存在。这是「不破坏手动模式任何现有功能」
 * 在结构上的保证，不是靠小心。
 */
export function OralStage() {
  const mode = useMode();
  if (mode !== "oral") return null;
  return (
    <StageProvider>
      <Stage />
    </StageProvider>
  );
}

function Stage() {
  const { state } = useStage();
  const progress = progressLabel(state);

  return (
    <>
      <div className="stage">
        {/*
         * 顶上一行。只有进度，一行小字，不居中 —— 居中会让它看起来像标题，而它是脚注。
         * 「今日呈报 2/3」是他抬头一瞥就要拿到的唯一一个数字：还剩几件。
         *
         * 开场那一帧这里是空的（见 `progressLabel`）。留着这一格的高度不让它撑开又塌回去：
         * 投影上一行字凭空出现会把所有人的眼睛从卡片上拽走一次。
         */}
        <div className="flex min-h-7 items-baseline justify-between px-8 pt-6 pb-2">
          <span className="meta-stage text-ink-faint">{progress}</span>
          {/* 翻回历史里的时候要说出来，否则他会以为屏幕自己往回跳了。 */}
          {state.cursor < state.history.length - 1 && (
            <span className="meta-stage text-ink-faint">
              回看第 {state.cursor + 1} / {state.history.length} 屏 · → 回到最新
            </span>
          )}
        </div>

        {/*
         * 主体。一次只画一个。
         *
         * `overflow-y-auto` 是给「打开全文」留的 —— 一份纲领比一屏长，而滚动是他会做的
         * 动作。其余每一张卡都设计成一屏放得下。
         */}
        <main className="scroll-slim flex min-h-0 items-center overflow-y-auto px-16 py-8">
          <div className="w-full py-4">
            <Body />
          </div>
        </main>

        <VoiceBar />
      </div>

      {/*
       * 这里原来挂着从左边缘唤出来的那条侧栏（工作台的 `Rail` 本体）—— 会上他被追问一句
       * 「那条判断的原文呢」，划出来点进去。三栏工作台整块删掉时那个组件也一起走了，而
       * 口述模式这一版不交付，所以这里先空着，`.stage-edge` / `.stage-rail` 两条 CSS 留在
       * globals 里。口述模式重启时，唤出来的应该是顶上那条五环节导航的侧栏形态，不是再造
       * 一个左栏。
       */}
    </>
  );
}

/** 帧 → 组件。一个 switch，没有第二处决定「屏幕上该是什么」。 */
function Body() {
  const { state, frame } = useStage();

  if (!frame) return <AgendaCard state={state} />;

  switch (frame.kind) {
    case "agenda":
      return <AgendaCard state={state} />;

    case "card": {
      const items = (state.agenda ?? AGENDA).items;
      const at = items.findIndex((i) => i.id === frame.itemId);
      return <ItemCard itemId={frame.itemId} at={at + 1} total={items.length} />;
    }

    case "evidence":
      return <EvidenceCard evidenceId={frame.evidenceId} />;

    case "doc":
      return <StageDoc docId={frame.docId} anchor={frame.anchor} />;

    case "map":
      return <StageMap view={frame.view} />;

    case "exploration": {
      const card = state.explorations.find((c) => c.id === frame.id);
      return card ? <ExplorationCardView card={card} /> : <Missing what={`探索卡 ${frame.id}`} />;
    }

    case "decision": {
      const draft = state.decisions.find((d) => d.id === frame.id);
      return draft ? <DecisionCard draft={draft} /> : <Missing what={`决策草案 ${frame.id}`} />;
    }

    case "summary":
      return <SummaryCard state={state} />;
  }
}
