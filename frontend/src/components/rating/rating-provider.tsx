"use client";

import { Star } from "lucide-react";
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { api } from "@/lib/data/client";
import { cn } from "@/lib/utils";

/**
 * 评分浮层 (§8.2).
 *
 * Two numbers are the only evidence we have for "is the CEO willing to keep
 * using this", so the ask has to exist. It also cannot become a nuisance:
 * non-blocking, skippable, and once skipped for an object it never asks about
 * that object again this session.
 *
 * "This session" lives in a ref, not in storage — H7 rules out localStorage for
 * business data, and this is UI state anyway. A reload starting fresh is the
 * same behaviour as the seed resetting, so nothing is inconsistent.
 */

type RatingContextValue = { requestRating: (targetId: string) => void };

const RatingContext = createContext<RatingContextValue | null>(null);

export function useRating() {
  const ctx = useContext(RatingContext);
  if (!ctx) throw new Error("useRating 必须在 RatingProvider 之内使用。");
  return ctx;
}

export function RatingProvider({ children }: { children: ReactNode }) {
  const settled = useRef<Set<string>>(new Set());
  const [target, setTarget] = useState<string | null>(null);

  const requestRating = useCallback((targetId: string) => {
    if (settled.current.has(targetId)) return;
    setTarget((current) => current ?? targetId);
  }, []);

  const close = useCallback((targetId: string) => {
    settled.current.add(targetId);
    setTarget(null);
  }, []);

  const value = useMemo(() => ({ requestRating }), [requestRating]);

  return (
    <RatingContext.Provider value={value}>
      {children}
      {target && <RatingCard key={target} targetId={target} onClose={close} />}
    </RatingContext.Provider>
  );
}

function RatingCard({
  targetId,
  onClose,
}: {
  targetId: string;
  onClose: (targetId: string) => void;
}) {
  const [quality, setQuality] = useState(0);
  const [experience, setExperience] = useState(0);
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);

  // A gap this wide means one of the two is carrying the other. Worth one line.
  const gap = quality > 0 && experience > 0 && Math.abs(quality - experience) >= 2;
  const canSubmit = quality > 0 && experience > 0 && !pending;

  const submit = async () => {
    setPending(true);
    try {
      await api.submitRating(targetId, quality, experience, note || undefined);
      onClose(targetId);
    } catch {
      setPending(false);
    }
  };

  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-0 z-40 flex justify-center px-5 pb-5">
      <section
        aria-label="评分"
        className="pointer-events-auto w-full max-w-md rounded-xl border border-hairline bg-surface px-5 py-4 shadow-e3"
      >
        <p className="text-[0.9375rem] font-medium text-ink">这次的结果怎么样？</p>

        <div className="mt-3 space-y-2">
          <StarRow label="结果质量" value={quality} onChange={setQuality} />
          <StarRow label="使用体验" value={experience} onChange={setExperience} />
        </div>

        {gap && (
          <div className="mt-3">
            <label
              htmlFor="rating-note"
              className="meta block text-ink-muted"
            >
              最大的问题是什么？
            </label>
            <input
              id="rating-note"
              value={note}
              onChange={(e) => setNote(e.target.value)}
              className="mt-1.5 w-full rounded-md border border-rule bg-paper px-2.5 py-1.5 text-sm text-ink outline-none focus-visible:border-ink"
            />
          </div>
        )}

        <div className="mt-4 flex items-center gap-4">
          <button
            type="button"
            disabled={!canSubmit}
            onClick={() => void submit()}
            className="rounded-md bg-solid px-3.5 py-1.5 text-sm font-medium text-solid-fg transition-opacity disabled:opacity-35"
          >
            {pending ? "正在提交…" : "提交"}
          </button>
          <button
            type="button"
            onClick={() => onClose(targetId)}
            className="meta rounded-[3px] text-ink-faint underline-offset-4 transition-colors hover:text-ink-muted hover:underline"
          >
            跳过
          </button>
        </div>
      </section>
    </div>
  );
}

function StarRow({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (n: number) => void;
}) {
  return (
    <div className="flex items-center gap-3">
      <span className="w-16 shrink-0 text-[0.8125rem] text-ink-muted">{label}</span>
      <div className="flex items-center gap-0.5">
        {[1, 2, 3, 4, 5].map((n) => (
          <button
            key={n}
            type="button"
            aria-label={`${label} ${n} 分`}
            aria-pressed={value === n}
            onClick={() => onChange(n)}
            className="rounded-[3px] p-0.5"
          >
            <Star
              className={cn(
                "size-4 transition-colors",
                n <= value
                  ? "fill-judgment text-judgment"
                  : "fill-transparent text-ink-faint/60"
              )}
            />
          </button>
        ))}
      </div>
    </div>
  );
}
