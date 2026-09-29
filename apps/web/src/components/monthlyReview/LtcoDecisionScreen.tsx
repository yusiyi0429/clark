"use client";

/**
 * 公司长期目标审视（spec §6.3 · Co-Agent Design 的 LTO）：复盘和「长期目标要不要改」分开。
 * 审视范围是公司 LTCO 和每个战场 / 能力域的长期目标；LTO 主要看战略，复盘只是输入之一，所以默认「保持不变」。
 * 修订时逐条采用 Co-Agent 的建议或自己改，确认后写回配置，并立即生成下月计划草案。
 */
import { useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "ts-design/primitives";
import type { TMonthlyReviewPayload } from "@warmap/contracts";
import type { Card } from "@/lib/api/client";
import { monthDayTime } from "@/lib/companyTime";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { FeedbackLink } from "./FeedbackLink";
import { monthOf, requestError, runReviewAction } from "./reviewApi";
import s from "@/components/missionCards/mission-card.module.css";
import r from "./monthly-review.module.css";

const NO_CARDS: Card[] = [];
type Unit = TMonthlyReviewPayload["ltco"]["units"][number];
const unitKey = (unit: { subjectType: string; subjectId: string }) => `${unit.subjectType}:${unit.subjectId}`;

export function LtcoDecisionScreen({ review }: { review: TMonthlyReviewPayload }) {
  const workspace = useWorkspace();
  const router = useRouter();
  const suggestion = review.ltco.suggestion;
  const suggestedUnits = useMemo(() => new Map((suggestion?.units ?? []).map((unit) => [unitKey(unit), unit])), [suggestion]);
  const suggestsChange = Boolean(suggestion && (suggestion.change || suggestion.units.length));
  const [choice, setChoice] = useState<"keep" | "revise">(suggestsChange ? "revise" : "keep");
  // 修订稿预填 Co-Agent 的建议；没有建议的单元保持原文。
  const [ltcoText, setLtcoText] = useState(suggestion?.change ? suggestion.proposedLtco : review.ltco.current);
  const [unitTexts, setUnitTexts] = useState<Record<string, string>>(() => Object.fromEntries(review.ltco.units.map((unit) => [unitKey(unit), suggestedUnits.get(unitKey(unit))?.proposedOutcome ?? unit.current])));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const month = monthOf(review.period);
  const next = monthOf(review.nextPeriod);
  useRegisterDetail(useMemo(() => ({ scope: "global", label: `${month} 月复盘 · 公司长期目标`, mark: "monthly" as const, cards: NO_CARDS }), [month]));

  const decide = review.actions.find((candidate) => candidate.actionType === "monthly-review.decide_ltco");
  const ltcoChanged = ltcoText.trim() !== "" && ltcoText.trim() !== review.ltco.current.trim();
  const changedUnits = review.ltco.units.filter((unit) => (unitTexts[unitKey(unit)] ?? "").trim() !== "" && unitTexts[unitKey(unit)].trim() !== unit.current.trim());
  const emptyUnit = review.ltco.units.some((unit) => !(unitTexts[unitKey(unit)] ?? "").trim());
  const nothingChanged = choice === "revise" && !ltcoChanged && changedUnits.length === 0;
  // 原来有 LTCO 时不能改成空；原来就没写的，可以只改单元长期目标。
  const clearsLtco = !ltcoText.trim() && review.ltco.current.trim() !== "";
  const submit = async () => {
    if (!decide || inFlight.current) return;
    inFlight.current = true; setPending(true); setError("");
    try {
      await runReviewAction(decide, choice === "keep" ? { decision: "keep" } : {
        decision: "revise",
        ...(ltcoChanged ? { ltco: ltcoText.trim() } : {}),
        ...(changedUnits.length ? { units: changedUnits.map((unit) => ({ subjectType: unit.subjectType, subjectId: unit.subjectId, sixMonthOutcome: unitTexts[unitKey(unit)].trim() })) } : {}),
      });
      workspace.navigate(`/plans/${review.nextPeriod}`);
      router.refresh();
    } catch (cause) { setError(requestError(cause, "暂时无法连接服务器，请稍后重试；输入已保留。")); }
    finally { inFlight.current = false; setPending(false); }
  };

  const decided = review.ltco.decision;
  const revising = choice === "revise" && Boolean(decide) && !decided;
  const unitName = (unit: Unit) => `${unit.subjectCode ? `${unit.subjectCode} ` : ""}${unit.subjectName}`;
  const groups = [
    { title: "战场长期目标", units: review.ltco.units.filter((unit) => unit.subjectType === "battlefield") },
    { title: "能力域长期目标", units: review.ltco.units.filter((unit) => unit.subjectType === "capability") },
  ].filter((group) => group.units.length);

  return <div className={s.screen}>
    <DetailFrame title="公司长期目标审视" subtitle={`${month} 月复盘 · 下一步：${next} 月计划`} onBack={() => workspace.navigate(`/reviews/${review.period}`)}>
      <div className={s.content}><div className={`${s.document} ${r.ltco}`}>
        {error ? <p className={s.error} role="alert">{error}</p> : null}
        {suggestion ? <section className={r.suggestion} aria-label="Co-Agent 建议">
          <header>Co-Agent 建议：{suggestsChange ? "修订" : "保持不变"}（来自已确认的公司月度复盘）</header>
          <p>{suggestion.rationale}</p>
        </section> : null}

        {decided ? <p className={`${s.readonly} ${s.readonly}`}>{monthDayTime(decided.decidedAt)} 已决定{decided.decision === "keep" ? "保持不变" : `修订${decided.ltcoAfter !== decided.ltcoBefore ? "公司 LTCO" : ""}${decided.units.length ? `${decided.ltcoAfter !== decided.ltcoBefore ? "和" : ""} ${decided.units.length} 个单元的长期目标` : ""}`}。</p> : decide ? <div className={r.choices} role="radiogroup" aria-label="长期目标是否修订">
          <label className={r.choice}>
            <input type="radio" name="ltco" value="keep" checked={choice === "keep"} onChange={() => setChoice("keep")} disabled={pending} />
            <strong>保持不变</strong>
            <span>战略没有变，沿用现在的公司 LTCO 和各单元长期目标，直接生成 {next} 月计划草案。</span>
          </label>
          <label className={r.choice}>
            <input type="radio" name="ltco" value="revise" checked={choice === "revise"} onChange={() => setChoice("revise")} disabled={pending} />
            <strong>修订</strong>
            <span>在下面直接改；Co-Agent 建议改的地方已经预填。只写回改过的，{next} 月计划按新的目标生成。</span>
          </label>
        </div> : <p className={`${s.readonly} ${s.readonly}`}>公司月度复盘确认后才能审视长期目标。</p>}

        <section aria-label="公司 LTCO">
          <h2 className={r.label}>公司 LTCO</h2>
          {revising
            ? <textarea className={r.editor} aria-label="修订后的公司 LTCO" value={ltcoText} rows={4} maxLength={4000} disabled={pending} onChange={(event) => setLtcoText(event.target.value)} />
            : <p className={r.ltcoText}>{(decided?.ltcoAfter ?? review.ltco.current) || "还没有填写 LTCO"}</p>}
          {revising && ltcoChanged ? <p className={r.unitSuggest}>已改动 · 原文：{review.ltco.current || "（空）"}</p> : null}
        </section>

        {groups.map((group) => <section key={group.title} aria-label={group.title}>
          <h2 className={r.label}>{group.title}</h2>
          <ul className={r.unitGoals}>
            {group.units.map((unit) => {
              const key = unitKey(unit);
              const suggested = suggestedUnits.get(key);
              const changed = changedUnits.some((item) => unitKey(item) === key);
              const after = decided?.units.find((item) => unitKey(item) === key)?.after;
              return <li key={key} className={r.unitGoal} data-changed={(revising && changed) || after ? "" : undefined}>
                <strong>{unitName(unit)}</strong>
                {revising
                  ? <textarea aria-label={`${unitName(unit)}的长期目标`} value={unitTexts[key] ?? ""} maxLength={4000} disabled={pending} onChange={(event) => setUnitTexts({ ...unitTexts, [key]: event.target.value })} />
                  : <p>{after ?? unit.current ?? "未填写"}</p>}
                {suggested ? <span className={r.unitSuggest}>Co-Agent 建议修订：{suggested.rationale}</span> : null}
                {revising && suggested ? <span className={s.inlineActions}>
                  <Button variant="ghost" className={s.textAction} isDisabled={pending} onPress={() => setUnitTexts({ ...unitTexts, [key]: unit.current })}>恢复原文</Button>
                  <Button variant="ghost" className={s.textAction} isDisabled={pending} onPress={() => setUnitTexts({ ...unitTexts, [key]: suggested.proposedOutcome })}>用建议</Button>
                </span> : null}
              </li>;
            })}
          </ul>
        </section>)}

        {decide && !decided ? <>
          <div className={r.bar}>
            <Button variant="primary" className={s.primary} isDisabled={pending || nothingChanged || (choice === "revise" && (emptyUnit || clearsLtco))} onPress={() => void submit()}>
              {pending ? "正在确认…" : choice === "keep" ? "保持不变，生成下月计划" : "确认修订，生成下月计划"}
            </Button>
            <p className={`${s.hint} ${r.hint}`}>确认后 Co-Agent 会带上这次复盘开始起草 {next} 月计划，你在计划页协商、签发。</p>
          </div>
          {nothingChanged ? <p className={s.hint}>还没有改动；不改的话请选「保持不变」。</p> : null}
        </> : null}
        <FeedbackLink />
      </div></div>
    </DetailFrame>
  </div>;
}
