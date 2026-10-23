"use client";

/**
 * 首页计划点的加、改名、删：先在本地画上，再发请求。
 * - 每个改动记成一条待定操作，按先后叠在当前的 plan.marks 上重放，中途轮询回来的新 plan 冲不掉它。
 * - 失败的那条撤掉并给一句错，别的待定操作不动。
 * - 存好的那条，等 plan.marks 里看得到它（或者后面又有一条存好、也已落定的操作改了同一个点）再撤，存好后发 HOME_PLAN_CHANGED 让 useHomePlan 重取。
 * - 新加的点在 POST 回来之前 id 是 pending-…，这时不能改、不能删（isPending）；回来后换成真 id。
 */
import { useEffect, useRef, useState } from "react";
import type { THomePlanMark } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";
import { HOME_PLAN_CHANGED } from "./useHomePlan";

const PENDING = "pending-";

type Change = { kind: "add"; mark: THomePlanMark } | { kind: "rename"; id: string; label: string } | { kind: "delete"; id: string };
type Op = Change & { key: number; saved: boolean };
type Sent = { data?: THomePlanMark; error?: unknown; response: Response };

const target = (op: Change) => (op.kind === "add" ? op.mark.id : op.id);
const replay = (marks: THomePlanMark[], op: Change) =>
  op.kind === "add" ? [...marks, op.mark]
    : op.kind === "rename" ? marks.map((mark) => (mark.id === op.id ? { ...mark, label: op.label } : mark))
      : marks.filter((mark) => mark.id !== op.id);
/** 这条改动已经落进 marks 里了。 */
const landed = (op: Change, marks: THomePlanMark[]) => {
  const found = marks.find((mark) => mark.id === target(op));
  return op.kind === "delete" ? !found : op.kind === "add" ? Boolean(found) : found?.label === op.label;
};
/** 可以撤掉的操作：存好了，并且自己已落定，或后面有一条存好且已落定的操作改了同一个点。 */
const settled = (ops: Op[], marks: THomePlanMark[]) => {
  const done = (op: Op) => op.saved && landed(op, marks);
  return new Set(ops.filter((op, index) => op.saved && (done(op) || ops.slice(index + 1).some((later) => target(later) === target(op) && done(later)))).map((op) => op.key));
};

export const isPending = (id: string) => id.startsWith(PENDING);

export function usePlanMarks(base: THomePlanMark[]) {
  const [ops, setOps] = useState<Op[]>([]);
  const [error, setError] = useState<string | null>(null);
  const counter = useRef(0);

  const gone = settled(ops, base);
  const marks = ops.filter((op) => !gone.has(op.key)).reduce(replay, base);
  // 落定的操作从记录里撤掉，免得以后这个点再变时被旧操作盖回去。
  useEffect(() => {
    setOps((current) => {
      const drop = settled(current, base);
      return drop.size ? current.filter((op) => !drop.has(op.key)) : current;
    });
  }, [base, ops]);

  const send = async (change: Change, request: () => Promise<Sent>) => {
    const key = ++counter.current;
    setOps((current) => [...current, { ...change, key, saved: false }]);
    setError(null);
    const fail = (message?: string) => {
      setOps((current) => current.filter((op) => op.key !== key));
      setError(message ?? "没存上，请重试");
    };
    try {
      const { data, error: failure, response } = await request();
      if (!response.ok) return fail((failure as { message?: string } | undefined)?.message);
      setOps((current) => current.map((op) => (op.key !== key ? op : op.kind === "add" && data ? { ...op, mark: data, saved: true } : { ...op, saved: true })));
      window.dispatchEvent(new Event(HOME_PLAN_CHANGED));
    } catch {
      fail();
    }
  };

  return {
    marks,
    error,
    clearError: () => setError(null),
    add: (missionId: string, date: string, label: string) => {
      void send({ kind: "add", mark: { id: `${PENDING}${counter.current + 1}`, missionId, date, label } },
        () => browserApi.POST("/api/me/plan-marks", { body: { missionId, date, label } }));
    },
    rename: (id: string, label: string) => {
      if (isPending(id)) return;
      void send({ kind: "rename", id, label }, () => browserApi.PATCH("/api/me/plan-marks/{id}", { params: { path: { id } }, body: { label } }));
    },
    remove: (id: string) => {
      if (isPending(id)) return;
      void send({ kind: "delete", id }, () => browserApi.DELETE("/api/me/plan-marks/{id}", { params: { path: { id } } }));
    },
  };
}
