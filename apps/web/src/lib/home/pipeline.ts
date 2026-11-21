"use client";

/**
 * Task 管线的对话（第 2 节：每人每件 Task 一条单独的对话）。B 的 POST /api/me/tasks/:taskId/pipeline 和对应的对话接口到之前，
 * 这里是一份只在这个标签页里的假对话：开头伙伴把标准摆出来，用选项问先怎么开始；选「拆成几步」就在这台电脑上开规划员。
 * 不借总线程（第 2 节：两条管线的历史不能混在一起）。B 的接口到了以后，usePipelineConversation 换成 useConversation(那条对话)。
 * 形状和 useConversation 的返回值一样，时间线和输入条照用。
 */
import { useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from "react";
import type { TAskAnswerInput, TAskAnswerRecord, TConversationCard } from "@warmap/contracts";
import type { ConversationData, Message } from "@/conversation/useConversation";

export type PipelineTask = { taskId: string; name: string; criteria: string[] };
/** 选了「拆成几步」：在这台电脑上开规划员（或登记成「拆卡 · 等开工」）。 */
export type PipelineHandlers = { split: () => void };

type Thread = { messages: Message[]; streaming: boolean };
const threads = new Map<string, Thread>();
const listeners = new Set<() => void>();
const EMPTY: Thread = { messages: [], streaming: false };
const emit = () => listeners.forEach((listener) => listener());
const subscribe = (listener: () => void) => { listeners.add(listener); return () => listeners.delete(listener); };
const put = (taskId: string, change: (thread: Thread) => Thread) => { threads.set(taskId, change(threads.get(taskId) ?? EMPTY)); emit(); };

export const SPLIT_LABEL = "拆成几步";
const TALK_LABEL = "先聊计划";

function opening(task: PipelineTask, begun: boolean): Message {
  const criteria = task.criteria.length ? `\n\n${task.criteria.map((line, index) => `${index + 1}. ${line}`).join("\n")}` : "";
  const card: TConversationCard = {
    kind: "questions", askId: `00000000-0000-4000-8000-${task.taskId.replace(/[^0-9a-f]/gi, "").padEnd(12, "0").slice(0, 12)}`,
    questions: [{ id: "q1", question: "先怎么开始？", options: [{ label: SPLIT_LABEL, recommended: true }, { label: TALK_LABEL }] }],
  };
  return { sequence: 1, role: "assistant", content: `「${task.name}」按这几条验收：${criteria}`, createdAt: new Date(Date.now() - 60_000).toISOString(), ...(begun ? {} : { cards: [card] }) };
}

/** 假伙伴的回话：选了拆就开规划员；先聊就问从哪条说起；别的一律接住。 */
function replyTo(text: string, answers: TAskAnswerRecord | undefined): string {
  const picked = answers?.items[0]?.answer;
  if (picked === SPLIT_LABEL) return "好，规划员开始拆，拆好在这里给你过目。";
  if (picked === TALK_LABEL) return "好。从哪一条说起？";
  return text.includes("子会话") ? "好，这就单独开一个。" : "收到。";
}

const noop = () => undefined;

/** begun：这件 Task 已经拆过或开过（刷新以后不再问先怎么开始）。 */
export function usePipelineConversation(task: PipelineTask | null, handlers: PipelineHandlers, begun = false): ConversationData {
  const taskId = task?.taskId ?? "";
  const thread = useSyncExternalStore(subscribe, () => threads.get(taskId) ?? EMPTY, () => EMPTY);
  const handlersRef = useRef(handlers);
  useEffect(() => { handlersRef.current = handlers; });
  // 开头那句：对话开了就摆出来；首页发来的那句可能先到（子组件的 effect 先跑），发的时候没有开头也先补上（send 跟着 task 换，拿的是这一次的）。
  useEffect(() => { if (task && !threads.has(task.taskId)) put(task.taskId, () => ({ messages: [opening(task, begun)], streaming: false })); }, [task, begun]);

  const send = useCallback(async (message: string, _references: unknown[], options: { answers?: { input: TAskAnswerInput; record: TAskAnswerRecord } } = {}) => {
    if (!taskId) return false;
    const now = new Date().toISOString();
    const seed = !threads.has(taskId) && task ? [opening(task, begun)] : [];
    put(taskId, (current) => ({ streaming: true, messages: [...seed, ...current.messages, {
      sequence: seed.length + current.messages.length + 1, role: "user", content: message, createdAt: now, ...(options.answers ? { answers: options.answers.record } : {}),
    }] }));
    await new Promise((resolve) => window.setTimeout(resolve, 700));
    put(taskId, (current) => ({ streaming: false, messages: [...current.messages, {
      sequence: current.messages.length + 1, role: "assistant", content: replyTo(message, options.answers?.record), createdAt: new Date().toISOString(),
    }] }));
    // 回完这一句再开规划员：「拆卡中」那一行排在伙伴这句话后面。
    if (options.answers?.record.items[0]?.answer === SPLIT_LABEL) handlersRef.current.split();
    return true;
  }, [taskId, task, begun]);

  return useMemo(() => ({
    scope: `pipeline:${taskId}`, viewingMaterialEditable: false, messages: thread.messages,
    status: thread.streaming ? "streaming" : "complete", streaming: thread.streaming, thinking: thread.streaming, partial: "", stage: "thinking", startedAt: thread.streaming ? Date.now() : 0,
    route: null, progress: { label: null, checked: 0 }, steps: [], readScope: null, model: null, rescope: async () => false, thought: null, error: null, recovery: null, lastReply: null,
    // 看板读到以前（taskId 为空）算还在读：首页发来的那句等对话开了再发，不会先被吃掉。
    historyStatus: taskId ? "ready" : "loading", historyError: null, historyWaiting: null, retryHistory: noop, attachments: [], uploading: false, attachmentError: null,
    uploadFiles: async () => undefined, removeAttachment: noop, send, stop: noop,
  }) as unknown as ConversationData, [taskId, thread, send]);
}
