"use client";

/** 个人复盘、周复盘共用的阅读件：带出处标记的正文、生成步骤。 */
import ReactMarkdown from "react-markdown";
import { Check, Loader2, X } from "lucide-react";
import { CITATION_MARKDOWN } from "@/conversation/citations";
import { remarkCitationMarks } from "@/conversation/citationMarks";
import r from "./monthly-review.module.css";

const REMARK_PLUGINS = [remarkCitationMarks];

/** 一栏正文：每行一段，句末出处显示成小标记；连续的「- 」「1. 」行仍是同一个列表。 */
export function ReviewText({ text }: { text: string }) {
  return <div className={r.reviewText}><ReactMarkdown remarkPlugins={REMARK_PLUGINS} {...CITATION_MARKDOWN}>{text.replace(/\n+(?!\s*(?:[-*•]|\d+[.)])\s)/g, "\n\n")}</ReactMarkdown></div>;
}

export type ReviewStep = { id: string; label: string; status: "pending" | "running" | "done" | "failed"; result?: string };

/** Co-Agent 生成的步骤，每步一行，结果跟在后面。 */
export function GenerationSteps({ steps }: { steps: ReviewStep[] }) {
  return <ol className={r.steps}>
    {steps.map((step) => <li key={step.id} data-state={step.status}>
      <span className={r.stepMark} aria-hidden>{step.status === "running" ? <Loader2 size={12} /> : step.status === "done" ? <Check size={12} /> : step.status === "failed" ? <X size={12} /> : null}</span>
      <span>{step.label}{step.result ? <small>{step.result}</small> : null}</span>
    </li>)}
  </ol>;
}
