/**
 * 对话历史打包策略：全量带入，压力阈值触发时压最老一半。
 *
 * ## 为什么不用模型压缩
 *
 * 对话历史是这一层唯一不可重取的东西——证据能重查、报告能重建、判断板能重算，
 * 但对话历史说过的就说过了，没有「再调一次得到原值」这条路。让模型压它等于给
 * 每一轮加一次可能失败、可能篡改原意的调用。
 *
 * 真要上模型摘要，得等有了「压完之后引用旧轮准确率」的实测数据再说。现阶段用
 * 纯字符串折叠（取首句 + 长度标记），压出来的东西答得出「第 N 轮谁说了什么主张」，
 * 已经足够支撑对谈的上下文引用。
 */

import type { AdvisorMessage } from "@/lib/data/types";

/**
 * 压力阈值：当 `prefixChars + historyChars > windowChars * PRESSURE_RATIO` 时触发压缩。
 */
export const PRESSURE_RATIO = 0.7;

/**
 * 请求体里的一条消息。**在这一层自己声明**：形状是上游 OpenAI 那套的 `role`/`content`，
 * 而路由那个同形的 interface 没有 export —— 为了一个类型去改路由的导出面不值得。
 */
export type RequestTurn = { role: "user" | "assistant"; content: string };

/**
 * 请求体里那串消息 → `packHistory` 收的形状。
 *
 * **历史从请求体里取，不从库里取。** 分诊那一栏是不落库的（`chat-pane.tsx` 的 `ephemeral`：
 * 它只把整串消息发过来），照库里读会把那一栏的历史读成空 —— 屏幕上他上一句还在，模型却
 * 当他第一次开口。落库的那一栏发来的也是同一串，所以一处取法两栏都对。
 *
 * 最后一句是他刚说的这一句，由 `ask` 单独带，历史里不重复一遍。`id` 与 `at` 是补的：
 * 打包只读 `role` 与 `text`，这两栏是 `AdvisorMessage` 的形状要求。
 */
export const asHistory = (msgs: readonly RequestTurn[]): AdvisorMessage[] =>
  msgs.slice(0, -1).map((m, i) => ({
    id: `req-${i}`,
    role: m.role === "assistant" ? ("agent" as const) : ("user" as const),
    text: m.content,
    at: "",
  }));

/**
 * 打包结果。
 * - `text`: 历史文本（原文或压缩后的混合体）
 * - `compressedTurns`: 被压缩的轮次数
 * - `keptTurns`: 保留原文的轮次数
 */
export type Packed = {
  text: string;
  compressedTurns: number;
  keptTurns: number;
};

/**
 * 对话历史打包。默认全量原文带入；逼近窗口阈值时压最老一半，保留最近一半原文。
 *
 * @param msgs 对话消息列表
 * @param o.windowChars 上下文窗口总字符数
 * @param o.prefixChars 静态前缀（系统提示词 + 报告 + 判断板等）的字符数
 * @returns 打包后的历史文本及统计信息
 */
export function packHistory(
  msgs: readonly AdvisorMessage[],
  o: { windowChars: number; prefixChars: number }
): Packed {
  // 计算历史总字符数
  const historyChars = msgs.reduce((sum, m) => sum + m.text.length, 0);

  // 未达阈值：全量原文
  if (o.prefixChars + historyChars <= o.windowChars * PRESSURE_RATIO) {
    return {
      text: formatFullHistory(msgs),
      compressedTurns: 0,
      keptTurns: countTurns(msgs),
    };
  }

  // 达到阈值：压最老一半，留最近一半
  return compressOldHalf(msgs);
}

/**
 * 格式化完整历史（不压缩）。添加轮次标签，消息正文原文照抄。
 */
function formatFullHistory(
  msgs: readonly AdvisorMessage[],
  startTurnIndex: number = 0
): string {
  const lines: string[] = [];
  let turnIndex = startTurnIndex;

  for (let i = 0; i < msgs.length; i++) {
    const msg = msgs[i];

    if (msg.role === "user") {
      turnIndex++;
      lines.push(`第 ${turnIndex} 轮我问：${msg.text}`);
    } else {
      lines.push(`第 ${turnIndex} 轮我答：${msg.text}`);
    }
  }

  return lines.join("\n\n");
}

/**
 * 压缩最老一半轮次，保留最近一半原文。
 */
function compressOldHalf(msgs: readonly AdvisorMessage[]): Packed {
  const totalTurns = countTurns(msgs);
  const compressTurns = Math.floor(totalTurns / 2);
  const keepTurns = totalTurns - compressTurns;

  // 找到压缩边界（以轮为单位）
  let turnCount = 0;
  let splitIndex = 0;
  for (let i = 0; i < msgs.length; i++) {
    if (msgs[i].role === "user") {
      turnCount++;
      if (turnCount > compressTurns) {
        splitIndex = i;
        break;
      }
    }
  }

  const oldMsgs = msgs.slice(0, splitIndex);
  const recentMsgs = msgs.slice(splitIndex);

  const compressedText = formatCompressed(oldMsgs);
  const recentText = formatFullHistory(recentMsgs, compressTurns);

  const sections = [compressedText, recentText].filter(Boolean);

  return {
    text: sections.join("\n\n---\n\n"),
    compressedTurns: compressTurns,
    keptTurns: keepTurns,
  };
}

/**
 * 压缩格式：一行一轮（一轮 = user + agent），保留轮次编号 + 首句（主张）。
 *
 * 格式示例：`第 1 轮 | 我问：……（200 字） | 我答：……（208 字）`
 */
function formatCompressed(msgs: readonly AdvisorMessage[]): string {
  const lines: string[] = [];
  let turnIndex = 0;
  let i = 0;

  while (i < msgs.length) {
    const userMsg = msgs[i];
    const agentMsg = msgs[i + 1];

    if (userMsg && userMsg.role === "user") {
      turnIndex++;
      const userSummary = `我问：${extractFirstSentence(userMsg.text)}（${userMsg.text.length} 字）`;

      let agentSummary = "";
      if (agentMsg && agentMsg.role === "agent") {
        agentSummary = ` | 我答：${extractFirstSentence(agentMsg.text)}（${agentMsg.text.length} 字）`;
        i += 2; // Skip both user and agent
      } else {
        i += 1; // Only user, no agent (edge case)
      }

      lines.push(`第 ${turnIndex} 轮 | ${userSummary}${agentSummary}`);
    } else {
      i += 1; // Skip unexpected message order
    }
  }

  return lines.join("\n");
}

/**
 * 提取首句并限制长度。
 */
function extractFirstSentence(text: string): string {
  // 匹配第一句：以标点或换行结束
  const match = text.match(/^[^。？！\n]+[。？！]?/);
  const sentence = match ? match[0] : text;

  // 限制最大长度
  if (sentence.length > 50) {
    return sentence.slice(0, 50) + "…";
  }
  return sentence;
}

/**
 * 统计完整轮次数（一个 user 消息 + 一个 agent 消息 = 一轮）。
 */
function countTurns(msgs: readonly AdvisorMessage[]): number {
  return msgs.filter((m) => m.role === "user").length;
}
