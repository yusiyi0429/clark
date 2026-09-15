"use client";

import { ChevronDown, ChevronRight } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import type { AssemblyManifest } from "@/lib/data/types";

/**
 * 装配清单.
 *
 * The visible proof that the CEO never has to introduce the background. Clark's
 * first message says what it brought in before it says anything else, because
 * the alternative — trusting that context was assembled — is exactly what makes
 * every other assistant unusable at this altitude.
 *
 * It lives inside the opening message rather than in a top bar or a drawer: it
 * is an opening remark, not a setting. Afterwards it is audit material, and
 * audit material belongs in the issue timeline.
 */
export function AssemblyManifestBlock({
  manifest,
}: {
  manifest: AssemblyManifest;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="rounded-lg border border-hairline bg-neutral-wash/60">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="meta flex w-full items-center gap-1.5 px-3 py-2 text-ink-muted transition-colors hover:text-ink"
      >
        {open ? (
          <ChevronDown className="size-3" />
        ) : (
          <ChevronRight className="size-3" />
        )}
        带了 {manifest.total} 项 Context
      </button>

      {open && (
        <div className="space-y-3.5 border-t border-hairline px-3 py-3">
          {manifest.groups.map((group) => (
            <section key={group.label}>
              <h4 className="meta text-ink-faint">{group.label}</h4>
              <ul className="mt-1 space-y-1">
                {group.items.map((item, i) => (
                  <li
                    key={i}
                    className="flex gap-2 text-[0.8125rem] leading-[1.7] text-ink-muted"
                  >
                    <span aria-hidden className="text-ink-faint/70">
                      ·
                    </span>
                    {/*
                      带 href 的项是本体对象，点得开。一句「带了 12 项 Context」
                      如果点不开，读者只能选择相信或不相信，那就不是证明。
                    */}
                    {item.href ? (
                      <Link
                        href={item.href}
                        className="rounded-[3px] underline decoration-hairline underline-offset-[3px] transition-colors hover:text-ink hover:decoration-ink-faint"
                      >
                        {item.label}
                      </Link>
                    ) : (
                      <span>{item.label}</span>
                    )}
                  </li>
                ))}
              </ul>
            </section>
          ))}
          <p className="meta border-t border-hairline pt-2.5 text-ink-faint">
            M03 assembly manifest
          </p>
        </div>
      )}
    </div>
  );
}
