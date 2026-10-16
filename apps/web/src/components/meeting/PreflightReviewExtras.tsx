"use client";

import type { TPreflightCeoOption, TPreflightDivergence, TPreflightMaterialQuestions } from "@warmap/contracts";
import { SourceList } from "./SourceViewer";
import s from "@/styles/meeting-workspace.module.css";

/**
 * 预审 v4 的两段（对照 Decision Brief 会前预审卡）：材料自带待决题的逐条判断，以及按三类归好的开放分歧；
 * 另有一号位追问下「不同回答各自意味着什么」。都只是预审的候选判断，不是决定。
 */

const VERDICT_LABEL: Record<string, string> = { ceo: "需要一号位判断", owner: "负责人可定", monitor: "转监测，不阻塞" };

export function MaterialQuestionsSection({ value }: { value: TPreflightMaterialQuestions | undefined }) {
  if (!value || !value.items.length) return null;
  const ceo = value.items.filter((item) => item.verdict === "ceo").length;
  return (
    <section className={s.reviewSection} data-group="material_questions">
      <header>
        <h3>材料自带的待决题</h3>
        <span>{value.items.length} 道 · {ceo} 道需要一号位判断</span>
      </header>
      {value.items.map((item, index) => (
        <article key={`${index}-${item.question}`} className={s.quoteItem} data-verdict={item.verdict}>
          <div className={s.entryTitle}>
            <span>{String(index + 1).padStart(2, "0")}</span>
            <strong>{item.question}</strong>
          </div>
          <p className={s.verdictLine}><b data-verdict={item.verdict}>{VERDICT_LABEL[item.verdict] ?? item.verdict}</b>{item.reason}</p>
          <SourceList refs={item.sourceRefs} />
        </article>
      ))}
    </section>
  );
}

const DIVERGENCE_GROUPS: { type: TPreflightDivergence["type"]; label: string; hint: string }[] = [
  { type: "value_tradeoff", label: "价值取舍", hint: "需要一号位选择" },
  { type: "judgment", label: "判断分歧", hint: "已收敛到哪里、还差什么" },
  { type: "fact_gap", label: "事实不足", hint: "转监测，不阻塞本次决定" },
];

export function DivergencesSection({ value }: { value: TPreflightDivergence[] | undefined }) {
  if (!value || !value.length) return null;
  return (
    <section className={s.reviewSection} data-group="divergences">
      <header>
        <h3>开放分歧</h3>
        <span>{value.length} 处</span>
      </header>
      {DIVERGENCE_GROUPS.map((group) => {
        const items = value.filter((item) => item.type === group.type);
        if (!items.length) return null;
        return (
          <div key={group.type} className={s.divergenceGroup}>
            <small>{group.label} · {group.hint}</small>
            {items.map((item) => (
              <article key={item.title} className={s.quoteItem}>
                <div className={s.entryTitle}><strong>{item.title}</strong></div>
                <p className={s.entryBody}>{item.body}</p>
                {item.converged ? <p className={s.verdictLine}><b>已收敛</b>{item.converged}</p> : null}
                <SourceList refs={item.sourceRefs} />
              </article>
            ))}
          </div>
        );
      })}
    </section>
  );
}

/** 一号位追问下的「若回答……意味着……」。 */
export function LensAnswers({ options }: { options: TPreflightCeoOption[] | undefined }) {
  if (!options?.length) return null;
  return (
    <ul className={s.lensAnswers}>
      {options.map((option) => (
        <li key={option.label}><b>若回答「{option.label}」</b>{option.impact}</li>
      ))}
    </ul>
  );
}
