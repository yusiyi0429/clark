"use client";

import { useEffect, useState } from "react";
import { TraceChips } from "@/components/trace-chip";
import type { ProbeNode, Statement } from "@/lib/data/types";
import { cn } from "@/lib/utils";

/**
 * 报告正文里的一节，带**划线句**。
 *
 * 这段代码原来长在把关区那个文件里。把关区废掉了，它得留下来。
 *
 * 它的作用是**双向锚**：探讨链路上的每个节点都记着自己是从报告哪一句长出来的
 * （`ProbeNode.anchor`）。报告这边把有节点挂着的句子画上虚下划线并标出条数，点开能跳
 * 到那几个节点；链路那边点「来源」，这边滚回去并闪一下。一号位读报告读到关键那句时，
 * 最想问的就是「这句话后来怎么了」—— 这条线就是答案。
 */

export type DocSection = "judgment" | "keyEvidence" | "counters" | "unknowns";

/** 链路那头点了「来源」。`nonce` 让连点同一句也能再触发一次。 */
export type AnchorFocus = { section: DocSection; index: number; nonce: number };

export function AnchoredStatementList({
  section,
  statements,
  nodes,
  onOpenNode,
  anchorFocus,
  className,
}: {
  section: DocSection;
  statements: Statement[];
  /** 挂在这一节上的探讨节点。承接研究那份报告没有，传空数组。 */
  nodes: ProbeNode[];
  onOpenNode: (nodeId: string) => void;
  anchorFocus: AnchorFocus | null;
  className?: string;
}) {
  const [openIndex, setOpenIndex] = useState<number | null>(null);
  const [flashIndex, setFlashIndex] = useState<number | null>(null);
  const [seenNonce, setSeenNonce] = useState<number | null>(null);

  const bySentence = new Map<number, ProbeNode[]>();
  for (const node of nodes) {
    // 放下的那几条照样挂着 —— 「这句话后来被推翻了」也是这一句的下文。
    if (node.anchor.kind !== "doc" || node.anchor.section !== section) continue;
    const list = bySentence.get(node.anchor.index) ?? [];
    list.push(node);
    bySentence.set(node.anchor.index, list);
  }

  // 渲染期校准（不在效应体里同步 setState）：链路那头点了来源，就亮这一句。
  if (anchorFocus && anchorFocus.section === section && anchorFocus.nonce !== seenNonce) {
    setSeenNonce(anchorFocus.nonce);
    setFlashIndex(anchorFocus.index);
  }

  useEffect(() => {
    if (flashIndex === null) return;
    requestAnimationFrame(() => {
      document
        .getElementById(`probe-anchor-${section}-${flashIndex}`)
        ?.scrollIntoView({ behavior: "smooth", block: "center" });
    });
    const t = setTimeout(() => setFlashIndex(null), 2400);
    return () => clearTimeout(t);
  }, [flashIndex, section]);

  return (
    <div className={cn("space-y-2", className)}>
      {statements.map((s, i) => {
        const linked = bySentence.get(i) ?? [];
        const open = openIndex === i && linked.length > 0;
        return (
          <div
            key={i}
            id={`probe-anchor-${section}-${i}`}
            className="relative"
          >
            {open ? (
              <div className="animate-fade absolute bottom-full left-0 z-10 mb-1.5 w-full space-y-1">
                {linked.map((node) => (
                  <button
                    key={node.id}
                    type="button"
                    onClick={() => {
                      setOpenIndex(null);
                      onOpenNode(node.id);
                    }}
                    className="block w-full rounded-md border border-hairline-strong bg-surface px-3 py-2 text-left shadow-sm transition-colors duration-fast hover:bg-neutral-wash"
                  >
                    <span className="meta mr-2 text-judgment">探讨链路</span>
                    <span className="text-sm text-ink">{node.text}</span>
                  </button>
                ))}
              </div>
            ) : null}
            <p
              className={cn(
                "report rounded-[3px] text-read text-ink transition-colors duration-base",
                flashIndex === i && "bg-judgment-wash",
              )}
            >
              {linked.length > 0 ? (
                /*
                 * 句子本身是正文，不是控件。以前这里整句包在 <button> 里，代价是这一句
                 * 选不中 —— 而挂着沉淀的恰恰是报告里最重要的那几句，一号位想划它去
                 * 「引用提问」的概率最高。所以正文回到 <span>：拖选照常，点一下
                 * （没在拖选时）仍然展开浮层；键盘和读屏走后面那枚计数片。
                 */
                <>
                  <span
                    onClick={() => {
                      if (window.getSelection()?.isCollapsed === false) return;
                      setOpenIndex(open ? null : i);
                    }}
                    className="cursor-pointer rounded-[3px] underline decoration-judgment/50 decoration-dotted decoration-[1.5px] underline-offset-4 transition-colors duration-fast hover:decoration-judgment"
                  >
                    {s.text}
                  </span>
                  <button
                    type="button"
                    aria-expanded={open}
                    onClick={() => setOpenIndex(open ? null : i)}
                    title={`这一句长出了 ${linked.length} 条判断陈述`}
                    className="meta ml-0.5 rounded-[3px] bg-judgment-wash px-1 align-[0.35em] text-judgment transition-colors duration-fast hover:bg-judgment/20"
                  >
                    {linked.length}
                  </button>
                </>
              ) : (
                s.text
              )}
              <TraceChips traces={s.traces} />
            </p>
          </div>
        );
      })}
    </div>
  );
}
