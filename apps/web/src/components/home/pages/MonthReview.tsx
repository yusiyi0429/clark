"use client";

/**
 * 复盘页（设计《复盘进新首页_设计第三版》第 3 节）：月份页在复盘期间就是复盘页，文档类页面。
 * - 每个 Mission 一块，只放本期验收的 Task：标题行 Mission 名、右边总评和「4/5 · 延期 1」；下面三列 验收标准 | 评定 | 交付，按 Task 分组，Task 名那一行右边是去向下拉。
 *   块右下角「确认」（只有 Mission 负责人有）；确认后收成一行「Mission 名、总评、已确认 11/29」，点开还能改，改了要重新确认（服务端清掉）。
 * - 评定：一条一个下拉（达到 / 部分达到 / 未达到），本人改过的下面淡色写「预评 X」；备注框平时可以不填，选的和预评不同时必填，填了才存。
 * - 交付：一排链接，悬停出「×」；「+ 添加」弹层上面是天枢里已有的交付物和子会话产出，下面粘贴链接回车。
 * - 最下面「延期和取消」：一件一行，Task 名、淡色 Mission 名、去向下拉；不评定、不挂交付、没有确认。
 * - 改不了的（canChange false）只看：下拉、备注框、「×」「+ 添加」都不画。
 * - 手持：评定挪到标准文字右边，交付另起一行。
 * 没成的写「失败 · 重试」（原因在 title 里），不弹 toast。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Dropdown } from "@heroui/react";
import { Button, Dialog, DialogTrigger, Popover } from "react-aria-components";
import { TianshuPortalTheme } from "ts-design";
import { ChevronDown, ChevronRight, Plus, X } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import { FailedLine } from "@/components/work/DecisionBox";
import { ICON } from "./parts";
import {
  RATINGS, RATING_LABEL, VERDICT_LABEL, countText, dayText, dispositionKey, dispositionOptions, dispositionText, effectiveRating, needsNote,
  type LinkCandidate, type MonthReview, type ReviewActions, type ReviewCriterion, type ReviewMission, type ReviewRating, type ReviewTask,
} from "./useMonthReview";
import h from "@/styles/home.module.css";
import p from "@/styles/home-pages.module.css";

type Failure = { reason: string; retry: () => void };
/** 跑一个写操作：没成记下原因和重试。 */
function useAttempt() {
  const [failed, setFailed] = useState<Failure | null>(null);
  const [busy, setBusy] = useState(false);
  const attempt = (run: () => Promise<unknown>) => {
    const once = () => {
      setFailed(null);
      setBusy(true);
      void run().catch((error: unknown) => setFailed({ reason: error instanceof Error ? error.message : "", retry: once })).finally(() => setBusy(false));
    };
    once();
  };
  return { failed, busy, attempt };
}
const Failed = ({ failed }: { failed: Failure | null }) => (failed ? <FailedLine inline reason={failed.reason} onRetry={failed.retry} /> : null);

export function MonthReviewView({ review, actions }: { review: MonthReview; actions: ReviewActions }) {
  return (
    <>
      {review.missions.map((mission) => <MissionBlock key={mission.missionId} mission={mission} period={review.period} actions={actions} />)}
      {review.setAside.length ? (
        <section className={p.section} aria-label="延期和取消" data-testid="review-set-aside">
          <h2 className={p.sectionTitle}>延期和取消</h2>
          <ul className={p.rows}>
            {review.setAside.map((task) => (
              <li key={task.taskId} className={p.reviewAside} data-testid="review-aside-row">
                <span className={p.rowText}>
                  <span className={p.rowName}><span>{task.name}</span></span>
                  <span className={p.rowSub}>{task.missionTitle}</span>
                </span>
                <DispositionPick task={task} period={review.period} actions={actions} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </>
  );
}

function VerdictChip({ mission }: { mission: Pick<ReviewMission, "verdict"> }) {
  return mission.verdict ? <span className={h.statusChip} data-static="" data-tone={mission.verdict === "not_achieved" ? "danger" : undefined}>{VERDICT_LABEL[mission.verdict]}</span> : null;
}

function MissionBlock({ mission, period, actions }: { mission: ReviewMission; period: string; actions: ReviewActions }) {
  // 确认过的默认收成一行；本人点开了就照本人的。
  const [open, setOpen] = useState(false);
  const confirm = useAttempt();
  const count = countText(mission);
  if (mission.confirmedAt && !open) {
    return (
      <section className={p.section} aria-label={mission.title} data-testid="review-mission" data-confirmed="">
        <button type="button" className={p.reviewFolded} aria-expanded={false} onClick={() => setOpen(true)}>
          <ChevronRight {...ICON} aria-hidden />
          <span className={p.reviewMissionName}>{mission.title}</span>
          <VerdictChip mission={mission} />
          <span className={p.reviewMeta}>已确认 {dayText(mission.confirmedAt)}</span>
        </button>
      </section>
    );
  }
  return (
    <section className={p.section} aria-label={mission.title} data-testid="review-mission">
      <div className={p.reviewMissionHead}>
        {mission.confirmedAt ? (
          <button type="button" className={p.reviewFold} aria-expanded onClick={() => setOpen(false)} aria-label="收起"><ChevronDown {...ICON} aria-hidden /></button>
        ) : null}
        <h2 className={p.reviewMissionName}>{mission.title}</h2>
        <VerdictChip mission={mission} />
        {count ? <span className={`${p.reviewMeta} ${h.num}`}>{count}</span> : null}
      </div>
      <div className={p.reviewTable} role="table" aria-label={`${mission.title}的验收标准`}>
        <div className={p.reviewColumns} role="row">
          <span role="columnheader">验收标准</span><span role="columnheader">评定</span><span role="columnheader">交付</span>
        </div>
        {mission.tasks.map((task) => (
          <div key={task.taskId} role="rowgroup" className={p.reviewTask} data-testid="review-task">
            <div className={p.reviewTaskHead} role="row">
              <span className={p.reviewTaskName} role="rowheader">{task.name}</span>
              <DispositionPick task={task} period={period} actions={actions} />
            </div>
            {task.criteria.map((criterion) => <CriterionRow key={criterion.index} task={task} criterion={criterion} actions={actions} />)}
          </div>
        ))}
      </div>
      {mission.canConfirm || mission.confirmedAt ? (
        <div className={p.reviewFoot}>
          <Failed failed={confirm.failed} />
          {mission.confirmedAt ? <span className={p.reviewMeta}>已确认 {dayText(mission.confirmedAt)}</span>
            : <HeroButton variant="secondary" size="sm" isDisabled={confirm.busy || mission.verdict === null} onPress={() => confirm.attempt(() => actions.confirm(mission.missionId))} data-testid="review-confirm">确认</HeroButton>}
        </div>
      ) : null}
    </section>
  );
}

/** 去向下拉：本期验收 / 延期到某月 / 已取消；改不了的只写字。 */
function DispositionPick({ task, period, actions }: { task: ReviewTask; period: string; actions: ReviewActions }) {
  const { failed, busy, attempt } = useAttempt();
  const options = dispositionOptions(period);
  const current = dispositionKey(task);
  if (!task.canChange) return <span className={p.reviewMeta}>{dispositionText(task)}</span>;
  return (
    <span className={p.action}>
      <Failed failed={failed} />
      <Dropdown>
        <Dropdown.Trigger className={p.pick} isDisabled={busy} aria-label={`${task.name}的去向`} data-testid="review-disposition">{dispositionText(task)}<ChevronDown size={14} strokeWidth={1.8} aria-hidden /></Dropdown.Trigger>
        <Dropdown.Popover placement="bottom end" offset={8} className={h.pop}>
          <Dropdown.Menu aria-label="去向" className={h.menuList} onAction={(key) => {
            const picked = options.find((option) => option.key === key);
            if (picked && picked.key !== current) attempt(() => actions.setDisposition(task.taskId, picked.body));
          }}>
            {options.map((option) => (
              <Dropdown.Item key={option.key} id={option.key} textValue={option.label} className={h.menuItem} data-current={option.key === current ? "" : undefined}>{option.label}</Dropdown.Item>
            ))}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
    </span>
  );
}

/**
 * 一条标准：文字（下面淡色的预评依据、备注框）| 评定 | 交付。
 * 选了和预评不同的一档：先不存，备注框标成必填、拿到焦点，写了（回车或离开）连同评定一起存；选回预评那一档直接存。
 */
function CriterionRow({ task, criterion, actions }: { task: ReviewTask; criterion: ReviewCriterion; actions: ReviewActions }) {
  const [pending, setPending] = useState<ReviewRating | null>(null);
  const [note, setNote] = useState(criterion.note ?? "");
  const noteRef = useRef<HTMLInputElement>(null);
  const { failed, busy, attempt } = useAttempt();
  useEffect(() => { setNote(criterion.note ?? ""); }, [criterion.note]);
  const shown = pending ?? effectiveRating(criterion);
  const required = shown !== null && needsNote(criterion, shown);
  const save = (rating: ReviewRating, text: string) => attempt(async () => { await actions.rate(task.taskId, criterion.index, { rating, note: text.trim() || null }); setPending(null); });
  const pick = (rating: ReviewRating) => {
    if (rating === shown && !pending) return;
    if (needsNote(criterion, rating) && !note.trim()) { setPending(rating); window.requestAnimationFrame(() => noteRef.current?.focus()); return; }
    save(rating, note);
  };
  const commitNote = () => {
    if (!shown || (note.trim() === (criterion.note ?? "") && !pending)) return;
    if (required && !note.trim()) return;
    save(shown, note);
  };
  return (
    <div className={p.reviewRow} role="row" data-testid="review-criterion">
      <div className={p.reviewText} role="cell">
        <span>{criterion.text}</span>
        {criterion.agentBasis ? <small className={p.reviewBasis}>{criterion.agentBasis}</small> : null}
        {task.canChange ? (
          <input ref={noteRef} className={p.reviewNote} value={note} maxLength={1000} placeholder={required ? "备注 · 必填" : "备注"} aria-label={`${task.name} 第 ${criterion.index} 条的备注`}
            aria-invalid={required && pending && !note.trim() ? true : undefined} data-required={required ? "" : undefined}
            onChange={(event) => setNote(event.target.value)} onBlur={commitNote}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commitNote(); } if (event.key === "Escape" && pending) { setPending(null); setNote(criterion.note ?? ""); } }} data-testid="review-note" />
        ) : criterion.note ? <small className={p.reviewBasis}>{criterion.note}</small> : null}
      </div>
      <div className={p.reviewRating} role="cell">
        <RatingPick label={`${task.name} 第 ${criterion.index} 条的评定`} criterion={criterion} shown={shown} canChange={task.canChange} busy={busy} onPick={pick} />
        <Failed failed={failed} />
      </div>
      <div className={p.reviewLinks} role="cell">
        <LinksCell task={task} criterion={criterion} actions={actions} />
      </div>
    </div>
  );
}

function RatingPick({ label, criterion, shown, canChange, busy, onPick }: { label: string; criterion: ReviewCriterion; shown: ReviewRating | null; canChange: boolean; busy: boolean; onPick: (rating: ReviewRating) => void }) {
  const word = shown ? RATING_LABEL[shown] : "未评";
  // 本人改过（或正要改）：下面淡色写预评是什么。
  const changed = shown !== null && criterion.agentRating !== null && shown !== criterion.agentRating;
  const before = changed ? <small className={p.reviewBasis}>预评 {RATING_LABEL[criterion.agentRating!]}</small> : null;
  if (!canChange) return <><span className={p.reviewRatingWord} data-rating={shown ?? undefined}>{word}</span>{before}</>;
  return (
    <>
      <Dropdown>
        <Dropdown.Trigger className={p.pick} isDisabled={busy} aria-label={label} data-rating={shown ?? undefined} data-testid="review-rating">{word}<ChevronDown size={14} strokeWidth={1.8} aria-hidden /></Dropdown.Trigger>
        <Dropdown.Popover placement="bottom start" offset={8} className={h.pop}>
          <Dropdown.Menu aria-label="评定" className={h.menuList} onAction={(key) => onPick(key as ReviewRating)}>
            {RATINGS.map((rating) => (
              <Dropdown.Item key={rating} id={rating} textValue={RATING_LABEL[rating]} className={h.menuItem} data-current={rating === shown ? "" : undefined}>
                {RATING_LABEL[rating]}{rating === criterion.agentRating ? <span className={h.grow} /> : null}{rating === criterion.agentRating ? <span className={p.reviewMeta}>预评</span> : null}
              </Dropdown.Item>
            ))}
          </Dropdown.Menu>
        </Dropdown.Popover>
      </Dropdown>
      {before}
    </>
  );
}

/** 交付一格：一排链接（悬停出「×」）和「+ 添加」。 */
function LinksCell({ task, criterion, actions }: { task: ReviewTask; criterion: ReviewCriterion; actions: ReviewActions }) {
  const { failed, attempt } = useAttempt();
  return (
    <>
      {criterion.links.map((link) => (
        <span key={link.id} className={p.reviewLink} data-testid="review-link">
          <a href={link.url} target="_blank" rel="noopener noreferrer" title={link.url}>{link.title}</a>
          {task.canChange ? <button type="button" className={p.reviewUnlink} aria-label={`删掉 ${link.title}`} title="删掉" onClick={() => attempt(() => actions.removeLink(link.id))}><X size={14} strokeWidth={1.8} aria-hidden /></button> : null}
        </span>
      ))}
      <Failed failed={failed} />
      {task.canChange ? <AddLink task={task} criterion={criterion} actions={actions} /> : criterion.links.length ? null : <span className={p.reviewMeta}>—</span>}
    </>
  );
}

/** 「+ 添加」弹层：上面是这件 Task 在天枢里已有的交付物和子会话产出（点一下挂上），下面粘贴链接回车挂上。 */
function AddLink({ task, criterion, actions }: { task: ReviewTask; criterion: ReviewCriterion; actions: ReviewActions }) {
  const [open, setOpen] = useState(false);
  const [candidates, setCandidates] = useState<LinkCandidate[] | null>(null);
  const [loadFailed, setLoadFailed] = useState<Failure | null>(null);
  const [url, setUrl] = useState("");
  const { failed, busy, attempt } = useAttempt();
  const load = () => {
    setLoadFailed(null);
    void actions.candidates(task.taskId).then(setCandidates, (error: unknown) => setLoadFailed({ reason: error instanceof Error ? error.message : "", retry: load }));
  };
  const change = (next: boolean) => {
    setOpen(next);
    if (next) { setUrl(""); load(); }
  };
  const add = (body: Parameters<ReviewActions["addLink"]>[2]) => attempt(async () => { await actions.addLink(task.taskId, criterion.index, body); setOpen(false); });
  const attached = new Set(criterion.links.map((link) => link.url));
  const fresh = candidates?.filter((candidate) => !attached.has(candidate.url)) ?? null;
  return (
    <DialogTrigger isOpen={open} onOpenChange={change}>
      <Button className={p.reviewAdd} aria-label={`给${task.name} 第 ${criterion.index} 条添加交付`} data-testid="review-add-link"><Plus size={14} strokeWidth={1.8} aria-hidden />添加</Button>
      <Popover className={h.pop} placement="bottom start" offset={8}>
        <TianshuPortalTheme>
          <Dialog className={p.reviewAddDialog} aria-label="添加交付">
            {fresh === null && !loadFailed ? <div className={p.reviewAddList} aria-busy /> : null}
            {loadFailed ? <Failed failed={loadFailed} /> : null}
            {fresh?.length ? (
              <ul className={p.reviewAddList}>
                {fresh.map((candidate) => (
                  <li key={candidate.id}>
                    <button type="button" className={h.menuItem} disabled={busy} onClick={() => add({ candidate: { kind: candidate.kind, id: candidate.id } })} title={candidate.url} data-testid="review-candidate">
                      <span className={h.ellipsis}>{candidate.title}</span><span className={h.grow} /><span className={p.reviewMeta}>{candidate.kind === "deliverable" ? "交付物" : "产出"}</span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <form className={p.reviewAddForm} onSubmit={(event) => { event.preventDefault(); if (url.trim()) add({ url: url.trim() }); }}>
              <input autoFocus className={p.reviewUrl} value={url} maxLength={2000} placeholder="粘贴链接" aria-label="粘贴链接" onChange={(event) => setUrl(event.target.value)} data-testid="review-url" />
            </form>
            <Failed failed={failed} />
          </Dialog>
        </TianshuPortalTheme>
      </Popover>
    </DialogTrigger>
  );
}

/** 页头右边：淡色小字和「与伙伴讨论」。 */
export function ReviewHeadTrail({ text, onDiscuss }: { text: string; onDiscuss: () => void }): ReactNode {
  return (
    <span className={p.reviewHeadTrail} data-testid="review-head">
      <span className={p.reviewMeta}>{text}</span>
      <HeroButton variant="tertiary" size="sm" onPress={onDiscuss}>与伙伴讨论</HeroButton>
    </span>
  );
}
