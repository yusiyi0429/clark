"use client";

import { ConversationStatusSlot, ConversationThinking, ConversationTurns } from "./Transcript";
import { AnswerOptions } from "./AnswerOptionRow";
import { parseAnswerOptions } from "./answerOptions";
import type { ConversationData } from "./useConversation";

/**
 * 对话时间线（全局对话层与二级页右列共用）。
 *
 * 进行中这一轮的呈现顺序（所有档位都按这一条）：
 *   提问 → 开场说明 → 思考与进度 → 正文（就在思考原来的位置往下写）。
 * 思考与进度（状态区）紧贴在正在写的那条下面；正文第一个字出现时思考收起，正文接着从同一处往下长，视线不用跳。
 */
export function ConversationTimeline({ data }: { data: ConversationData }) {
  // 回答末尾的选项只挂在最新一条回答下；发出下一条（最后一条变成提问）或回答进行中都不显示。
  const lastIndex = data.messages.length - 1;
  const last = data.messages[lastIndex];
  const options = !data.streaming && last?.role === "assistant" ? parseAnswerOptions(last.content).options : [];
  // 状态区：回答进行中一直占着位置。
  const status = data.streaming ? (
    <ConversationStatusSlot>
      {data.thinking ? <ConversationThinking stage={data.stage} startedAt={data.startedAt} onStop={data.stop} route={data.route} progress={data.progress} steps={data.steps} thought={data.thought} /> : null}
    </ConversationStatusSlot>
  ) : null;
  return (
    <ConversationTurns messages={data.messages} partial={data.streaming ? data.partial : ""} status={status}
      thought={data.thought?.seconds != null ? { text: data.thought.text, seconds: data.thought.seconds } : null}
      steps={!data.thinking || data.stage === "answering" ? data.steps : null}
      footer={(index) => (index === lastIndex && options.length ? <AnswerOptions scope={data.scope} options={options} /> : null)} />
  );
}
