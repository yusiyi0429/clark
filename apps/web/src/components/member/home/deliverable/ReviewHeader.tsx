"use client";

/**
 * 交付物面板最上面的结论：评审中是几步走到哪、已用和预计；没评完给「重新评审」；评完是圆环（几条达到）、一句结论、
 * 一两句概况、按哪套标准评 · 读了几份 · 用时，以及和上一版比多达到了什么。
 */
import { useEffect, useState } from "react";
import type { TDeliverableVersion, TReviewBasis } from "@warmap/contracts";
import { about, clock, duration, reviewSteps } from "./deliverableFormat";
import d from "@/styles/task-deliverable.module.css";

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
            <li key={label} data-state={index + 1 < current ? "done" : index + 1 === current ? "now" : undefined}><i aria-hidden="true" />{label}</li>
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
        {canEdit ? <button type="button" className={d.plain} onClick={onRetry}>重新评审</button> : null}
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
