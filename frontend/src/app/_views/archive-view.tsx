"use client";

import { Search } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { AsyncBoundary } from "@/components/async-boundary";
import { Panel, PanelEmpty, PanelHead } from "@/components/panel";
import { CodeText } from "@/components/provenance/code-ref";
import { api } from "@/lib/data/client";
import type { Card } from "@/lib/data/types";
import { formatStamp } from "@/lib/format";
import { useInvalidate, useResource } from "@/lib/use-resource";

/**
 * 待定区 —— 被「待定」收起来的低优先级信号。
 *
 * 它存在的理由只有一条：**待定不是删除**。信号被降级也要留痕、要可捞回 ——
 * 半年后有人问「这件事当时看到过吗」，答案得在屏幕上。所以每条写明抓取时间与
 * 待定时间，唯一的动作是把它捞回去做深度研究。
 */
export function ArchiveView() {
  const resource = useResource<Card[]>("parked", () => api.listParked());

  return (
    <Panel>
      <AsyncBoundary resource={resource} skeleton={<ArchiveSkeleton />}>
        {(cards) => (
          <>
            <PanelHead
              eyebrow={`待定区 · ${cards.length} 条`}
              title="被待定的信号，账都在这儿。"
            />

            {cards.length === 0 ? (
              <PanelEmpty title="待定区是空的。">
                <Link
                  href="/signals"
                  className="meta text-ink-muted underline decoration-hairline underline-offset-4 transition-colors duration-fast hover:text-ink hover:decoration-ink-faint"
                >
                  回潜在议题 →
                </Link>
              </PanelEmpty>
            ) : (
              /*
               * 一份清单装在一块面里 —— 不是一条条浮着的卡片。
               *
               * 没有 `space-y`：行贴着行，两行之间那条从内容左沿起画的发丝线由
               * `.row` 自己负责，留了缝这条线就没有中缝可贴。
               */
              <ul className="card mt-7 overflow-hidden">
                {cards.map((card, i) => (
                  <li
                    key={card.id}
                    className="stagger row concentric"
                    style={{ "--i": i } as React.CSSProperties}
                  >
                    <ParkedRow card={card} onChanged={() => resource.mutate()} />
                  </li>
                ))}
              </ul>
            )}
          </>
        )}
      </AsyncBoundary>
    </Panel>
  );
}

function ParkedRow({ card, onChanged }: { card: Card; onChanged: () => void }) {
  const invalidate = useInvalidate();
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);

  const research = async () => {
    setBusy(true);
    try {
      // H2 —— 服务端说了算。捞回 = 采信入池，后台深研随之启动。
      const issue = await api.disposeCard(card.id, "discuss");
      setDone(issue.id);
      invalidate("parked");
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="px-3.5 py-3.5">
      <div className="flex flex-wrap items-baseline gap-x-2.5 gap-y-1">
        <span className="meta text-ink-faint">{card.issueId}</span>
        <span className="meta text-ink-faint">抓取于 {formatStamp(card.createdAt)}</span>
        {card.disposedAt && (
          <span className="meta text-ink-faint">· 待定于 {formatStamp(card.disposedAt)}</span>
        )}
      </div>
      <p className="report mt-1 text-md leading-relaxed text-ink">
        <CodeText text={card.what[0]?.text ?? ""} />
      </p>
      <div className="mt-2.5">
        {done ? (
          <p className="meta text-confirmed">
            已启动深度研究 ·{" "}
            <Link
              href={`/issues/${done}`}
              className="rounded-[3px] underline decoration-hairline underline-offset-[3px] hover:decoration-ink-faint"
            >
              去议题研究 →
            </Link>
          </p>
        ) : (
          <button
            type="button"
            disabled={busy}
            onClick={() => void research()}
            className="meta inline-flex items-center gap-1.5 rounded-md border border-hairline-strong px-2.5 py-1.5 font-medium text-ink transition-colors duration-fast ease-swift hover:bg-neutral-wash disabled:opacity-50"
          >
            <Search className="size-3.5" aria-hidden />
            {busy ? "正在启动深研…" : "深度研究议题"}
          </button>
        )}
      </div>
    </div>
  );
}

function ArchiveSkeleton() {
  return (
    <div aria-live="polite">
      <span className="skeleton block h-2.5 w-28" />
      <span className="skeleton mt-2.5 block h-5 w-[46%]" />
      {/* 骨架跟真清单同一套结构（`.card` + `.row`），否则数据到手的一瞬间
          边和间距一起变，布局会跳。 */}
      <div className="card mt-7 overflow-hidden">
        {[0, 1].map((i) => (
          <div key={i} className="row concentric px-3.5 py-3.5">
            <span className="skeleton block h-2.5 w-48" />
            <span className="skeleton mt-2 block h-4 w-[80%]" />
          </div>
        ))}
      </div>
    </div>
  );
}
