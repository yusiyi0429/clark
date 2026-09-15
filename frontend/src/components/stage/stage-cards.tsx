"use client";

import type { ReactNode } from "react";

import { AGENDA, agendaEvidence, agendaItem } from "@/lib/demo/agenda";
import {
  DECISION_LABEL,
  EXPLORATION_LABEL,
  type DecisionDraft,
  type ExplorationCard,
} from "@/lib/stage/events";
import { summaryCounts, type StageState } from "@/lib/stage/reducer";
import { cn } from "@/lib/utils";

/**
 * 舞台上的固定模板卡。
 *
 * 每一张的字段是写死的：标题在哪儿、序号在哪儿、出处在哪儿，一个都不许由模型决定。
 * 模型只能说「打第 3 号证据」，打成什么样是这个文件的事。
 *
 * 这条规矩不是洁癖。模型如果能决定屏幕长什么样，那么会上任何一次它跑偏 —— 一段没闭合
 * 的标签、一个它以为很好看的样式、一句它自己加的标题 —— 都会当着客户的面出现在投影上，
 * 而那一刻没有人能解释。所以这里没有任何一处把字符串当 HTML 用：全站找不到
 * `dangerouslySetInnerHTML`（除了首屏那两段自己写的脚本）。
 *
 * 字号只许用 `--text-stage-*` 那四级。颜色只许用 token —— 出现一个字面色值，深底那一套
 * 就白搭了。
 */

// ---------------------------------------------------------------------------
// 底座
// ---------------------------------------------------------------------------

/**
 * 一张卡的外框。
 *
 * `max-w-[68ch]` 是给中文长句定的：投影上一行超过这个宽度，眼睛从行尾回到行首会丢行，
 * 而丢行的人会停下来重读 —— 那一下就是他不再听你说话的时候。
 */
function Frame({
  eyebrow,
  children,
  badge,
}: {
  eyebrow?: ReactNode;
  badge?: ReactNode;
  children: ReactNode;
}) {
  return (
    <article className="animate-rise mx-auto flex w-full max-w-[68ch] flex-col gap-8">
      {(eyebrow || badge) && (
        <header className="flex items-baseline justify-between gap-6">
          <p className="meta-stage text-ink-faint">{eyebrow}</p>
          {badge}
        </header>
      )}
      {children}
    </article>
  );
}

/** 一节。标签在上，内容在下 —— 四段式在手动模式里就是这个样子，这里只是把字放大。 */
function Part({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section>
      <h3 className="meta-stage mb-2 text-ink-faint">{label}</h3>
      <div className="text-stage text-ink">{children}</div>
    </section>
  );
}

/**
 * 状态角标。
 *
 * 「待确认 → 已立项」「草案 → 已确认」在会上是当着客户翻的那一下，所以它得够大、够
 * 显眼、位置固定 —— 翻过去的时候只有这一处在动，卡片本身一动不动。
 */
function Badge({ text, done }: { text: string; done: boolean }) {
  return (
    <span
      className={cn(
        "text-stage-meta shrink-0 rounded-full px-4 py-1 font-medium transition-colors duration-base ease-swift",
        done ? "bg-confirmed text-solid-fg" : "bg-neutral-wash text-ink-muted",
      )}
    >
      {text}
    </span>
  );
}

// ---------------------------------------------------------------------------
// ① 议程
// ---------------------------------------------------------------------------

/**
 * 今天有哪几件事。
 *
 * 开屏第一帧就是它，而且它不等模型 —— 议程是静态数据，`StageProvider` 在挂载那一瞬间
 * 就把它推上屏。已经讲过的条目会压暗并划掉，所以他抬头看一眼就知道还剩几件。
 */
export function AgendaCard({ state }: { state: StageState }) {
  const agenda = state.agenda ?? AGENDA;
  return (
    <Frame eyebrow={agenda.sessionTitle}>
      <h2 className="text-stage-title font-medium tracking-[-0.01em] text-ink">
        今天为您准备了 {agenda.items.length} 件事
      </h2>
      <ol className="stagger flex flex-col gap-5">
        {agenda.items.map((item, at) => {
          const done = state.presented.includes(item.id);
          return (
            <li
              key={item.id}
              style={{ "--i": at } as React.CSSProperties}
              className="flex items-baseline gap-5"
            >
              <span
                className={cn(
                  "meta-stage w-8 shrink-0 tabular-nums",
                  done ? "text-confirmed" : "text-ink-faint",
                )}
              >
                {done ? "✓" : String(at + 1).padStart(2, "0")}
              </span>
              <span
                className={cn(
                  "text-stage-lead transition-colors duration-base ease-swift",
                  done ? "text-ink-faint" : "text-ink",
                )}
              >
                {item.title}
              </span>
            </li>
          );
        })}
      </ol>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// ② 议程条目（四段式）
// ---------------------------------------------------------------------------

/**
 * 一件事，四段。
 *
 * 四段的名字和顺序和手动模式的提请卡一样 —— 同一件事在桌面上和投影上讲的是同一个故事，
 * 只是这里字大、一次一件。「影响哪条战略」那一段带编号，但**编号只上屏不口播**：
 * 「04-J2」念出来是四个没有意义的音节。
 */
export function ItemCard({ itemId, at, total }: { itemId: string; at: number; total: number }) {
  const item = agendaItem(itemId);
  if (!item) return <Missing what={`议程条目 ${itemId}`} />;

  return (
    <Frame eyebrow={total > 0 ? `第 ${at} 件 / 共 ${total} 件` : undefined}>
      <h2 className="text-stage-title font-medium tracking-[-0.01em] text-ink">{item.title}</h2>
      <div className="flex flex-col gap-7">
        <Part label="发生了什么">{item.fourParts.what}</Part>
        <Part label="为何现在重要">{item.fourParts.whyNow}</Part>
        <Part label="影响哪条战略">
          <span className="text-judgment">{item.fourParts.impacts}</span>
        </Part>
        <Part label="建议动作">{item.fourParts.suggestion}</Part>
      </div>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// ③ 证据
// ---------------------------------------------------------------------------

/**
 * 一句原话，和它出自哪儿。
 *
 * 引文用 serif（`.report`）—— 全站只有三个地方用 serif，它们的共同点是「这是原文，不是
 * 产品在说话」。这张卡是第四个，理由一样。
 *
 * 「打开全文」那一行是给他看的提示，不是按钮：会上他不会走到屏幕前面去点。真正打开全文
 * 是他说一句「打开全文」，模型调 `open_document`；或者秘书按一下热键。
 */
export function EvidenceCard({ evidenceId }: { evidenceId: string }) {
  const found = agendaEvidence(evidenceId);
  if (!found) return <Missing what={`证据 ${evidenceId}`} />;
  const { evidence, item } = found;

  return (
    <Frame eyebrow={item.title}>
      <blockquote className="border-l-4 border-judgment pl-7">
        <p className="report text-stage-lead text-ink">{evidence.quote}</p>
      </blockquote>
      <footer className="flex flex-col gap-2">
        <p className="meta-stage text-ink-muted">出处 · {evidence.source}</p>
        <p className="meta-stage text-ink-faint">{evidence.docId} · 可打开全文</p>
      </footer>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// ④ 探索卡
// ---------------------------------------------------------------------------

/**
 * 答不了的那件事。
 *
 * 这张卡是整个 demo 里最重要的一张 —— 它是「这套东西不糊弄我」的唯一证据。一个能回答
 * 一切的 Agent 在 CEO 面前是不可信的；一个当场说「这个我答不了，我记下来、派给谁、
 * 什么时候给您答案」的参谋才可信。
 *
 * 所以四个字段一个都不能藏：问题、责任人、期限、关联到哪条判断。责任人或期限空着的时候
 * 写「待定」照样打出来 —— 缺口该显出来，不该悄悄合上。
 */
export function ExplorationCardView({ card }: { card: ExplorationCard }) {
  const done = card.status === "committed";
  return (
    <Frame
      eyebrow="这个现在答不了"
      badge={<Badge text={EXPLORATION_LABEL[card.status]} done={done} />}
    >
      <h2 className="text-stage-lead font-medium text-ink">{card.text}</h2>
      <dl className="flex flex-col gap-6 border-t border-hairline pt-7">
        <Row label="建议责任人" value={card.suggestedDri} />
        <Row label="建议期限" value={card.deadline} />
        <Row
          label="关联节点"
          value={card.relatedIds.length ? card.relatedIds.join(" · ") : "待定"}
          code
        />
      </dl>
      <p className="meta-stage text-ink-faint">{card.id}</p>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// ⑤ 决策草案（七要素）
// ---------------------------------------------------------------------------

const SEVEN: { key: keyof DecisionDraft; label: string }[] = [
  { key: "choose", label: "选什么" },
  { key: "notChoose", label: "不选什么" },
  { key: "why", label: "为什么" },
  { key: "keyHypothesis", label: "关键假设" },
  { key: "riskAccepted", label: "接受的风险" },
  { key: "commitment", label: "承诺什么" },
  { key: "reopenTrigger", label: "什么条件下重开" },
];

/**
 * 七要素。
 *
 * 字段名和 `Closure` 一个字都不差 —— 会上确认下来的这张卡，将来是要原样写回成 Closure 的。
 * 七行全列，缺的那一行写着「（未填）」：一张缺了「什么条件下重开」的决策卡，正好证明这
 * 套机制是装的，所以缺口必须自己显出来。
 */
export function DecisionCard({ draft }: { draft: DecisionDraft }) {
  const done = draft.status === "confirmed";
  return (
    <Frame
      eyebrow={draft.judgmentId ? `将动到 ${draft.judgmentId}` : "决策草案"}
      badge={<Badge text={DECISION_LABEL[draft.status]} done={done} />}
    >
      <h2 className="text-stage-lead font-medium text-ink">{draft.title}</h2>
      <dl className="flex flex-col gap-5 border-t border-hairline pt-7">
        {SEVEN.map(({ key, label }) => {
          const value = String(draft[key] ?? "（未填）");
          const empty = value === "（未填）";
          return (
            <div key={key} className="flex items-baseline gap-6">
              <dt className="meta-stage w-[10ch] shrink-0 text-ink-faint">{label}</dt>
              <dd className={cn("text-stage flex-1", empty ? "text-counter" : "text-ink")}>
                {value}
              </dd>
            </div>
          );
        })}
      </dl>
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// ⑥ 收尾
// ---------------------------------------------------------------------------

/**
 * 今天办了什么。
 *
 * 三个数，都是从状态里当场算出来的，不是写死的文案 —— 会上如果他只让讲两件事就打断，
 * 这里必须显示 2，而不是 3。数字对不上是这一张卡唯一会犯的错，而它恰好是最后一张，
 * 是他离席时记住的那一张。
 */
export function SummaryCard({ state }: { state: StageState }) {
  const { presented, committed, decided } = summaryCounts(state);
  const rows = [
    { n: presented, unit: "件", tail: "已呈报" },
    { n: committed, unit: "个", tail: "问题已立项，有责任人和期限" },
    { n: decided, unit: "个", tail: "已拍板" },
  ];

  return (
    <Frame eyebrow={(state.agenda ?? AGENDA).sessionTitle}>
      <h2 className="text-stage-title font-medium tracking-[-0.01em] text-ink">今天办了什么</h2>
      <ul className="flex flex-col gap-7">
        {rows.map((r) => (
          <li key={r.tail} className="flex items-baseline gap-5">
            <span className="text-stage-title font-medium tabular-nums text-ink">{r.n}</span>
            <span className="text-stage text-ink-muted">
              {r.unit}
              {r.tail}
            </span>
          </li>
        ))}
      </ul>
      {state.explorations.length > 0 && (
        <ul className="flex flex-col gap-3 border-t border-hairline pt-7">
          {state.explorations.map((c) => (
            <li key={c.id} className="flex items-baseline gap-4">
              <span
                className={cn(
                  "meta-stage shrink-0",
                  c.status === "committed" ? "text-confirmed" : "text-ink-faint",
                )}
              >
                {EXPLORATION_LABEL[c.status]}
              </span>
              <span className="text-stage text-ink-muted">
                {c.text}
                <span className="meta-stage ml-3 text-ink-faint">
                  {c.suggestedDri} · {c.deadline}
                </span>
              </span>
            </li>
          ))}
        </ul>
      )}
    </Frame>
  );
}

// ---------------------------------------------------------------------------
// 零件
// ---------------------------------------------------------------------------

function Row({ label, value, code }: { label: string; value: string; code?: boolean }) {
  return (
    <div className="flex items-baseline gap-6">
      <dt className="meta-stage w-[10ch] shrink-0 text-ink-faint">{label}</dt>
      {/*
       * `code` 只换嗓音，不换字号。
       *
       * 原来写的是 `meta text-stage` —— `.meta` 自己带 11.5px，而它排在 utilities 层后面，
       * 结果一个编号在 28px 的字段中间缩成 11.5px。这里只取等宽和字距，字号留给上面那个
       * `text-stage`。
       */}
      <dd
        className={cn(
          "text-stage flex-1 text-ink",
          code && "font-mono tracking-[0.02em] tabular-nums",
        )}
      >
        {value}
      </dd>
    </div>
  );
}

/**
 * 该有的东西不在。
 *
 * 模型给了一个不存在的编号时会走到这里。**写出来是哪个编号找不到** —— 会上他和秘书都
 * 看得见这一行，秘书立刻知道该按哪个热键补上。空屏或者一句「出错了」帮不了任何人。
 */
export function Missing({ what }: { what: string }) {
  return (
    <Frame>
      <p className="text-stage text-ink-muted">{what}没找到。</p>
      <p className="meta-stage text-ink-faint">← 回上一张</p>
    </Frame>
  );
}
