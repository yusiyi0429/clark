"use client";

/**
 * 交付物面板最上面的结论：评审中是几步走到哪（勾、转圈、空心圈）、已用和预计；没评完给「重新评审」；评完是圆环（墨色，几条达到）、一句结论、
 * 一两句概况、按哪套标准评 · 读了几份 · 用时，以及和上一版比多达到了什么。
 */
import { useEffect, useState } from "react";
import { Check, Circle, LoaderCircle } from "lucide-react";
import type { TDeliverableVersion, TReviewBasis } from "@warmap/contracts";
import { HeroButton } from "@/components/HeroButton";
import { about, clock, duration, reviewSteps } from "./deliverableFormat";
import d from "@/styles/task-deliverable.module.css";

const ICON = { size: 16, strokeWidth: 1.8 } as const;
/** 几步的状态图标（和新首页的树、事件行同一套）：做完是勾、正在做是转圈、没到是空心圈。 */
const STEP_ICON = { done: Check, now: LoaderCircle, todo: Circle } as const;

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  return now;
}

function Ring({ met, total, ready }: { met: number; total: number; ready: boolean }) {
  const r = 22, c = 2 * Math.PI * r;
  return (
    <svg className={d.ring} data-ready={ready || undefined} viewBox="0 0 52 52" aria-hidden="true">
      <circle cx="26" cy="26" r={r} className={d.ringTrack} />
      {met > 0 ? <circle cx="26" cy="26" r={r} className={d.ringValue} strokeDasharray={`${(met / total) * c} ${c}`} transform="rotate(-90 26 26)" /> : null}
      <text x="26" y="26" className={d.ringText} dominantBaseline="central" textAnchor="middle">{met}/{total}</text>
    </svg>
  );
}

function Step({ state, label }: { state: keyof typeof STEP_ICON; label: string }) {
  const Icon = STEP_ICON[state];
  return <li data-state={state}><Icon {...ICON} aria-hidden="true" />{label}</li>;
}

export function ReviewHeader({ version, basis, criteriaCount, canEdit, onRetry }: {
  version: TDeliverableVersion;
  basis: TReviewBasis;
  criteriaCount: number;
  canEdit: boolean;
  onRetry: () => void;
}) {
  const { review } = version;
  const busy = review.status === "queued" || review.status === "running";
  const now = useNow(busy);

  if (busy) {
    const steps = reviewSteps(review, version.items.length, criteriaCount);
    const current = review.phase ? review.phase.step : 0;
    const started = Date.parse(review.startedAt ?? version.createdAt);
    return (
      <div className={d.reviewing} role="status" aria-live="polite">
        <ol className={d.steps}>
          {steps.map((label, index) => (
            <Step key={label} state={index + 1 < current ? "done" : index + 1 === current ? "now" : "todo"} label={label} />
          ))}
        </ol>
        <p className={d.elapsed}>已用 {clock((now - started) / 1000)} / {about(review.expectedSeconds)}</p>
      </div>
    );
  }
  if (review.status === "failed") {
    return (
      <div className={d.failed} role="alert">
        <span>{review.error ?? "评审没做完"}</span>
        {canEdit ? <HeroButton variant="tertiary" size="sm" onPress={onRetry}>重新评审</HeroButton> : null}
      </div>
    );
  }
  if (!review.total) return null;
  const read = version.items.filter((item) => item.read === "read").length;
  const spent = review.startedAt && review.finishedAt ? (Date.parse(review.finishedAt) - Date.parse(review.startedAt)) / 1000 : null;
  const meta = [basis === "definition" ? "按完成定义评" : "按本体验收标准评", read ? `读了 ${read} 份` : null, spent !== null ? `用时 ${duration(spent)}` : null].filter(Boolean).join(" · ");
  return (
    <div className={d.report}>
      <Ring met={review.met} total={review.total} ready={review.ready} />
      <div className={d.reportText}>
        {review.headline ? <p className={d.headline}>{review.headline}</p> : null}
        {review.summary ? <p className={d.summary}>{review.summary}</p> : null}
        {review.gain ? <p className={d.gain}>比上一版：{review.gain}</p> : null}
        <p className={d.meta}>{meta}</p>
      </div>
    </div>
  );
}
