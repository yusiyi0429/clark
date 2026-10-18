"use client";

/**
 * Agent 的提问（apps/api/src/askUser.ts）：回答后面挂一张提问卡，点「开始回答」打开弹窗，一题一页作答。
 * 参照 Claude / ChatGPT 的选项提问、Typeform 的一题一页、Linear / Superhuman 的键盘操作：
 * - 数字键选第几个选项，最后一个数字是「其他」（自己写）；选了自动到下一题，最后一题停在「提交」；
 * - 推荐的那个先有焦点，回车就是采纳；回车在「其他」里是下一题（Shift+回车换行）；← → 前后翻，进度条也能点；
 * - Esc 或 × 关掉，已选的留着，再点「开始回答」接着答；没选的题提交时算跳过。
 * 提交后这一句在对话里显示成紧凑的问答记录（AnswerRecord），Agent 接着回答；原文由服务端按提问卡重写。
 */
import { createContext, useContext, useEffect, useRef, useState, type KeyboardEvent } from "react";
import { ArrowRight, Check, ChevronLeft, PenLine, X } from "lucide-react";
import { Button, Modal } from "ts-design/primitives";
import type { TAskAnswerInput, TAskAnswerRecord, TConversationCard } from "@warmap/contracts";
import type { ConversationData } from "./useConversation";
import m from "@/styles/account-menu.module.css";
import e from "@/styles/entry-cards.module.css";
import a from "@/styles/ask-panel.module.css";

type QuestionsCard = Extract<TConversationCard, { kind: "questions" }>;
/** 一题的作答：选了第几个，或者在「其他」里写的。 */
type Pick = { option: number } | { text: string };
type Draft = Record<string, Pick | undefined>;

/** 对话时间线给提问卡的：发送、这一轮是否在进行、哪几组提问已经回答过（按 askId）。 */
export const AskContext = createContext<{ send: ConversationData["send"]; streaming: boolean; answered: Set<string> } | null>(null);

/** 本人这次的作答：交给服务端的答案，和先画出来的问答记录（与服务端存下的同形）。 */
export function answersOf(card: QuestionsCard, draft: Draft): { input: TAskAnswerInput; record: TAskAnswerRecord } {
  const items: TAskAnswerInput["items"] = [];
  const record: TAskAnswerRecord["items"] = card.questions.map((question) => {
    const pick = draft[question.id];
    const base = { questionId: question.id, question: question.question };
    if (pick && "option" in pick) {
      items.push({ questionId: question.id, option: pick.option });
      const option = question.options[pick.option];
      return { ...base, kind: "option" as const, answer: option.label, ...(option.recommended ? { recommended: true } : {}) };
    }
    if (pick?.text.trim()) {
      items.push({ questionId: question.id, text: pick.text.trim() });
      return { ...base, kind: "other" as const, answer: pick.text.trim() };
    }
    return { ...base, kind: "skipped" as const };
  });
  return { input: { askId: card.askId, items }, record: { askId: card.askId, items: record } };
}

/** 对话里的提问卡：题目和「开始回答」；回答过的只剩一行「已回答」（问答记录在下面那一句里）。 */
export function AskCard({ card }: { card: QuestionsCard }) {
  const ask = useContext(AskContext);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState<Draft>({});
  if (ask?.answered.has(card.askId)) {
    return <section className={e.card} aria-label="提问" data-testid="ask-card" data-answered=""><div className={e.done}><Check size={14} strokeWidth={2.6} aria-hidden />已回答</div></section>;
  }
  const submit = () => {
    if (!ask) return;
    const answers = answersOf(card, draft);
    setOpen(false);
    void ask.send(answers.record.items.map((item) => `${item.question}：${item.answer ?? "跳过"}`).join("\n"), [], { answers });
  };
  return (
    <section className={e.card} aria-label="提问" data-testid="ask-card">
      <ol className={a.list}>{card.questions.map((question) => <li key={question.id}>{question.question}</li>)}</ol>
      <footer className={e.foot}>
        <span />
        <Button variant="primary" className={a.start} isDisabled={!ask || ask.streaming} onPress={() => setOpen(true)} data-testid="ask-start">
          开始回答<ArrowRight size={16} aria-hidden />
        </Button>
      </footer>
      {open ? <AskDialog card={card} draft={draft} onDraft={setDraft} onClose={() => setOpen(false)} onSubmit={submit} /> : null}
    </section>
  );
}

function AskDialog({ card, draft, onDraft, onClose, onSubmit }: {
  card: QuestionsCard; draft: Draft; onDraft: (draft: Draft) => void; onClose: () => void; onSubmit: () => void;
}) {
  const total = card.questions.length;
  // 接着上次关掉的地方答：第一道还没答的题。
  const [index, setIndex] = useState(() => Math.max(0, card.questions.findIndex((question) => !draft[question.id])));
  const [back, setBack] = useState(false);
  const question = card.questions[index];
  const pick = draft[question.id];
  const last = index === total - 1;
  const otherIndex = question.options.length;
  const optionRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const otherRef = useRef<HTMLTextAreaElement>(null);
  const nextRef = useRef<HTMLButtonElement>(null);
  const advance = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(advance.current), []);

  // 翻到一题：焦点放在已选的、推荐的或第一个选项上（推荐的有焦点，回车就是采纳）。
  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      if (pick && "text" in pick) { otherRef.current?.focus(); return; }
      const target = pick && "option" in pick ? pick.option : Math.max(0, question.options.findIndex((option) => option.recommended));
      optionRefs.current[target]?.focus();
    });
    return () => cancelAnimationFrame(frame);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 只在翻页时定焦点
  }, [index]);

  const go = (to: number) => {
    window.clearTimeout(advance.current);
    if (to < 0 || to >= total || to === index) return;
    setBack(to < index);
    setIndex(to);
  };
  const forward = () => (last ? onSubmit() : go(index + 1));
  const set = (value: Pick | undefined) => onDraft({ ...draft, [question.id]: value });
  const choose = (option: number) => {
    set({ option });
    window.clearTimeout(advance.current);
    // 选了就走（Typeform）：留一下让选中的样子看得见；最后一题停在「提交」上。
    if (last) requestAnimationFrame(() => nextRef.current?.focus());
    else advance.current = window.setTimeout(() => go(index + 1), 180);
  };
  const writeOther = () => {
    window.clearTimeout(advance.current);
    set({ text: pick && "text" in pick ? pick.text : "" });
    requestAnimationFrame(() => otherRef.current?.focus());
  };
  // 跳过：清掉这题的选择；最后一题停在「提交」上，不替本人提交。
  const skip = () => {
    set(undefined);
    if (last) requestAnimationFrame(() => nextRef.current?.focus());
    else go(index + 1);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
    const typing = event.target instanceof HTMLTextAreaElement;
    if (event.key === "Enter" && !event.shiftKey && (typing || !(event.target instanceof HTMLButtonElement))) {
      event.preventDefault();
      forward();
      return;
    }
    if (typing) return;
    const digit = /^[1-9]$/.test(event.key) ? Number(event.key) - 1 : -1;
    if (digit >= 0 && digit < otherIndex) { event.preventDefault(); choose(digit); }
    else if (digit === otherIndex) { event.preventDefault(); writeOther(); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); go(index - 1); }
    else if (event.key === "ArrowRight") { event.preventDefault(); go(index + 1); }
  };

  const titleId = `ask-${card.askId}-${question.id}`;
  return (
    <Modal isOpen onOpenChange={(isOpen) => (isOpen ? undefined : onClose())}>
      <Modal.Backdrop className={m.backdrop} isDismissable>
        <Modal.Container size="lg">
          <Modal.Dialog className={`${m.dialog} ${m.wide} ${a.dialog}`} aria-labelledby={titleId} data-testid="ask-dialog">
            <div onKeyDown={onKeyDown} style={{ display: "contents" }}>
              <header className={a.head}>
                {total > 1 ? <>
                  <ol className={a.progress} aria-label="进度">
                    {card.questions.map((item, at) => (
                      <li key={item.id}>
                        <button type="button" className={a.segment} aria-label={`第 ${at + 1} 题`} aria-current={at === index ? "step" : undefined}
                          data-answered={draft[item.id] ? "" : undefined} onClick={() => go(at)} tabIndex={-1} />
                      </li>
                    ))}
                  </ol>
                  <span className={a.count}>{index + 1}/{total}</span>
                </> : <span className={a.spacer} />}
                <Button variant="ghost" isIconOnly className={m.close} onPress={onClose} aria-label="关闭"><X size={18} aria-hidden /></Button>
              </header>
              <div key={question.id} className={a.page} data-back={back ? "" : undefined}>
                <h2 id={titleId} className={a.question}>{question.question}</h2>
                <div className={a.options} role="radiogroup" aria-labelledby={titleId}>
                  {question.options.map((option, at) => {
                    const checked = Boolean(pick && "option" in pick && pick.option === at);
                    return (
                      <button key={option.label} ref={(element) => { optionRefs.current[at] = element; }} type="button" role="radio" aria-checked={checked}
                        className={a.option} onClick={() => choose(at)} data-testid="ask-option">
                        <kbd className={a.key} aria-hidden>{at + 1}</kbd>
                        <span className={a.optionText}><span>{option.label}</span>{option.detail ? <small>{option.detail}</small> : null}</span>
                        <span className={a.trail}>
                          {option.recommended ? <span className={a.recommended}>推荐</span> : null}
                          {checked ? <Check size={16} strokeWidth={2.6} aria-hidden /> : null}
                        </span>
                      </button>
                    );
                  })}
                  <div className={a.other}>
                    <button ref={(element) => { optionRefs.current[otherIndex] = element; }} type="button" role="radio" aria-checked={Boolean(pick && "text" in pick)}
                      className={a.option} onClick={writeOther} data-testid="ask-other">
                      <kbd className={a.key} aria-hidden>{otherIndex + 1}</kbd>
                      <span className={a.optionText}><span>其他</span></span>
                      <span className={a.trail}><PenLine size={15} aria-hidden /></span>
                    </button>
                    {pick && "text" in pick ? (
                      <textarea ref={otherRef} className={a.otherInput} aria-label="其他" rows={2} maxLength={1000} value={pick.text}
                        onChange={(event) => set({ text: event.target.value })} />
                    ) : null}
                  </div>
                </div>
              </div>
              <footer className={a.foot}>
                {index > 0 ? <Button variant="ghost" className={a.back} onPress={() => go(index - 1)}><ChevronLeft size={16} aria-hidden />上一题</Button> : null}
                <span className={a.spacer} />
                <Button variant="ghost" className={a.skip} onPress={skip}>跳过</Button>
                <Button ref={nextRef} variant="primary" className={a.next} onPress={forward} data-testid="ask-next">{last ? "提交" : "下一题"}</Button>
              </footer>
            </div>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  );
}

/** 作答那一句：问题一行浅色、答案一行；采纳推荐的带「推荐」，跳过的写「跳过」。 */
export function AnswerRecord({ record }: { record: TAskAnswerRecord }) {
  return (
    <dl className={a.record} data-testid="ask-record">
      {record.items.map((item) => (
        <div key={item.questionId}>
          <dt>{item.question}</dt>
          <dd data-kind={item.kind}>{item.kind === "skipped" ? "跳过" : item.answer}{item.recommended ? <span className={a.recommended}>推荐</span> : null}</dd>
        </div>
      ))}
    </dl>
  );
}
