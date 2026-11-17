"use client";

/**
 * 页头正中伙伴的「在场」（设计 4.2、5.2）：只在新首页的伙伴主线和项目对话里。
 * 主线：形象钉在页头正中，任何时候不挪；状态胶囊挂在它正下方、居中、只变长短，浮在对话上，不撑高页头。空闲时只有形象。
 * 项目对话是纯干活的，不放形象（本人 11/17 晚）：胶囊照旧挂在页头正中下面、和主线同一个位置，只是上面没有形象。
 * - 开会录音：形象在听，胶囊写「● 12:34 在录」，点了去会议页；听写开着：形象在听，没有胶囊。
 * - 回答中：胶囊写在做什么（没有就不写）· 用时 · 停止；出字以后没有具体在做的写「在回答 · 用时」。点胶囊在下面落一小块步骤和思考摘要，再点收回。
 */
import { useEffect, useRef, useState } from "react";
import { BuddyMark, type BuddyState } from "@/components/buddy/BuddyMark";
import type { Buddy } from "@/components/buddy/useBuddy";
import { useListeningLevel } from "@/components/coagent/presence";
import { StepList } from "@/components/steps/StepList";
import { conversationDoing } from "@/components/work/WorkTimeline";
import { useDictationSignal } from "@/conversation/dictationSignal";
import { useTurnRevealed } from "@/conversation/ReplyBubbles";
import { STAGE_COPY, ThinkingStream, liveClock } from "@/conversation/Transcript";
import type { ConversationData } from "@/conversation/useConversation";
import { useHomeMeetingState } from "./meetingState";
import p from "@/styles/presence.module.css";

/** 做完了（笑一下）持续多久，然后回空闲。 */
const DONE_MS = 1200;

/**
 * 页头那颗的状态：开会录音或听写 → 在听；回答中还没内容出来 → 在想，出来以后 → 正在输入；
 * 这一轮正常结束后 1.2 秒 → 做完了（停下、出错不算；1.2 秒内又开一轮就让给它）；其余空闲。
 * revealed：这一轮有没有内容出来（第一个气泡出没出）。
 */
export function usePresenceState(data: ConversationData, revealed: boolean): BuddyState {
  const meeting = useHomeMeetingState();
  const dictation = useDictationSignal();
  const last = useRef(data.status);
  const [done, setDone] = useState(false);
  // 结束那一下就换成「做完了」，不先闪一帧空闲。
  const justDone = last.current === "streaming" && data.status === "complete";
  useEffect(() => {
    last.current = data.status;
    setDone(justDone);
    if (!justDone) return;
    const timer = setTimeout(() => setDone(false), DONE_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在状态换的那一刻判断
  }, [data.status]);
  if (meeting.listening || dictation) return "listening";
  if (data.streaming) return revealed ? "typing" : "thinking";
  return justDone || done ? "done" : "idle";
}

/** 形象单独一块：在听时响度一秒十几次，只让它跟着重画。 */
function HeadMark({ buddy, state, meeting }: { buddy: Buddy | null; state: BuddyState; meeting: boolean }) {
  const dictation = useDictationSignal();
  const meetingLevel = useListeningLevel();
  return <BuddyMark buddy={buddy} place="head" state={state} level={meeting ? meetingLevel : dictation?.level ?? 0} />;
}

/** 回答中胶囊上的那句：拿到具体在做什么以前只写用时；出字以后只剩阶段词时写「在回答」。 */
function pillText(data: ConversationData, revealed: boolean): string | null {
  const doing = conversationDoing(data);
  const vague = doing === STAGE_COPY[data.stage] && data.stage !== "connecting" && data.stage !== "offline";
  return revealed && (!doing || vague) ? "在回答" : doing;
}

export function Presence({ buddy, data, go }: { buddy: Buddy | null; data: ConversationData; go: (href: string) => void }) {
  const meeting = useHomeMeetingState();
  // 这一轮第一个气泡出没出：对话那边（ReplyBubbles）出了第一块时记下。
  const revealed = useTurnRevealed(data.scope, data.startedAt);
  const state = usePresenceState(data, revealed);
  const [now, setNow] = useState(() => Date.now());
  // 点开的那一小块记在这一轮上（startedAt），下一轮自己收起。
  const [openFor, setOpenFor] = useState<number | null>(null);
  useEffect(() => {
    if (!data.streaming) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [data.streaming]);
  const recording = meeting.listening && meeting.clock;
  let pill = null;
  if (recording) {
    pill = (
      <div className={p.pill} data-testid="presence-pill" data-rec="">
        <button type="button" className={p.hit} onClick={() => { if (meeting.href) go(meeting.href); }}>● {meeting.clock} 在录</button>
      </div>
    );
  } else if (data.streaming) {
    const text = pillText(data, revealed);
    const thought = data.thought?.text ?? "";
    const detail = data.steps.length > 0 || !!thought;
    const open = detail && openFor === data.startedAt;
    // 太长时只省略在做什么，用时留着。
    const words = <>{text ? <span className={p.what}>{text}</span> : null}{text ? " · " : ""}<span className={p.time}>{liveClock(now - data.startedAt)}</span></>;
    pill = (
      <>
        <div className={p.pill} data-testid="presence-pill">
          {detail ? <button type="button" className={p.hit} aria-expanded={open} onClick={() => setOpenFor(open ? null : data.startedAt)}>{words}</button>
            : <span className={p.hit}>{words}</span>}
          <button type="button" className={p.stop} onClick={data.stop} aria-label="停止本次回答">停止</button>
        </div>
        {open ? (
          <div className={p.detail} data-testid="presence-detail">
            <StepList steps={data.steps} />
            {thought ? <ThinkingStream text={thought} /> : null}
          </div>
        ) : null}
      </>
    );
  }
  const figure = data.scope === "global";
  return (
    <div className={p.presence} data-presence="">
      {figure ? <HeadMark buddy={buddy} state={state} meeting={meeting.listening} /> : null}
      {pill ? <div className={p.hang}>{pill}</div> : null}
    </div>
  );
}
