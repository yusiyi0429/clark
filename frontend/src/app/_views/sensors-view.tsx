"use client";

import { Mic, Square } from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { AsyncBoundary } from "@/components/async-boundary";
import { Panel, PanelHead } from "@/components/panel";
import { api } from "@/lib/data/client";
import { formatStamp } from "@/lib/format";
import { Listener, type ListenerState } from "@/lib/stage/listener";
import type { MonitorStrategy } from "@/lib/data/types";
import { useResource } from "@/lib/use-resource";
import { cn } from "@/lib/utils";

/**
 * 监控策略。**「你凭什么替我筛」的完整答案，以及他当面改它的地方。**
 *
 * 待定事项那一屏上的那一行（`digest-view.tsx` 的 `MonitorRow`）只摊了域名和条数 ——
 * 那一屏他给五分钟。这一页是他真想弄清楚的时候来的，所以这里一条不省：战略假设、
 * 每个域下面的 KIQ 原文、能算的口径、布控着的触发条件，最后是策略正文原文。
 *
 * ## 原文必须在
 *
 * 上面那几段是从策略正文里认出来的（`scan/strategy.ts`），而认是会认漏的 ——
 * 正文的格式一改，漏掉的那部分在屏幕上就是空的。所以正文原文照登在最后一节：
 * 上面那几段是方便，正文才是凭据。一号位质疑「你就盯这么点东西？」的时候，
 * 能被指着看的是正文。
 *
 * ## 他能改的是哪一层
 *
 * **一句交代，落在下一轮扫描的 `inputs[0].q` 上**（为什么是这一层、它能改什么改不了
 * 什么，写在 `MonitorFocus` 上）。观察域、KIQ、阈值、时窗这些在靶点策略里
 * （`scan/strategy-body.ts`），改它是改产品：签在 git 里、要过一次评审 —— 这一页
 * 不摆一个能当场改掉扫描口径的输入框。
 *
 * 打字和说话进的是**同一个框**：说的话填进框里，按下「交代下去」的仍然是他自己。
 * 这样识别错字他改得掉，屏幕上也不需要给一句他已经确认过的话打「可能听错」的标。
 */
export function SensorsView() {
  const resource = useResource<MonitorStrategy>("monitor-strategy", () =>
    api.getMonitorStrategy()
  );

  return (
    <Panel>
      <PanelHead
        eyebrow="监控策略"
        title="雷达按这一份替您筛"
      />
      <AsyncBoundary resource={resource} skeleton={<SensorsSkeleton />}>
        {(strategy) => (
          <div className="space-y-8">
            <FocusBox
              strategy={strategy}
              onSaved={(next) => void resource.mutate(next, { revalidate: false })}
            />
            <Strategy strategy={strategy} />
          </div>
        )}
      </AsyncBoundary>
    </Panel>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * 「这一轮多盯着点什么」—— 他当面交代的那一句。
 *
 * 这句话的**权限边界**：只改下一轮的取向，不动时窗和阈值 —— 那两样在靶点策略里，
 * 改它们要改代码。
 */
function FocusBox({
  strategy,
  onSaved,
}: {
  strategy: MonitorStrategy;
  onSaved: (next: MonitorStrategy) => void;
}) {
  const saved = strategy.focus?.text ?? "";
  const [text, setText] = useState(saved);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  /* --- 麦克风那一头 --- */
  const listener = useRef<Listener | null>(null);
  const [mic, setMic] = useState<ListenerState>("off");
  /** 正在说、还没说完的那半句。只做字幕，不进框 —— 进框会让框里的字一直在变。 */
  const [heard, setHeard] = useState("");
  const [micNote, setMicNote] = useState<string | null>(null);

  // 离开这一页就把麦克风拆干净。灯还亮着的标签页很难解释。
  useEffect(() => () => listener.current?.stop(), []);

  const ear = (): Listener => {
    if (!listener.current) {
      listener.current = new Listener(
        {
          onHeard: (t, final) => setHeard(final ? "" : t),
          // 说完一句才进框。他还能改，所以这里不做任何清洗。
          onCommit: (t) => {
            setHeard("");
            setText((prev) => joinSaid(prev, t));
          },
          onState: setMic,
          onError: setMicNote,
        },
        /*
         * 自己一个会话名。语音中转是按会话名开的（`lib/asr/relay.ts`），跟会议台
         * 那条（`demo`）共用一个名字的话，会上正开着麦、他在这一页又按一下，
         * 两处的音频会进同一条厂商连接。
         */
        "monitor"
      );
    }
    return listener.current;
  };

  const submit = async (next: string) => {
    setBusy(true);
    setErr(null);
    try {
      // H2 —— 服务端说了算：整份策略重新回来一次，这一页跟着它重画。
      onSaved(await api.setMonitorFocus(next));
      setText(next);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "没存上。");
    } finally {
      setBusy(false);
    }
  };

  const dirty = text.trim() !== saved;

  return (
    <section className="rounded-lg bg-neutral-wash px-4 py-4 [box-shadow:inset_0_0_0_var(--hairline-w)_var(--hairline)]">
      <h2 className="text-md font-medium text-ink">这一轮，多盯着点什么</h2>
      <p className="meta mt-1.5 max-w-prose text-ink-faint">一句话就够。</p>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={2}
        placeholder="比如：这周多盯一下国产算力的政策口径"
        className="mt-3 w-full resize-none rounded-md bg-paper px-3 py-2 text-base text-ink [box-shadow:inset_0_0_0_var(--hairline-w)_var(--hairline)] placeholder:text-ink-faint focus:outline-none focus-visible:[box-shadow:inset_0_0_0_1px_var(--ink-muted)]"
      />

      {/* 正在说的那半句。它在框外面 —— 框里是他确认过的字，这一行是还没定的声音。 */}
      {heard ? <p className="meta mt-1.5 text-ink-faint">听到：{heard}</p> : null}

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          disabled={busy || !dirty}
          onClick={() => void submit(text)}
          className="inline-flex h-9 items-center rounded-lg bg-solid px-3.5 text-sm font-medium text-solid-fg transition-opacity duration-fast ease-swift hover:opacity-90 disabled:opacity-40"
        >
          {busy ? "正在交代…" : "交代下去"}
        </button>

        {/*
         * 说给它听。必须挂在一次真实点击上 —— 浏览器不给非手势的 `getUserMedia`
         * （`Listener.start` 上那段）。这条路今天不通的时候，报错落在 `micNote`
         * 那一行，框照旧能打字。
         */}
        <button
          type="button"
          onClick={() => {
            setMicNote(null);
            void ear().toggle();
          }}
          className={cn(
            "inline-flex h-9 items-center gap-1.5 rounded-lg px-3 text-sm transition-colors duration-fast",
            mic === "listening" || mic === "muted"
              ? "bg-confirmed text-surface"
              : "text-ink-muted [box-shadow:inset_0_0_0_var(--hairline-w)_var(--hairline)] hover:text-ink"
          )}
        >
          {mic === "listening" || mic === "muted" ? (
            <>
              <Square className="size-3" aria-hidden />
              说完了
            </>
          ) : (
            <>
              <Mic className="size-3.5" aria-hidden />
              {mic === "starting" ? "正在开麦…" : "说给它听"}
            </>
          )}
        </button>

        {saved ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setText("");
              void submit("");
            }}
            className="meta rounded-[3px] text-ink-faint transition-colors duration-fast hover:text-ink-muted disabled:opacity-40"
          >
            撤掉这句交代
          </button>
        ) : null}

        {strategy.focus && !dirty ? (
          <span className="meta text-ink-faint">
            已交代 · {formatStamp(strategy.focus.at)} 起的每一轮都带着它
          </span>
        ) : null}
      </div>

      {micNote ? <p className="meta mt-2 max-w-prose text-ink-muted">{micNote}</p> : null}
      {err ? <p className="meta mt-2 max-w-prose text-ink-muted">{err}</p> : null}
    </section>
  );
}

/**
 * 说的那句话接进框里。
 *
 * 中文接中文不补空格，别的补一个 —— 一句一句念下来，`国产算力` 接 `的政策口径`
 * 中间多一个空格是错的，`Gartner` 接 `DIP` 中间不留空格也是错的。
 */
function joinSaid(left: string, right: string): string {
  if (!left) return right;
  const cjk = (c: string) => /[^ -ÿ]/.test(c);
  return cjk(left.slice(-1)) && cjk(right.slice(0, 1)) ? left + right : `${left} ${right}`;
}

/* -------------------------------------------------------------------------- */

function Strategy({ strategy: s }: { strategy: MonitorStrategy }) {
  const nothing =
    s.domains.length === 0 &&
    s.hypotheses.length === 0 &&
    s.limits.length === 0 &&
    s.triggers.length === 0;

  return (
    <div className="space-y-8">
      {s.hypotheses.length > 0 ? (
        <Section
          title="研判的靶心"
          note="当前在版的战略假设。"
        >
          <Bullets items={s.hypotheses} />
        </Section>
      ) : null}

      {s.domains.length > 0 ? (
        <Section title="盯的是这几个域" note="每个域下面挂着它要回答的情报问题（KIQ），照策略原文列。">
          <div className="space-y-5">
            {s.domains.map((d) => (
              <div key={d.code}>
                <h4 className="text-base font-medium text-ink">
                  {d.code} {d.title}
                </h4>
                {d.kiqs.length > 0 ? (
                  <Bullets items={d.kiqs} className="mt-1.5" />
                ) : (
                  /* 认出了域名但一条 KIQ 都没认出来 —— 说明正文的格式和解析器对不上了。
                     照实说，别让这个域看起来像是「就这么一句」。 */
                  <p className="meta mt-1.5 text-ink-faint">
                    这个域下面的情报问题没认出来。
                  </p>
                )}
              </div>
            ))}
          </div>
        </Section>
      ) : null}

      {s.limits.length > 0 ? (
        <Section title="什么才端到您面前" note="这几条是靶点策略里的口径，扫描每一轮都按它筛。">
          <Bullets items={s.limits} />
        </Section>
      ) : null}

      {s.triggers.length > 0 ? (
        <Section title="这几条一动，那件事就重开" note="历次会后确认布控下来的 Re-open Trigger。">
          <ul className="space-y-2">
            {s.triggers.map((t) => (
              <li key={t.id} className="flex items-baseline gap-2">
                <Link
                  href={t.href}
                  className="meta shrink-0 rounded-[3px] bg-solid px-1.5 py-[1px] font-medium text-solid-fg transition-opacity duration-fast hover:opacity-85"
                >
                  {t.judgmentId}
                </Link>
                <span className="text-base text-ink-muted">{t.text}</span>
              </li>
            ))}
          </ul>
        </Section>
      ) : null}

      {/*
       * 正文原文。**一个字不改写**（见这个文件开头那段）。
       *
       * `whitespace-pre-wrap` 不是偷懒：那是给模型读的 markdown，缩进和分行本身就是
       * 它的结构。渲染成 HTML 等于用另一种排版复述它，而这一节存在的理由正是
       * 「他看到的和模型读到的是同一份东西」。
       */}
      {s.body ? (
        <Section title="策略正文" note={`${s.origin}${s.readAt ? ` · ${formatStamp(s.readAt)} 读到` : ""}`}>
          <pre className="max-h-[32rem] overflow-auto rounded-md bg-neutral-wash px-3 py-2.5 font-sans text-sm whitespace-pre-wrap text-ink-muted">
            {s.body}
          </pre>
        </Section>
      ) : null}

      {nothing && !s.unavailable ? (
        <p className="text-sm text-ink-muted">这台机器上现在读不出任何监控口径。</p>
      ) : null}
    </div>
  );
}

function Section({
  title,
  note,
  children,
}: {
  title: string;
  note?: string;
  children: React.ReactNode;
}) {
  return (
    <section>
      <h3 className="text-md font-medium text-ink">{title}</h3>
      {note ? <p className="meta mt-1 max-w-prose text-ink-faint">{note}</p> : null}
      <div className="mt-3">{children}</div>
    </section>
  );
}

/** 一列点。圆点自己写，理由同 `digest-view.tsx` 的 `MonitorBullet`。 */
function Bullets({ items, className }: { items: string[]; className?: string }) {
  return (
    <ul className={cn("space-y-1.5", className)}>
      {items.map((t) => (
        <li key={t} className="flex gap-2 text-base text-ink-muted">
          <span aria-hidden className="mt-[0.5em] size-1 flex-none rounded-full bg-ink-faint" />
          <span className="min-w-0">{t}</span>
        </li>
      ))}
    </ul>
  );
}

function SensorsSkeleton() {
  return (
    <div aria-live="polite" className="space-y-6">
      <span className="skeleton block h-24 w-full rounded-lg" />
      {[0, 1].map((i) => (
        <div key={i}>
          <span className="skeleton block h-4 w-32" />
          <span className="skeleton mt-3 block h-3 w-full" />
          <span className="skeleton mt-1.5 block h-3 w-[78%]" />
        </div>
      ))}
    </div>
  );
}
