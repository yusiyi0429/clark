import type { Divergence } from "@/lib/data/types";
import { cn } from "@/lib/utils";

/**
 * 开放分歧, in three colours that mean three different kinds of work.
 *
 * Fact: someone can go and check. Hypothesis: someone can go and test. Value:
 * nobody can do anything except the person whose call it is — which is why that
 * one is a solid block rather than a tint. The CEO should be able to scan the
 * colours and know, without reading, which lines are theirs alone.
 */

const KIND: Record<
  Divergence["kind"],
  { label: string; wrap: string; bar: string; tag: string; note: string }
> = {
  fact: {
    label: "事实",
    wrap: "bg-factual-wash",
    bar: "border-l-factual",
    tag: "text-factual",
    note: "text-ink-muted",
  },
  hypothesis: {
    label: "假设",
    wrap: "bg-judgment-wash",
    bar: "border-l-judgment",
    tag: "text-judgment",
    note: "text-ink-muted",
  },
  value: {
    label: "价值",
    wrap: "bg-solid text-solid-fg",
    bar: "border-l-solid",
    tag: "text-solid-fg/70",
    note: "text-solid-fg/70",
  },
};

export function DivergenceBlock({ divergence }: { divergence: Divergence }) {
  const kind = KIND[divergence.kind];
  return (
    <div className={cn("border-l-4 px-4 py-3", kind.wrap, kind.bar)}>
      <p className={cn("meta", kind.tag)}>{kind.label}</p>
      <p
        className={cn(
          "mt-1 text-[0.9375rem] leading-[1.75]",
          divergence.kind === "value" ? "text-solid-fg" : "text-ink"
        )}
      >
        {divergence.text}
      </p>
      <p className={cn("meta mt-1.5", kind.note)}>{divergence.note}</p>
    </div>
  );
}
