"use client";

/**
 * 管理员视图（已定设计第 10 节）：顶部一排计数（Vercel / Railway 状态页式的色块，点一下筛下面的列表）、
 * 人 × 来源（Datadog / Grafana 式的状态格，点一行展开明细和操作）、失败列表与质量信号（Sentry 式：接手、解决、重试）。
 * 每 30 秒轮询一次；回到页面时立刻再取。只显示运行数据，不显示对话正文。
 */
import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import { Button, ToggleButton, ToggleButtonGroup } from "ts-design/primitives";
import { Bell, Check, ChevronDown, Database, KeyRound, Laptop, RefreshCw, RotateCcw, type LucideIcon } from "lucide-react";
import type {
  TAdminActionRequest, TAdminCounterKey, TAdminIssue, TAdminMark, TAdminOverviewResponse, TAdminPersonRow, TAdminQualitySignal, TAdminStatus, TAdminSubject,
} from "@warmap/contracts";
import { MenuDialog } from "@/components/AccountMenu";
import { DetailFrame } from "@/components/shell/DetailFrame";
import { useRegisterDetail, useWorkspace } from "@/components/shell/WorkspaceContext";
import { browserApi, type Card } from "@/lib/api/client";
import { monthDayTime } from "@/lib/companyTime";
import { UsagePanel } from "./UsagePanel";
import { COUNTER_ISSUE, COUNTER_LABELS, COUNTER_SOURCE, SOURCES, age, isProblem, issueName, reminderDraft, runKindLabel, signalLabel, type Source } from "./adminText";
import s from "./admin.module.css";

const NO_CARDS: Card[] = [];
const POLL_MS = 30_000;
const SOURCE_ICONS: Record<Source, LucideIcon> = { collector: Laptop, feishu: KeyRound, world: Database };
const STATUS_NAMES: Record<TAdminStatus, string> = { red: "红", yellow: "黄", green: "绿", none: "未接入" };
type Act = (input: DistributiveOmit<TAdminActionRequest, "clientId">) => Promise<boolean>;
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

export function AdminScreen({ initial }: { initial: TAdminOverviewResponse }) {
  const workspace = useWorkspace();
  const [view, setView] = useState(initial);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState<TAdminCounterKey | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [remind, setRemind] = useState<{ row: TAdminPersonRow; source: Source } | null>(null);
  const [tab, setTab] = useState<"runtime" | "usage">("runtime");
  useRegisterDetail(useMemo(() => ({ scope: "global", label: "管理员", mark: null, cards: NO_CARDS }), []));

  const load = useCallback(async () => {
    try {
      const { data, response } = await browserApi.GET("/api/admin/overview");
      if (response.status === 401 || response.status === 404) { window.location.assign("/access"); return; }
      setFailed(!data);
      if (data) setView(data);
    } catch { setFailed(true); }
  }, []);
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === "visible") void load(); };
    const timer = window.setInterval(refresh, POLL_MS);
    window.addEventListener("focus", refresh);
    document.addEventListener("visibilitychange", refresh);
    return () => { window.clearInterval(timer); window.removeEventListener("focus", refresh); document.removeEventListener("visibilitychange", refresh); };
  }, [load]);

  const act: Act = useCallback(async (input) => {
    try {
      const { data } = await browserApi.POST("/api/admin/actions", { body: { ...input, clientId: crypto.randomUUID() } as TAdminActionRequest });
      if (data) setView(data);
      return Boolean(data);
    } catch { return false; }
  }, []);

  const now = new Date(view.generatedAt);
  const source = filter ? COUNTER_SOURCE[filter] : undefined;
  const issueType = filter ? COUNTER_ISSUE[filter] : undefined;
  const people = source ? view.people.filter((row) => isProblem(row[source].status)) : view.people;
  const issues = issueType ? view.issues.filter((issue) => issue.subject.type === issueType) : view.issues;
  const peopleProblems = view.people.filter((row) => SOURCES.some(({ key }) => isProblem(row[key].status))).length;
  const clock = now.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23", timeZone: "Asia/Shanghai" });

  return (
    <div className={s.screen}>
      <DetailFrame title="管理员" subtitle={clock} onBack={() => workspace.close()}
        actions={<Button variant="ghost" isIconOnly className={s.refresh} aria-label="刷新" onPress={() => void load()}><RefreshCw size={17} aria-hidden="true" /></Button>}>
        <div className={s.content}>
          <ToggleButtonGroup className={s.views} aria-label="视图" selectionMode="single" disallowEmptySelection selectedKeys={[tab]}
            onSelectionChange={(keys) => { const next = [...keys][0]; if (next === "runtime" || next === "usage") setTab(next); }}>
            <ToggleButton id="runtime" size="sm">运行</ToggleButton>
            <ToggleButton id="usage" size="sm">使用</ToggleButton>
          </ToggleButtonGroup>
          {tab === "usage" ? <UsagePanel /> : null}
          <div className={s.stack} hidden={tab !== "runtime"}>
            {failed ? <p className={s.error} role="alert">没有取到最新数据</p> : null}
            <section className={s.counters} aria-label="计数">
              {view.counters.map((counter) => {
                const target = COUNTER_SOURCE[counter.key] ?? COUNTER_ISSUE[counter.key];
                return (
                  <button key={counter.key} type="button" className={s.tile} data-status={counter.status} aria-pressed={filter === counter.key}
                    disabled={!target} onClick={() => setFilter(filter === counter.key ? null : counter.key)}>
                    <span className={s.tileLabel}><i className={s.dot} data-status={counter.status} aria-hidden="true" />{COUNTER_LABELS[counter.key]}</span>
                    <strong className={s.tileValue}>{counter.value}</strong>
                  </button>
                );
              })}
            </section>

            {!issueType ? (
              <section className={s.section} aria-labelledby="admin-people">
                <SectionHead id="admin-people" title="人 × 来源" count={peopleProblems} total={view.people.length} />
                <div className={s.grid}>
                  <div className={s.gridHead} aria-hidden="true">
                    <span>人</span>
                    {SOURCES.map(({ key, label }) => {
                      const Icon = SOURCE_ICONS[key];
                      return <span key={key} data-active={source === key ? "" : undefined}><Icon size={14} aria-hidden="true" />{label}</span>;
                    })}
                    <span />
                  </div>
                  {people.map((row) => (
                    <PersonRow key={row.personId} row={row} now={now} expanded={open === row.personId} self={row.personId === view.viewerId}
                      onToggle={() => setOpen(open === row.personId ? null : row.personId)} onRemind={(key) => setRemind({ row, source: key })} act={act} />
                  ))}
                </div>
              </section>
            ) : null}

            {!source ? (
              <section className={s.section} aria-labelledby="admin-issues">
                <SectionHead id="admin-issues" title="失败" count={issues.length} />
                {issues.length ? (
                  <ul className={s.list}>
                    {issues.map((issue) => <IssueRow key={`${issue.subject.type}:${issue.subject.id}`} issue={issue} now={now} act={act} />)}
                  </ul>
                ) : <Clear />}
              </section>
            ) : null}

            {!filter ? (
              <section className={s.section} aria-labelledby="admin-quality">
                <SectionHead id="admin-quality" title="质量信号" count={view.quality.length} />
                {view.quality.length ? (
                  <ul className={s.list}>
                    {view.quality.map((item, index) => <QualityRow key={`${item.subject.id}:${item.signal}:${index}`} item={item} now={now} act={act} />)}
                  </ul>
                ) : <Clear />}
              </section>
            ) : null}
          </div>
        </div>
      </DetailFrame>
      {remind ? <RemindDialog row={remind.row} source={remind.source} now={now} act={act} onClose={() => setRemind(null)} /> : null}
    </div>
  );
}

function SectionHead({ id, title, count, total }: { id: string; title: string; count: number; total?: number }) {
  return (
    <header className={s.sectionHead}>
      <h2 id={id}>{title}</h2>
      <span className={s.sectionCount} data-zero={count === 0 ? "" : undefined}>{total === undefined ? count : `${count}/${total}`}</span>
    </header>
  );
}

function Clear() {
  return <p className={s.clear}><Check size={16} aria-label="0" /></p>;
}

function When({ iso, now }: { iso: string | null; now: Date }) {
  return iso ? <time dateTime={iso} title={monthDayTime(iso)}>{age(iso, now)}</time> : <span>—</span>;
}

function MarkChip({ mark }: { mark: TAdminMark }) {
  return <span className={s.mark} title={monthDayTime(mark.at)}><Check size={12} aria-hidden="true" />{mark.actorName}</span>;
}

function PersonRow({ row, now, expanded, self, onToggle, onRemind, act }: {
  row: TAdminPersonRow; now: Date; expanded: boolean; self: boolean; onToggle: () => void; onRemind: (source: Source) => void; act: Act;
}) {
  return (
    <Fragment>
      <button type="button" className={s.row} aria-expanded={expanded} onClick={onToggle}>
        <span className={s.name}>{row.displayName}</span>
        {SOURCES.map(({ key, label }) => {
          const cell = row[key];
          return (
            <span key={key} className={s.cell} data-status={cell.status} aria-label={`${label} ${STATUS_NAMES[cell.status]}`}>
              <small className={s.cellLabel}>{label}</small>
              <span className={s.cellMain}><i className={s.dot} data-status={cell.status} aria-hidden="true" /><When iso={cell.lastSuccessAt} now={now} /></span>
              {cell.acknowledged || cell.remindedAt ? (
                <span className={s.cellMarks}>
                  {cell.acknowledged ? <MarkChip mark={cell.acknowledged} /> : null}
                  {cell.remindedAt ? <span className={s.reminded} title={monthDayTime(cell.remindedAt)}><Bell size={12} aria-label="已提醒" />{age(cell.remindedAt, now)}</span> : null}
                </span>
              ) : null}
            </span>
          );
        })}
        <ChevronDown size={16} className={s.chevron} aria-hidden="true" />
      </button>
      {expanded ? (
        <div className={s.detail}>
          {SOURCES.map(({ key, label }) => (
            <div key={key} className={s.detailBlock} data-status={row[key].status}>
              <h3><i className={s.dot} data-status={row[key].status} aria-hidden="true" />{label}</h3>
              <SourceFacts row={row} source={key} />
              <div className={s.actions}>
                {key !== "world" || row.world.status !== "none" ? (
                  !self && row[key].status !== "green" ? <Button variant="ghost" className={s.action} onPress={() => onRemind(key)}><Bell size={14} aria-hidden="true" />提醒</Button> : null
                ) : null}
                {isProblem(row[key].status) ? <MarkActions subject={{ type: key, id: row.personId }} acknowledged={row[key].acknowledged} act={act} hideResolveUntilAcknowledged /> : null}
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </Fragment>
  );
}

function Facts({ items }: { items: [string, string | null][] }) {
  const shown = items.filter(([, value]) => value);
  if (!shown.length) return null;
  return <dl className={s.facts}>{shown.map(([name, value]) => <Fragment key={name}><dt>{name}</dt><dd>{value}</dd></Fragment>)}</dl>;
}

function SourceFacts({ row, source }: { row: TAdminPersonRow; source: Source }) {
  if (source === "collector") {
    if (!row.collector.devices.length) return null;
    return (
      <div className={s.devices}>
        {row.collector.devices.map((device) => (
          <div key={`${device.deviceName}:${device.source}:${device.firstSeenAt}`} className={s.device}>
            <p className={s.deviceName}>{device.deviceName}<span>{device.platform} · {device.source} · {device.version}</span></p>
            <Facts items={[
              ["状态", device.sourceStatus === "ok" ? null : `${device.sourceStatus}${device.errorCode ? ` · ${device.errorCode}` : ""}`],
              ["成功", monthDayTime(device.lastSuccessAt) || "—"],
              ["尝试", monthDayTime(device.lastAttemptAt)],
              ["覆盖到", monthDayTime(device.coverageUntil) || "—"],
              ["新证据", monthDayTime(device.lastNewEvidenceAt) || "—"],
              ["首次", monthDayTime(device.firstSeenAt)],
            ]} />
          </div>
        ))}
      </div>
    );
  }
  if (source === "feishu") {
    const cell = row.feishu;
    return <Facts items={[
      ["状态", cell.tokenStatus === "reauth_required" ? "需重新授权" : cell.tokenStatus === "active" ? "有效" : null],
      ["授权", monthDayTime(cell.authorizedAt) || null],
      ["续期", monthDayTime(cell.lastSuccessAt) || null],
      ["到期", monthDayTime(cell.refreshExpiresAt) || null],
      ["提醒重授权", monthDayTime(cell.reauthReminderAt) || null],
    ]} />;
  }
  const cell = row.world;
  return <Facts items={[
    ["周", cell.lastWeek],
    ["状态", cell.syncStatus === "failed" ? "失败" : cell.syncStatus === "pending" ? "写入中" : cell.syncStatus === "done" ? "已写入" : null],
    ["失败对象", cell.failedTargets ? String(cell.failedTargets) : null],
    ["成功", monthDayTime(cell.lastSuccessAt) || null],
  ]} />;
}

/** 接手、解决：没接手时给「接手」；接手后显示谁接的，给「解决」。人 × 来源的一格只有接手之后才给「解决」（解决只是清掉接手）。 */
function MarkActions({ subject, acknowledged, act, hideResolveUntilAcknowledged = false, extra }: {
  subject: TAdminSubject; acknowledged: TAdminMark | null; act: Act; hideResolveUntilAcknowledged?: boolean; extra?: React.ReactNode;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const run = async (action: "acknowledge" | "resolve") => {
    setBusy(true);
    setError(false);
    const ok = await act({ action, subject });
    setBusy(false);
    setError(!ok);
  };
  return (
    <>
      {extra}
      {acknowledged ? <MarkChip mark={acknowledged} /> : <Button variant="ghost" className={s.action} isDisabled={busy} onPress={() => void run("acknowledge")}>接手</Button>}
      {acknowledged || !hideResolveUntilAcknowledged ? <Button variant="ghost" className={s.action} isDisabled={busy} onPress={() => void run("resolve")}><Check size={14} aria-hidden="true" />解决</Button> : null}
      {error ? <span className={s.actionError} role="alert">没有成功</span> : null}
    </>
  );
}

function RetryButton({ issue, act }: { issue: TAdminIssue; act: Act }) {
  const [busy, setBusy] = useState(false);
  return <Button variant="ghost" className={s.action} isDisabled={busy} onPress={async () => {
    setBusy(true);
    await act({ action: "retry", subject: { type: "job", id: issue.subject.id } });
    setBusy(false);
  }}><RotateCcw size={14} aria-hidden="true" />重试</Button>;
}

function IssueRow({ issue, now, act }: { issue: TAdminIssue; now: Date; act: Act }) {
  return (
    <li className={s.item} data-status={issue.status}>
      <i className={s.dot} data-status={issue.status} aria-hidden="true" />
      <div className={s.itemMain}>
        <p className={s.itemTitle}><code>{issueName(issue.name)}</code>{issue.target ? <span className={s.itemTarget}>{issue.target}</span> : null}</p>
        {issue.code ? <p className={s.itemCode}>{issue.code}</p> : null}
      </div>
      <div className={s.itemMeta}>
        {issue.attempts !== null ? <span className={s.attempts}>×{issue.attempts}</span> : null}
        <When iso={issue.at} now={now} />
      </div>
      <div className={s.itemActions}>
        <MarkActions subject={issue.subject} acknowledged={issue.acknowledged} act={act} extra={issue.retryable ? <RetryButton issue={issue} act={act} /> : null} />
      </div>
    </li>
  );
}

function QualityRow({ item, now, act }: { item: TAdminQualitySignal; now: Date; act: Act }) {
  const status: TAdminStatus = item.signal === "run_failed" ? "red" : "yellow";
  return (
    <li className={s.item} data-status={status}>
      <i className={s.dot} data-status={status} aria-hidden="true" />
      <div className={s.itemMain}>
        <p className={s.itemTitle}>{signalLabel(item.signal)}<span className={s.itemTarget}>{[runKindLabel(item.runKind), item.personName].filter(Boolean).join(" · ")}</span></p>
        <p className={s.itemCode}>{item.subject.id.slice(0, 8)}</p>
      </div>
      <div className={s.itemMeta}>
        {item.count > 1 ? <span className={s.attempts}>×{item.count}</span> : null}
        <When iso={item.at} now={now} />
      </div>
      <div className={s.itemActions}>
        <MarkActions subject={item.subject} acknowledged={item.acknowledged} act={act} />
      </div>
    </li>
  );
}

/** 提醒先预览：发给谁、标题、正文都看得到也改得了，点「发送」才经送达通道发出。 */
function RemindDialog({ row, source, now, act, onClose }: { row: TAdminPersonRow; source: Source; now: Date; act: Act; onClose: () => void }) {
  const [draft, setDraft] = useState(() => reminderDraft(row, source, now));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(false);
  const send = async () => {
    setBusy(true);
    setError(false);
    const ok = await act({ action: "remind", personId: row.personId, source, title: draft.title.trim(), body: draft.body.trim() });
    setBusy(false);
    if (ok) onClose(); else setError(true);
  };
  return (
    <MenuDialog title={`提醒${row.displayName}`} wide onClose={onClose}>
      <div className={s.remind}>
        <p className={s.remindTo}><span>发给</span><strong>{row.displayName}</strong></p>
        <input aria-label="标题" className={s.remindTitle} maxLength={200} value={draft.title} onChange={(event) => setDraft({ ...draft, title: event.target.value })} />
        <textarea aria-label="正文" className={s.remindBody} rows={4} maxLength={2000} value={draft.body} onChange={(event) => setDraft({ ...draft, body: event.target.value })} />
        {error ? <p className={s.error} role="alert">没有发出去</p> : null}
        <div className={s.remindBar}>
          <Button variant="ghost" className={s.action} onPress={onClose}>取消</Button>
          <Button variant="primary" className={s.primary} isDisabled={busy || !draft.title.trim() || !draft.body.trim()} onPress={() => void send()}><Bell size={15} aria-hidden="true" />发送</Button>
        </div>
      </div>
    </MenuDialog>
  );
}
