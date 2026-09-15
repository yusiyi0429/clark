"use client";

/*
 * 独立于生产之外的一次性演示：只有一件事要证明——右栏（交互区）真的能开合、真的能
 * 对话。左中两栏因此只搭一个「三栏摆在一起看」的骨架（雷达/业务域/字标、议题清单），
 * 不接真数据、不可点,理由见 AGENTS 交给这一相的任务书。
 *
 * 右栏是 `dynamic-panel.tsx` 的装配抄本：壁纸 → feed(hero+卡片) → backdrop → sheets →
 * dock,DOM 顺序和那份文件一致(层叠顺序全靠 panel.module.css 的 z-index,不是靠这个
 * 顺序,但读代码的人会以为顺序不重要,所以照抄那份文件的做法)。sheet 的进退场机制
 * (`changeSheet`/`closing`/`entered`)也是原样搬过来的同一套状态机——那边的文件头
 * 把"为什么必须这样写"讲得很细,这里不重复,只搬结论。
 *
 * 三种 sheet 共用这一层:五张 ShowcaseItem 详情、一张会议详情、一张对话记录。同一时刻
 * 只开一层,这也是为什么会议卡(中栏)和 feed 卡(右栏)最终打开的是同一套 sheet 状态。
 */

import { useCallback, useEffect, useRef, useState } from "react";

import { PanelDock } from "@/components/panel/panel-dock";
import styles from "@/components/panel/panel.module.css";

import { KIND_ORDER, SHOWCASE_ITEMS, SHOWCASE_MEETING, type ShowcaseItem } from "./fixtures";
import { ShowcaseCard } from "./showcase-card";
import { ShowcaseMeetingCard, ShowcaseMeetingSheet } from "./showcase-meeting";
import { ShowcaseSheet } from "./showcase-sheet";

type Turn = { role: "user" | "agent"; text: string };
type Caption = { text: string; from: "user" | "agent" } | null;
type Closing = { id: string; mode: "recede" | "slideOut" };

const WEEKDAY_CN = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"] as const;
const MEETING_SHEET = "meeting";
const TRANSCRIPT_SHEET = "transcript";

function heroStatusText(now: Date, lookingAt: string | null): string {
  if (lookingAt) return `正在看 ${lookingAt}`;
  return `${WEEKDAY_CN[now.getDay()]} ${now.getMonth() + 1}月${now.getDate()}日`;
}

function heroClockText(now: Date): string {
  const hh = String(now.getHours()).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `${hh}:${mm}`;
}

// 不接 /api/chat——这一页不许花一分钱。dock 演的是交互的形状,不是真对话,
// 罐头回复如实说明这一点,不冒充模型。
const CANNED_REPLY = "这是 showcase，没有接真实模型——但对话开合的样子就是这样。";

export function ShowcaseView() {
  const [sheet, setSheet] = useState<string | null>(null);
  const [closing, setClosing] = useState<Closing | null>(null);
  const [entered, setEntered] = useState(false);
  const [now, setNow] = useState<Date>(() => new Date());
  const [turns, setTurns] = useState<Turn[]>([]);
  const [caption, setCaption] = useState<Caption>(null);
  const [busy, setBusy] = useState(false);

  const timeouts = useRef<Set<ReturnType<typeof setTimeout>>>(new Set());
  const schedule = useCallback((fn: () => void, ms: number) => {
    const id = setTimeout(() => {
      timeouts.current.delete(id);
      fn();
    }, ms);
    timeouts.current.add(id);
    return id;
  }, []);
  useEffect(
    () => () => {
      timeouts.current.forEach((id) => clearTimeout(id));
      timeouts.current.clear();
    },
    [],
  );

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const changeSheet = useCallback(
    (next: string | null) => {
      setSheet((current) => {
        if (current === next) return current;
        if (current !== null) {
          const closingId = current;
          const mode: Closing["mode"] = next === null ? "slideOut" : "recede";
          setClosing({ id: closingId, mode });
          schedule(() => {
            setClosing((c) => (c && c.id === closingId ? null : c));
          }, 420);
        }
        return next;
      });
    },
    [schedule],
  );

  // 先归零、下一帧再补 in——同一套理由抄自 dynamic-panel.tsx:这一步必须发生在渲染期间
  // 而不是 effect 里,否则第一帧就带着 in 出生,没有可过渡的起点。
  const [enteredFor, setEnteredFor] = useState<string | null>(null);
  if (sheet !== enteredFor) {
    setEnteredFor(sheet);
    setEntered(false);
  }

  useEffect(() => {
    if (sheet === null) return;
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => setEntered(true));
    });
    return () => {
      cancelAnimationFrame(raf1);
      if (raf2) cancelAnimationFrame(raf2);
    };
  }, [sheet]);

  const changeSheetRef = useRef(changeSheet);
  useEffect(() => {
    changeSheetRef.current = changeSheet;
  });
  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if (e.key === "Escape") changeSheetRef.current(null);
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  function handleSubmit(text: string) {
    setTurns((t) => [...t, { role: "user", text }]);
    setCaption({ text, from: "user" });
    setBusy(true);
    schedule(() => {
      setBusy(false);
      setTurns((t) => [...t, { role: "agent", text: CANNED_REPLY }]);
      setCaption({ text: CANNED_REPLY, from: "agent" });
    }, 900);
  }

  const activeItem: ShowcaseItem | null =
    sheet !== null && sheet !== MEETING_SHEET && sheet !== TRANSCRIPT_SHEET
      ? (SHOWCASE_ITEMS.find((i) => i.id === sheet) ?? null)
      : null;

  const hasSheet = sheet !== null;
  const lookingAt =
    sheet === TRANSCRIPT_SHEET
      ? "对话记录"
      : sheet === MEETING_SHEET
        ? SHOWCASE_MEETING.when
        : (activeItem?.title ?? null);

  function renderSheet(id: string, cls: string | undefined) {
    if (id === TRANSCRIPT_SHEET) {
      return (
        <div
          key={id}
          className={cls ? `${styles.sheet} ${cls}` : styles.sheet}
          role="dialog"
          aria-modal="false"
          aria-label="对话记录"
        >
          <div className={styles.shHead}>
            <span className={styles.shChip}>对话</span>
            <span className={styles.shSp} />
            <button type="button" className={styles.shBtn} aria-label="关闭" onClick={() => changeSheet(null)}>
              <span aria-hidden="true">×</span>
            </button>
          </div>
          <div className={styles.shBody}>
            <div className={styles.shTitle}>对话记录</div>
            {turns.length === 0 ? (
              <p className={styles.shP}>还没有对话。点底部那颗键开始。</p>
            ) : (
              <div className={styles.tr}>
                {turns.map((turn, i) => (
                  <div key={i} className={`${styles.m} ${turn.role === "user" ? styles.user : styles.agent}`}>
                    <small>{turn.role === "user" ? "你" : "它"}</small>
                    {turn.text}
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      );
    }
    if (id === MEETING_SHEET) {
      return (
        <ShowcaseMeetingSheet key={id} meeting={SHOWCASE_MEETING} onClose={() => changeSheet(null)} className={cls} />
      );
    }
    const item = SHOWCASE_ITEMS.find((i) => i.id === id);
    if (!item) return null;
    return <ShowcaseSheet key={id} item={item} onClose={() => changeSheet(null)} className={cls} />;
  }

  // 五档,每档恰好一条,直接按 KIND_ORDER 的名次排——没有分组标签,名次和卡片自己的
  // 深浅底色一起说清楚"越靠前越是他的事"(见 showcase-card.tsx 的 densityStyle)。
  const feed = [...SHOWCASE_ITEMS].sort(
    (a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind),
  );

  return (
    <div className="mx-auto flex h-screen max-w-[1600px] gap-7 px-5 py-4">
      <LeftColumn />
      <section className="grid min-w-0 flex-1 grid-cols-2 gap-7">
        <MiddleColumn onOpenMeeting={() => changeSheet(MEETING_SHEET)} />

        <section className={hasSheet ? `${styles.panel} ${styles.hasSheet}` : styles.panel}>
          <div className={styles.wp} aria-hidden="true">
            <i className={styles.b1} />
            <i className={styles.b2} />
            <i className={styles.b3} />
            <i className={styles.b4} />
          </div>

          <div className={styles.feed}>
            <div className={styles.hero}>
              <div className={styles.heroStatus}>{heroStatusText(now, lookingAt)}</div>
              <div className={styles.heroClock}>{heroClockText(now)}</div>
            </div>
            {/* .layers 在 panel.module.css 里是 block，卡片按内容各自缩宽；
                这里补成 flex column 让子项等宽，不改共享样式表。 */}
            <div className={styles.layers} style={{ display: "flex", flexDirection: "column" }}>
              {feed.map((item) => (
                <ShowcaseCard
                  key={item.id}
                  item={item}
                  priority={KIND_ORDER.indexOf(item.kind)}
                  onOpen={changeSheet}
                />
              ))}
            </div>
          </div>

          <div className={styles.backdrop} aria-hidden="true" onClick={() => changeSheet(null)} />

          <div className={styles.sheets}>
            {closing ? renderSheet(closing.id, closing.mode === "recede" ? styles.recede : undefined) : null}
            {sheet !== null ? renderSheet(sheet, entered ? styles.in : undefined) : null}
          </div>

          <PanelDock
            caption={caption}
            busy={busy}
            onSubmit={handleSubmit}
            onOpenTranscript={() => changeSheet(TRANSCRIPT_SHEET)}
          />
        </section>
      </section>
    </div>
  );
}

/** 左栏站位:雷达 + 业务域 + 字标,静态文字,不接数据、不可点——这一相只演右栏。 */
function LeftColumn() {
  const domains = ["方向与经营选择", "产品与技术", "组织与人", "TokenOps"];
  return (
    <aside className="flex w-[19.5rem] flex-none flex-col gap-4">
      <div className="rounded-2xl border border-hairline bg-surface px-4 py-3">
        <p className="meta text-ink-muted">雷达</p>
        <p className="meta mt-2 text-ink-faint">正在盯 3 个靶点</p>
      </div>
      <div className="rounded-2xl border border-hairline bg-surface px-4 py-3">
        <p className="meta text-ink-muted">业务域</p>
        <ul className="mt-2 space-y-1.5">
          {domains.map((d) => (
            <li key={d} className="meta truncate text-ink-faint">
              {d}
            </li>
          ))}
        </ul>
      </div>
      <div className="mt-auto pt-2">
        <span className="font-wordmark text-[19px] tracking-[0.055em] text-ink-muted">天枢</span>
      </div>
    </aside>
  );
}

/** 中栏站位:几条静态议题 + 真正能点开的会议卡(它的 sheet 落在右栏)。 */
function MiddleColumn({ onOpenMeeting }: { onOpenMeeting: () => void }) {
  const issues = [
    "Q4 定价与折扣权限收口",
    "华东仓的自动补货规则要不要放开",
    "新客户尽调标准要不要提级",
  ];
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="meta text-ink-faint">议题</p>
      <ul className="space-y-2">
        {issues.map((title) => (
          <li key={title} className="list-block concentric px-3.5 py-3 text-md text-ink-muted">
            {title}
          </li>
        ))}
      </ul>
      <div className="mt-2">
        <ShowcaseMeetingCard meeting={SHOWCASE_MEETING} onOpen={onOpenMeeting} />
      </div>
    </div>
  );
}
