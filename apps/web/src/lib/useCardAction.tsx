"use client";

import { useCallback, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { browserApi, type Card, type CardAction } from "./api/client";
import { interpretActionResponse } from "./actionResponse";

export type ActionState =
  | { status: "idle" }
  | { status: "pending" }
  | { status: "done" }
  | { status: "conflict"; message: string }
  | { status: "error"; message: string };

type Attempt = { action: CardAction; input: unknown };

/**
 * 统一的 Action client：只提交 opaque actionId 与合法 input（对象 version 已固化在签名 actionId 内）。
 * 成功后把返回的新 Card 交给页面；409 用 latestCard 刷新并要求重新核对；其他失败可原样重试。
 */
export function useCardAction(onCard: (card: Card) => void) {
  const [state, setState] = useState<ActionState>({ status: "idle" });
  const lastAttempt = useRef<Attempt | null>(null);
  const router = useRouter();

  const run = useCallback(
    async (action: CardAction, input: unknown = {}) => {
      lastAttempt.current = { action, input };
      setState({ status: "pending" });
      const { data, error, response } = await browserApi.POST("/api/actions/execute", {
        body: { actionId: action.actionId, input },
      });
      const outcome = interpretActionResponse(response.status, data as { cards?: Card[] } | undefined, error);
      if (outcome.kind === "unauthorized") {
        router.push("/access");
        return;
      }
      if (outcome.kind === "ok") {
        onCard(outcome.card);
        setState({ status: "done" });
        return;
      }
      if (outcome.kind === "conflict") {
        if (outcome.latestCard) onCard(outcome.latestCard);
        setState({ status: "conflict", message: outcome.message });
        return;
      }
      setState({ status: "error", message: outcome.message });
    },
    [onCard, router],
  );

  const retry = useCallback(() => {
    const attempt = lastAttempt.current;
    if (attempt) void run(attempt.action, attempt.input);
  }, [run]);

  const reset = useCallback(() => setState({ status: "idle" }), []);

  return { state, run, retry, reset, pending: state.status === "pending" };
}

/** Action 提交状态的最小展示：pending 由按钮文案表达，其余复用材料页的低干扰样式。 */
export function ActionFeedback({
  state,
  onRetry,
  label,
}: {
  state: ActionState;
  onRetry: () => void;
  label?: string;
}) {
  if (state.status === "conflict") {
    return (
      <p className="action-conflict" role="alert">
        {state.message}
        <button type="button" onClick={onRetry}>
          重新核对后重试
        </button>
      </p>
    );
  }
  if (state.status === "error") {
    return (
      <p className="action-error" role="alert">
        {state.message}
        <button type="button" onClick={onRetry}>
          重试{label ? ` ${label}` : ""}
        </button>
      </p>
    );
  }
  return null;
}
