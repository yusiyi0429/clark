"use client";

/**
 * 执行方问本人（Claude Code 的 AskUserQuestion，本机摘要的 pendingQuestion）：每个问题的选项是按钮，可以另外写一句。
 * 只有一个单选问题时点一下就答；多选或几个问题时选好了点「发送」。卡页、派活单的行、worker 详情共用。
 */
import { useState } from "react";
import type { TLocalQuestionAnswerRequest, TLocalQuestionRequestView } from "@warmap/contracts";
import { HeroButton } from "@/components/HeroButton";
import w from "@/styles/v2-work.module.css";

/** 行里、左栏里写的那一句：第一个问题的标题，没有标题就是问题本身。 */
export const questionTitle = (request: TLocalQuestionRequestView) => request.questions[0]!.header || request.questions[0]!.question;

/** 一个单选问题：点选项就答。 */
export const oneTap = (request: TLocalQuestionRequestView) => request.questions.length === 1 && !request.questions[0]!.multiSelect;

export function QuestionForm({ request, busy, onAnswer }: { request: TLocalQuestionRequestView; busy: boolean; onAnswer: (body: TLocalQuestionAnswerRequest) => void }) {
  const [picks, setPicks] = useState<string[][]>(() => request.questions.map(() => []));
  const [text, setText] = useState("");
  const quick = oneTap(request);
  const pick = (index: number, label: string) => {
    if (quick) { onAnswer({ choices: [[label]], ...(text.trim() ? { text: text.trim() } : {}) }); return; }
    setPicks((current) => current.map((chosen, i) => (i !== index ? chosen
      : request.questions[i]!.multiSelect ? (chosen.includes(label) ? chosen.filter((entry) => entry !== label) : [...chosen, label])
      : [label])));
  };
  const ready = picks.some((chosen) => chosen.length) || text.trim();
  return (
    <form className={w.qform} data-testid="question-form" onSubmit={(event) => { event.preventDefault(); if (ready) onAnswer({ choices: picks, ...(text.trim() ? { text: text.trim() } : {}) }); }}>
      {request.questions.map((question, index) => (
        <div key={index} className={w.q}>
          <span className={w.m}>{question.header ? <b>{question.header} · </b> : null}{question.question}</span>
          <span className={w.acts}>
            {question.options.map((option) => (
              <HeroButton key={option.label} size="sm" variant={picks[index]!.includes(option.label) ? "primary" : "secondary"} isDisabled={busy} title={option.description || undefined}
                onPress={() => pick(index, option.label)}>{option.label}</HeroButton>
            ))}
          </span>
        </div>
      ))}
      <span className={w.acts}>
        <span className={w.inline}><input value={text} maxLength={4000} placeholder="回复" aria-label="回复" onChange={(event) => setText(event.target.value)} /></span>
        <HeroButton variant="primary" size="sm" type="submit" isDisabled={busy || !ready}>发送</HeroButton>
      </span>
    </form>
  );
}
