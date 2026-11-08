"use client";

/**
 * 项目转交（新首页设计 16.7）网页这边的几块，接 B 的转交接口（契约 projectTransfers.ts），样子都用现有的：阶段行（.line + 转圈 + 用时）、选项框（DecisionBox）、分隔线（.monthRule）、chip。
 * - TransferFlow：转出的人在项目对话里看到的「准备交接」→（问在跑的会话、问文件夹检查）→ 交接说明卡 →「交给 {名字}」→ 等接手。每一步都存到云端（PATCH）。
 * - HandoverCard：交接说明卡（云端写的），逐段能直接改；卡下面「带上对话记录」（默认不勾）和「交给 {名字}」；云端查出像密钥的行标出来，挡住不让发。
 * - TransferPreview：接手人从等你点进来的只读预览，交接说明在最上面，「接手」「不接」。
 * - HandoverRule：对话里换人的分隔线「{日期} {原负责人} → {接手人}」。HandoverSummary：接手人那边的第一条，交接说明加「没做完的事」做成的选项。
 * - ProjectPull：接手以后文件夹 chip 写「拉到这台电脑」（本机程序 clone 交接分支），拉不下来在 chip 上写原因。
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowLeft, ChevronRight, Pencil } from "lucide-react";
import type { THandoverSecretFinding, TConversationHistory } from "@warmap/contracts";
import { ConversationTurns } from "@/conversation/Transcript";
import type { Message } from "@/conversation/useConversation";
import { HeroButton } from "@/components/HeroButton";
import { DecisionBox, FailedLine, failureOf, type Failure } from "@/components/work/DecisionBox";
import { usePhone } from "@/components/home/usePhone";
import { acceptTransfer, declineTransfer, readTransfer, readTransferHistory, secretFindings, sendTransfer, updateTransfer } from "@/lib/board/cloud";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { HOME_HREF, duration, projectHref } from "@/lib/home/derive";
import type { Project } from "@/lib/home/projects";
import { handoverRule, type HandoverSection, type Person, type Transfer } from "@/lib/home/transfer";
import { answeredOf, markAnswered } from "./TaskDecisions";
import { ICON, StateIcon } from "./StateIcon";
import { useViewChrome } from "./view";
import h from "@/styles/home.module.css";

const noop = () => undefined;
/** 交接说明还在写时隔多久读一次。 */
const NOTE_POLL_MS = 3000;

/** 还在跑（或排着、等你）的会话：转之前要问等做完还是停掉。 */
const busy = (project: Project) => project.subSessions.filter((sub) => sub.state === "running" || sub.state === "queued" || sub.state === "waiting");

/** 用时每秒走（阶段行「准备交接 · 1 分 05 秒」）。 */
function useTicking(on: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [on]);
  return now;
}

/** 调一次云端，没成在原处写「失败 · 重试」。 */
function useAttempt() {
  const [failed, setFailed] = useState<Failure | null>(null);
  const attempt = (run: () => Promise<unknown>) => {
    const once = () => { setFailed(null); void run().catch((error) => setFailed(failureOf(error, once))); };
    once();
  };
  return { failed, attempt };
}

export function TransferFlow({ project, transfer, onChanged, onStop }: {
  project: Project;
  transfer: Transfer;
  /** 存好了：重读首页（转交跟着项目回来）。 */
  onChanged: () => Promise<unknown> | void;
  /** 选了「停掉」：停掉这些会话（这台电脑上在跑的经本机程序，云端还排着的撤掉登记）。 */
  onStop: (subs: Project["subSessions"]) => Promise<void>;
}) {
  const local = useLocalRunner();
  const handheld = usePhone();
  const running = busy(project);
  const preparing = transfer.status === "preparing";
  const askRunning = preparing && transfer.running === null && running.length > 0;
  const waitRunning = preparing && transfer.running === "wait" && running.length > 0;
  const askCheck = preparing && !askRunning && !!project.folder && transfer.check === null;
  const waitCheck = preparing && transfer.check === "wait" && !transfer.checkResult;
  const ready = preparing && !askRunning && !waitRunning && !askCheck && !waitCheck;
  // 交接说明 null 就是云端在后台写（发起时、存下本机检查结果后各写一遍；写不出来退回拼的四段）：一行「正在写交接说明」加用时，隔几秒读一次这份转交。
  const writingNote = preparing && !transfer.note;
  const now = useTicking(preparing && (!ready || writingNote));
  const changedRef = useRef(onChanged);
  useEffect(() => { changedRef.current = onChanged; });
  useEffect(() => {
    if (!writingNote) return;
    const timer = window.setInterval(() => {
      void readTransfer(transfer.id).then((fresh) => { if (fresh && (fresh.note || fresh.status !== "preparing")) void changedRef.current(); }, () => undefined);
    }, NOTE_POLL_MS);
    return () => window.clearInterval(timer);
  }, [writingNote, transfer.id]);
  const { failed, attempt } = useAttempt();
  const save = (patch: Parameters<typeof updateTransfer>[1]) => attempt(async () => { await updateTransfer(transfer.id, patch); await onChanged(); });
  // 等本机检查：这台电脑上本机程序就绪了就查一次（只看 git），结果交给云端写「代码在哪」。
  const checked = useRef<string | null>(null);
  useEffect(() => {
    if (!waitCheck || local.phase !== "ready" || handheld || checked.current === transfer.id) return;
    checked.current = transfer.id;
    attempt(async () => { await updateTransfer(transfer.id, { checkResult: await local.runner.handoverCheck(project.id) }); await onChanged(); });
  });
  return (
    <div className={h.transfer} data-testid="transfer-flow">
      <p className={h.line}>
        <StateIcon state={preparing && !ready ? "running" : "done"} />
        准备交接给 {transfer.to.name}
        {preparing && !ready ? <span className={h.lineMore}> · {duration(transfer.startedAt, now)}</span> : null}
      </p>
      {askRunning ? (
        <DecisionBox kind="question" title={`有 ${running.length} 个会话在跑`} testId="transfer-running"
          options={[{ label: "等做完再转", recommended: true }, { label: "停掉" }]}
          onPick={([index]) => (index === 0 ? save({ running: "wait" }) : attempt(async () => { await onStop(running); await updateTransfer(transfer.id, { running: "stop" }); await onChanged(); }))} />
      ) : transfer.running ? (
        <DecisionBox kind="question" title="在跑的会话" options={[]} onPick={noop} resolved={transfer.running === "wait" ? "等做完再转" : "停掉"} />
      ) : null}
      {waitRunning ? <p className={h.line}><StateIcon state="running" />等 {running.length} 个会话做完</p> : null}
      {askCheck ? (
        <DecisionBox kind="question" title={`检查文件夹「${project.folder}」`} testId="transfer-check"
          options={[{ label: "等本机上线", recommended: true }, { label: "不检查直接转" }]}
          onPick={([index]) => save({ check: index === 0 ? "wait" : "skip" })} />
      ) : transfer.check === "skip" ? (
        <DecisionBox kind="question" title={`检查文件夹「${project.folder ?? ""}」`} options={[]} onPick={noop} resolved="不检查直接转" />
      ) : null}
      {waitCheck ? (
        <p className={h.line}><StateIcon state="queued" />检查文件夹 · 等本机上线
          <HeroButton variant="ghost" size="sm" onPress={() => save({ check: "skip" })}>不检查直接转</HeroButton></p>
      ) : null}
      {ready && writingNote ? (
        <p className={h.line} data-testid="note-writing"><StateIcon state="running" />正在写交接说明
          <span className={h.lineMore}> · {duration(transfer.checkResult?.checkedAt ?? transfer.startedAt, now)}</span></p>
      ) : null}
      {failed ? <FailedLine {...failed} /> : null}
      {transfer.note && (ready || !preparing) ? <HandoverCard transfer={transfer} onChanged={onChanged} /> : null}
      {transfer.status === "sent" ? <p className={h.line} data-testid="transfer-sent"><StateIcon state="queued" />已交给 {transfer.to.name} · 等接手</p> : null}
    </div>
  );
}

/** 交接说明的几段（预览和卡共用）；云端查出像密钥的那一行标危险色。onEdit 给了就每段一个「改」；正在改的那段画 editor。 */
function NoteBody({ note, findings = [], onEdit, editing, editor }: {
  note: HandoverSection[]; findings?: THandoverSecretFinding[]; onEdit?: (title: string) => void; editing?: string | null; editor?: (section: HandoverSection) => ReactNode;
}) {
  return (
    <div className={h.noteBody}>
      {note.map((section) => (section.title === editing && editor ? <div key={section.title}>{editor(section)}</div> : (
        <section key={section.title} aria-label={section.title}>
          <p className={h.noteTitle}>{section.title}
            {onEdit ? <HeroButton variant="ghost" size="sm" isIconOnly aria-label={`改「${section.title}」`} title="改" onPress={() => onEdit(section.title)}><Pencil {...ICON} /></HeroButton> : null}
          </p>
          <ul>
            {section.lines.map((line, index) => (
              <li key={`${index}:${line}`} data-secret={findings.some((hit) => hit.section === section.title && hit.line === index + 1) ? "" : undefined}>{line}</li>
            ))}
          </ul>
        </section>
      )))}
    </div>
  );
}

/** 改一段：一行一条；改完存到云端（整份说明一起 PATCH），空了的段去掉。 */
function SectionEditor({ section, onSave, onCancel }: { section: HandoverSection; onSave: (lines: string[]) => Promise<void>; onCancel: () => void }) {
  const [text, setText] = useState(section.lines.join("\n"));
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState<Failure | null>(null);
  const save = async () => {
    setSaving(true); setFailed(null);
    try { await onSave(text.split("\n").map((line) => line.trim()).filter(Boolean)); }
    catch (error) { setFailed(failureOf(error, () => void save())); }
    finally { setSaving(false); }
  };
  return (
    <section aria-label={section.title}>
      <p className={h.noteTitle}>{section.title}</p>
      <textarea className={h.noteEdit} value={text} rows={Math.max(2, section.lines.length + 1)} aria-label={section.title} autoFocus
        onChange={(event) => setText(event.target.value)} data-testid="note-edit" />
      <div className={h.noteFoot}>
        <HeroButton variant="tertiary" size="sm" isDisabled={saving} onPress={() => void save()}>保存</HeroButton>
        <HeroButton variant="ghost" size="sm" isDisabled={saving} onPress={onCancel}>取消</HeroButton>
        {failed ? <FailedLine inline {...failed} /> : null}
      </div>
    </section>
  );
}

/** 交接说明卡：逐段能改；卡下面「带上对话记录」（默认不勾）和「交给 {名字}」（点两次才发出）。发出时云端查出像密钥的（422），标出那几行、挡住。 */
export function HandoverCard({ transfer, onChanged }: { transfer: Transfer; onChanged: () => Promise<unknown> | void }) {
  const note = transfer.note ?? [];
  const sent = transfer.status !== "preparing";
  const [editing, setEditing] = useState<string | null>(null);
  const [findings, setFindings] = useState<THandoverSecretFinding[]>([]);
  const [busyWith, setBusyWith] = useState(false);
  const { failed, attempt } = useAttempt();
  const saveSection = async (title: string, lines: string[]) => {
    const next = note.flatMap((section) => (section.title !== title ? [section] : lines.length ? [{ title, lines }] : []));
    await updateTransfer(transfer.id, { note: next });
    setFindings((now) => now.filter((hit) => hit.section !== title));
    setEditing(null);
    await onChanged();
  };
  const send = () => attempt(async () => {
    setBusyWith(true);
    try { await sendTransfer(transfer.id); setFindings([]); await onChanged(); }
    catch (error) { const hits = secretFindings(error); if (!hits) throw error; setFindings(hits); }
    finally { setBusyWith(false); }
  });
  return (
    <article className={h.noteCard} aria-label="交接说明" data-testid="handover-card">
      <p className={h.noteHead}>交接说明</p>
      <NoteBody note={note} findings={findings} onEdit={sent || editing ? undefined : setEditing} editing={editing}
        editor={(section) => <SectionEditor section={section} onSave={(lines) => saveSection(section.title, lines)} onCancel={() => setEditing(null)} />} />
      {findings.length ? (
        <p className={h.barError} role="alert" data-testid="handover-secret">
          {findings.map((hit) => `${hit.section}第 ${hit.line} 行像密钥（${hit.sample}）`).join("；")}
        </p>
      ) : null}
      <div className={h.noteFoot}>
        <label className={h.check}>
          <input type="checkbox" checked={transfer.includeHistory} disabled={sent} data-testid="handover-history"
            onChange={(event) => { const value = event.target.checked; attempt(async () => { await updateTransfer(transfer.id, { includeHistory: value }); await onChanged(); }); }} />
          带上对话记录
        </label>
        {sent ? null : <ConfirmSend name={transfer.to.name} disabled={findings.length > 0 || !!editing || busyWith} onConfirm={send} />}
        {failed ? <FailedLine inline {...failed} /> : null}
      </div>
    </article>
  );
}

/** 「交给 {名字}」点了以后等多久没再点就变回去。 */
export const CONFIRM_MS = 5000;

/**
 * 点两次才做：第一次只把按钮变成确认态，再点一次才 act；disarm（点了别处、Esc、失焦）或过了 ms 没再点，变回去。
 * onArmed 报确认态的进出。
 */
export function twoStepPress(act: () => void, onArmed: (armed: boolean) => void, ms = CONFIRM_MS) {
  let armed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const disarm = () => {
    if (timer) clearTimeout(timer);
    timer = null;
    if (!armed) return;
    armed = false;
    onArmed(false);
  };
  const press = () => {
    if (armed) { disarm(); act(); return; }
    armed = true;
    onArmed(true);
    timer = setTimeout(disarm, ms);
  };
  return { press, disarm };
}

/** 交接说明卡上的「交给 {名字}」：点一次原地变成「确认转交」，再点一次才发出。确认态的变化读屏会念（外面包一层 polite）。 */
function ConfirmSend({ name, disabled, onConfirm }: { name: string; disabled: boolean; onConfirm: () => void }) {
  const [armed, setArmed] = useState(false);
  const confirmRef = useRef(onConfirm);
  useEffect(() => { confirmRef.current = onConfirm; });
  const [step] = useState(() => twoStepPress(() => confirmRef.current(), setArmed));
  const box = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!armed) return;
    const away = (event: PointerEvent) => { if (!box.current?.contains(event.target as Node)) step.disarm(); };
    // 确认态里的 Esc 只把按钮变回去，标成处理过，首页「Esc 回首页」和对话里的 Esc 就不再接。
    const escape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.preventDefault(); step.disarm(); } };
    document.addEventListener("pointerdown", away, true);
    document.addEventListener("keydown", escape, true);
    return () => { document.removeEventListener("pointerdown", away, true); document.removeEventListener("keydown", escape, true); };
  }, [armed, step]);
  useEffect(() => () => step.disarm(), [step]);
  useEffect(() => { if (disabled) step.disarm(); }, [disabled, step]);
  return (
    <span ref={box} aria-live="polite" onBlur={step.disarm}>
      <HeroButton variant="primary" size="sm" isDisabled={disabled} onPress={step.press} data-testid="handover-send" data-armed={armed ? "" : undefined}>
        {armed ? "确认转交" : `交给 ${name}`}
      </HeroButton>
    </span>
  );
}

/** 接手人的只读预览（从等你点进来）：交接说明在最上面，「接手」「不接」；已经接了、没接、撤回了的不给按钮。 */
export function TransferPreview({ transfer, onAccept, onDecline }: { transfer: Transfer; onAccept: () => Promise<unknown>; onDecline: () => Promise<unknown> }) {
  const [busyWith, setBusyWith] = useState(false);
  const { failed, attempt } = useAttempt();
  const run = (action: () => Promise<unknown>) => attempt(async () => { setBusyWith(true); try { await action(); } finally { setBusyWith(false); } });
  return (
    <div className={h.transferPreview} data-testid="transfer-preview">
      <p className={h.sectionTitle}>{transfer.from.name}把「{transfer.projectName}」交给你</p>
      {transfer.note ? <article className={h.noteCard} aria-label="交接说明"><p className={h.noteHead}>交接说明</p><NoteBody note={transfer.note} /></article> : null}
      {transfer.status === "sent" ? (
        <div className={h.noteFoot}>
          <HeroButton variant="primary" size="sm" isDisabled={busyWith} onPress={() => run(onAccept)} data-testid="transfer-accept">接手</HeroButton>
          <HeroButton variant="ghost" size="sm" isDisabled={busyWith} onPress={() => run(onDecline)} data-testid="transfer-decline">不接</HeroButton>
          {failed ? <FailedLine inline {...failed} /> : null}
        </div>
      ) : <p className={h.line}><StateIcon state={transfer.status === "accepted" ? "done" : "stopped"} />{transfer.status === "accepted" ? "已接手" : transfer.status === "declined" ? "没接" : "已撤回"}</p>}
    </div>
  );
}

/** 等你里「{原负责人}把「{项目}」交给你」点进来（/me/work/transfers/:id）：只读预览；接手了进项目对话，不接留在这里写「没接」。 */
export function TransferView({ id, go, onChanged }: { id: string; go: (href: string) => void; onChanged: () => Promise<unknown> }) {
  const chrome = useViewChrome();
  const [loaded, setLoaded] = useState<{ transfer: Transfer | null } | null>(null);
  useEffect(() => {
    let alive = true;
    void readTransfer(id).then((transfer) => { if (alive) setLoaded({ transfer }); }, () => { if (alive) setLoaded({ transfer: null }); });
    return () => { alive = false; };
  }, [id]);
  const transfer = loaded?.transfer ?? null;
  const accept = async () => { const done = await acceptTransfer(id); await onChanged(); go(projectHref(done.projectId)); };
  const decline = async () => { setLoaded({ transfer: await declineTransfer(id) }); await onChanged(); };
  return (
    <div className={h.infoView} data-type-scale="doc" data-testid="transfer-view">
      <header className={h.viewHead}>
        {chrome.lead ?? <button type="button" className={h.icon} aria-label="返回" title="返回" onClick={() => (window.history.length > 1 ? window.history.back() : go(HOME_HREF))}><ArrowLeft {...ICON} /></button>}
        <h1 className={h.viewTitle} tabIndex={-1}>{transfer?.projectName ?? ""}</h1>
        {chrome.trail}
      </header>
      <div className={h.infoScroll} aria-busy={!loaded || undefined}>
        <div className={h.infoInner}>
          <section className={h.section}>
            {transfer ? <TransferPreview transfer={transfer} onAccept={accept} onDecline={decline} /> : loaded ? <p className={h.line}>没有这份转交</p> : null}
          </section>
        </div>
      </div>
    </div>
  );
}

/** 接手人那边：带上了对话记录时，原负责人那段对话（只读）收在分隔线上面的一行里，点开看。 */
export function TransferHistory({ history, from }: { history: TConversationHistory; from: Person }) {
  const [open, setOpen] = useState(false);
  if (!history.messages.length) return null;
  return (
    <div data-testid="transfer-history">
      <button type="button" className={h.foldToggle} data-flat="" aria-expanded={open} onClick={() => setOpen(!open)}>
        <ChevronRight size={14} strokeWidth={1.8} aria-hidden className={h.chevron} data-open={open ? "" : undefined} />{from.name}的对话 {history.messages.length}
      </button>
      {open ? <ConversationTurns messages={history.messages as Message[]} /> : null}
    </div>
  );
}

/** 接手人那边交过来的这一份：「拉到这台电脑」用的仓库（clone），带上了对话记录时的原来那段（history，没带为 null）。 */
export function useReceived(transferId: string | null): { clone: Transfer["clone"]; history: TConversationHistory | null } {
  const [got, setGot] = useState<{ id: string; clone: Transfer["clone"]; history: TConversationHistory | null } | null>(null);
  useEffect(() => {
    if (!transferId) return;
    let alive = true;
    void Promise.all([readTransfer(transferId).catch(() => null), readTransferHistory(transferId).catch(() => null)])
      .then(([transfer, history]) => { if (alive) setGot({ id: transferId, clone: transfer?.clone ?? null, history }); });
    return () => { alive = false; };
  }, [transferId]);
  return got && got.id === transferId ? got : { clone: null, history: null };
}

/** 对话里换人的分隔线：「11/7 孙铭泽 → 陈晨星」（样式同月份分隔）。 */
export function HandoverRule({ item }: { item: { at: string; from: Person; to: Person } }) {
  return <p className={h.monthRule} role="separator" data-testid="handover-rule">{handoverRule(item)}</p>;
}

/**
 * 接手人那边分隔线后的第一条（项目动态 handover_summary）：管线发的项目总结，就是交接说明；「没做完的事」做成选项，选了就照它说一句（先做哪件）。
 * 答过的（这台电脑上）收成一行。
 */
export function HandoverSummary({ item, onSay }: { item: { id: string; from: Person; note: HandoverSection[] }; onSay: (text: string) => unknown }) {
  const todo = item.note.find((section) => section.title === "没做完的事")?.lines ?? [];
  const [answer, setAnswer] = useState<string | null>(() => answeredOf(item.id));
  const settle = (text: string) => { markAnswered(item.id, text); setAnswer(text); };
  const say = async (text: string) => { if ((await onSay(text)) === false) throw new Error("没发出去"); settle(text); };
  return (
    <div className={h.transferPreview} data-testid="handover-summary">
      <article className={h.noteCard} aria-label="交接说明"><p className={h.noteHead}>交接说明 · {item.from.name}</p><NoteBody note={item.note} /></article>
      {todo.length ? (answer
        ? <DecisionBox kind="question" title="先做哪件" options={[]} onPick={noop} resolved={answer} />
        : <DecisionBox kind="question" title="先做哪件" testId="handover-todo" options={todo.map((line, index) => ({ label: line, recommended: index === 0 }))}
          onPick={([index]) => say(`先做：${todo[index ?? 0]}`)} other={{ onSubmit: say }} />) : null}
    </div>
  );
}

/** 接手以后的文件夹 chip：「拉到这台电脑」；拉着「拉取中」；拉不下来写原因（点了再试）。 */
export function PullChip({ state, reason, onPull }: { state: "idle" | "pulling" | "failed"; reason?: string | null; onPull: () => void }) {
  return (
    <button type="button" className={h.statusChip} data-tone={state === "failed" ? "danger" : undefined} disabled={state === "pulling"} title={reason ?? undefined} onClick={onPull} data-testid="pull-chip">
      {state === "pulling" ? "拉取中" : state === "failed" ? reason || "拉取失败" : "拉到这台电脑"}
    </button>
  );
}

/** 「拉到这台电脑」：本机程序弹框选位置、clone 交接分支、绑到项目（D 的 POST /v1/projects/:projectId/clone）；点了取消回到原样。 */
export function ProjectPull({ projectId, name, clone, onPulled }: { projectId: string; name: string; clone: { repoUrl: string; branch: string | null }; onPulled: () => void }) {
  const local = useLocalRunner();
  const [state, setState] = useState<{ state: "idle" | "pulling" | "failed"; reason: string | null }>({ state: "idle", reason: null });
  const pull = async () => {
    setState({ state: "pulling", reason: null });
    try {
      const result = await local.runner.cloneProject(projectId, { repoUrl: clone.repoUrl, ...(clone.branch ? { branch: clone.branch } : {}), name });
      setState({ state: "idle", reason: null });
      if (result.project) onPulled();
    } catch (error) {
      setState({ state: "failed", reason: error instanceof Error ? error.message : null });
    }
  };
  return <PullChip state={state.state} reason={state.reason} onPull={() => void pull()} />;
}
