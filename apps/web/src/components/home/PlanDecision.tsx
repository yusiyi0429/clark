"use client";

/**
 * Task 管线里的开工（新首页设计第 2 节，替换以前派活单的「开工」块）：规划员拆好的几步摆在选项框里，
 * 「就按这个开始（推荐）/ 改一改 / 自己说」。选了就开：卡放进看板，在这台电脑上一次交给本机（同时最多 3 个，多的排队），子会话出现在左边。
 * 改一改：就地改每步的标题、换岗位、去掉一步，模型在每步右边换。自己说：这句话发进 Task 管线。
 * 手机、本机没连时选「开始」，卡排成等开工，回到这台电脑上打开天枢时自己开（HomeShell）。
 * 另外两块：规划员在拆时的一行（拆卡中 · 第几步），开了以后选项框收成一行、计划的几步变成子会话行（和左栏同样式、带竖线，原地跟着状态变）。
 * 样子照设计 5.4.3「开工的特别规矩」：问题「{Task 名}：这样开工？」，编号的几步 14/20，每步下面一行「岗位 · 约定第 N 条」，再一行「N 个子会话」；
 * 岗位、模型、文件夹点了用弹层选（全站唯一那种弹层）。
 */
import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { Dropdown, Header } from "@heroui/react";
import { Check, ChevronDown, X } from "lucide-react";
import type { TBudget, TBudgetMode, TCardDraftView, TLocalAgentKind, TLocalEffort } from "@warmap/contracts";
import { ProjectModeContext } from "@/components/cards/PermissionMode";
import { DecisionBox } from "@/components/work/DecisionBox";
import { ApprovalDecision, QuestionDecision, awayChip } from "@/components/work/decisions";
import { SegmentedSwitch } from "@/components/SegmentedSwitch";
import { useHandheld } from "@/components/ui/useHandheld";
import { canCommandHere } from "@/lib/work/actions";
import { Slots } from "@/components/work/Slots";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { planStep } from "@/lib/local/sessionView";
import { useSessionEvents } from "@/lib/local/useSessionEvents";
import type { TLocalModelProfile } from "@/lib/local/runner";
import { HARNESS_NAME, effortText, pickLabel, profileModel, profileSource, sourceName } from "@/lib/local/runModel";
import { matchModelWords } from "@/lib/local/modelWords";
import { acceptDrafts, acceptProjectDrafts, dismissDraft, readTaskBudget, type PlanTarget } from "@/lib/board/cloud";
import { TIER_LABEL, draftRole, modelForTier, type CardRole, type RoleView } from "@/lib/team/roles";
import { SLOT_CAP, startBatch, type StartPlan } from "@/lib/work/queue";
import { QUEUE_LABEL, liveSessions, type Worker } from "@/lib/work/workers";
import type { SubSession } from "@/lib/home/types";
import { ICON as STATE_ICON, StateIcon } from "./StateIcon";
import { stoppedLabel, subIcon } from "./LeftColumn";
import { subQueueText } from "@/lib/home/derive";
import h from "@/styles/home.module.css";
import x from "@/styles/decision-box.module.css";
import { SourceWords } from "@/components/cards/SourceWords";
import { FolderMenu, FolderText } from "./InputFooter";
import { FolderAsk } from "./FolderAsk";

const ICON = STATE_ICON;

/** 草稿行配的岗位：拆卡给的；没给时执行方是自己的为 null（人自己的活），否则写 Claude Code。 */
export function draftWorkerRole(draft: TCardDraftView): CardRole | null {
  return draftRole(draft) ?? (draft.executor === "self" ? null : { id: "", name: "Claude Code", kind: "worker" });
}

export type Edit = { title?: string; role?: CardRole | null; modelId?: string; effort?: TLocalEffort; dropped?: boolean };
/** 模型下拉里的「自动」：不单独选，按岗位的档位配（modelForTier）。 */
export const AUTO_MODEL = "auto";

/** 本人改了一步（改名、换技能、换模型、换思考、去掉）：在这一步原来改过的上面叠。 */
export const applyEdit = (edits: Record<string, Edit>, id: string, patch: Edit): Record<string, Edit> => ({ ...edits, [id]: { ...edits[id], ...patch } });
/** 在模型下拉里选了一项：选「自动」记成没有模型（仍算本人改过）；原来的思考档新模型不支持就回到自动。 */
export const modelPickPatch = (id: string, next: Pick<TLocalModelProfile, "efforts"> | null | undefined, kept: TLocalEffort | undefined): Edit =>
  ({ modelId: id === AUTO_MODEL ? undefined : id, effort: kept && next?.efforts?.includes(kept) ? kept : undefined });
/**
 * 这一步用的模型、思考（第 69 条）：本人改过的以本人的为准（选回自动也算改过，不再被原话盖回去）；没改过照原话对上的；都没有是 undefined（自动）。
 * 按草稿 id 记，派活单刷新（草稿是新对象）也不变。
 */
export function draftPick(edit: Edit | undefined, words: { modelId: string | null; effort: TLocalEffort | null } | null): { modelId: string | undefined; effort: TLocalEffort | undefined } {
  return {
    modelId: edit && "modelId" in edit ? edit.modelId : words?.modelId ?? undefined,
    effort: edit && "effort" in edit ? edit.effort : words?.effort ?? undefined,
  };
}
export const START_LABEL = "就按这个开始";

/** 开工的模式（11.3）：自动（默认）· 设预算 · 无上限。 */
export const MODES: { id: TBudgetMode; label: string }[] = [{ id: "auto", label: "自动" }, { id: "set", label: "设预算" }, { id: "unlimited", label: "无上限" }];
/** 设预算时填的几项（字符串，照输入框原样）；不是有效数的那项不算。 */
export type Limits = { hours: string; percent: string; money: string };
const NO_LIMITS: Limits = { hours: "", percent: "", money: "" };
const positive = (value: string, max: number) => { const n = Number(value); return value.trim() && Number.isFinite(n) && n > 0 && n <= max ? n : null; };
/** 选的模式和填的上限 → 契约的 Budget；设预算却一项有效的上限都没有时为 null（发不出去）。 */
export function budgetOf(mode: TBudgetMode, limits: Limits): TBudget | null {
  if (mode !== "set") return { mode, hours: null, weeklyPercent: null, money: null };
  const hours = positive(limits.hours, 1000);
  const percent = positive(limits.percent, 100);
  const amount = positive(limits.money, 1_000_000);
  const budget: TBudget = { mode, hours, weeklyPercent: percent !== null && Number.isInteger(percent) ? percent : null, money: amount !== null ? { amount, currency: "CNY" } : null };
  return budget.hours !== null || budget.weeklyPercent !== null || budget.money !== null ? budget : null;
}
export const limitsOf = (budget: TBudget): Limits => ({ hours: budget.hours?.toString() ?? "", percent: budget.weeklyPercent?.toString() ?? "", money: budget.money?.amount.toString() ?? "" });

/**
 * target：拆的是一件 Task，还是一个没挂 Task 的项目（16.3）；name 是框顶上的名字。项目的没有预算那一栏：不挂 Task，开工用本人的缺省预算。
 */
export function PlanDecision({ target, name, drafts, roles, handheld, onSay, onChanged, afterSequence, folder = null, onSetFolder, onPickFolder, onCreateFolder }: {
  target: PlanTarget;
  name: string;
  drafts: TCardDraftView[];
  roles: RoleView[];
  handheld: boolean;
  /** 「自己说」：发进 Task 管线。 */
  onSay: (text: string) => Promise<unknown>;
  onChanged: () => void;
  /** 项目对话里本人看到的最后一条（17.2 第 29 条）：开工时带上，「开了哪几个子会话」插在它后面。 */
  afterSequence?: number;
  /**
   * 所属项目在这台电脑上绑的文件夹（17.2 第 32 条）：卡就在它里面开。下面那一行改文件夹就是改项目的（onSetFolder，同输入框下面那个），没有「这一次用别的」。
   * 这台电脑能开但项目没绑：先在下面问在哪个文件夹开工（FolderAsk），选完绑到项目上再开。
   */
  folder?: { id: string; path: string; label: string } | null;
  onSetFolder?: (folderId: string | null) => Promise<unknown>;
  /** 同输入框下面那个文件夹菜单的「选择其他文件夹…」「新建文件夹…」。 */
  onPickFolder?: () => Promise<unknown>;
  onCreateFolder?: (name: string) => Promise<unknown>;
}) {
  const local = useLocalRunner();
  const ready = local.phase === "ready" && !handheld;
  // 所在项目新开子会话的默认档（项目主管线下面那个选择），开工时带给本机。
  const projectMode = useContext(ProjectModeContext);
  const [editing, setEditing] = useState(false);
  const [edits, setEdits] = useState<Record<string, Edit>>({});
  const [busy, setBusy] = useState(false);
  // 模式从这件 Task 现在的预算开始（没设过是本人的缺省，读不到就是「自动」）；本人动过才随开工存回去。
  const [mode, setMode] = useState<TBudgetMode>("auto");
  const [limits, setLimits] = useState<Limits>(NO_LIMITS);
  const touched = useRef(false);
  const hoursRef = useRef<HTMLInputElement>(null);
  const taskId = "taskId" in target ? target.taskId : null;
  useEffect(() => {
    if (!taskId) return;
    let alive = true;
    void readTaskBudget(taskId).then((found) => {
      if (!alive || !found || touched.current) return;
      setMode(found.budget.mode);
      setLimits(limitsOf(found.budget));
    }, () => undefined);
    return () => { alive = false; };
  }, [taskId]);
  const pickMode = (next: TBudgetMode) => { touched.current = true; setMode(next); if (next === "set") requestAnimationFrame(() => hoursRef.current?.focus()); };
  const setLimit = (key: keyof Limits, value: string) => { touched.current = true; setLimits((current) => ({ ...current, [key]: value })); };
  const workerRoles = useMemo(() => roles.filter((role) => role.kind === "worker"), [roles]);
  const kept = drafts.filter((draft) => !edits[draft.id]?.dropped);
  const used = liveSessions(local.sessions).length;
  // 对话里说的模型要求（第 69 条）：每张卡带着它那一批的原话（再拆一次时同一张单里会有两批），各自和这台电脑连着的来源对；
  // 对上了那一批的卡照它预选，对不上的在单子顶上按原话各写一行「没找到」、那一批用自动。
  const saidKey = JSON.stringify([...new Set(drafts.map((draft) => draft.modelWords).filter((words): words is string => !!words))]);
  const said = useMemo(() => new Map(local.models.length ? (JSON.parse(saidKey) as string[]).map((words) => [words, matchModelWords(words, local.models)] as const) : []),
    [saidKey, local.models]);
  const wordsOf = (draft: TCardDraftView) => { const found = draft.modelWords ? said.get(draft.modelWords) : undefined; return found?.matched ? found : null; };
  /** 这一步的模型、思考（draftPick）。 */
  const pickedModel = (draft: TCardDraftView) => draftPick(edits[draft.id], wordsOf(draft)).modelId;
  const pickedEffort = (draft: TCardDraftView) => draftPick(edits[draft.id], wordsOf(draft)).effort;
  const roleOf = (draft: TCardDraftView) => { const edit = edits[draft.id]; return edit && "role" in edit ? edit.role ?? null : draftWorkerRole(draft); };
  const tierOf = (draft: TCardDraftView, role: CardRole | null) => roles.find((entry) => entry.id === role?.id)?.modelTier ?? draft.modelTier;
  const modelOf = (draft: TCardDraftView): TLocalModelProfile | null => {
    const role = roleOf(draft);
    if (!role) return null;
    return local.models.find((model) => model.id === pickedModel(draft)) ?? modelForTier(local.models, tierOf(draft, role));
  };
  /** 这一步选的思考程度（36 条）：要在它的模型支持的几档里，不然算自动（null）。 */
  const effortOf = (draft: TCardDraftView, model: TLocalModelProfile | null): TLocalEffort | null => {
    const picked = pickedEffort(draft);
    return picked && model?.efforts?.includes(picked) ? picked : null;
  };
  const edit = (id: string, patch: Edit) => setEdits((current) => applyEdit(current, id, patch));
  // 每一步会落到哪个来源的哪个模型（开工前问本机 previewRun）：按「模型配置 · 档位」记，同样的只问一次。
  const [previews, setPreviews] = useState<Record<string, { model: string | null; source: string | null; harness: TLocalAgentKind }>>({});
  const asked = useRef(new Set<string>());
  const previewKey = (model: TLocalModelProfile, tier: string, effort: TLocalEffort | null) => `${model.id}:${tier}:${effort ?? ""}`;
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    for (const draft of drafts) {
      const role = roleOf(draft);
      const model = modelOf(draft);
      if (!role || !model) continue;
      const tier = tierOf(draft, role);
      const effort = effortOf(draft, model);
      const key = previewKey(model, tier, effort);
      if (asked.current.has(key)) continue;
      asked.current.add(key);
      void local.runner.previewRun({ agent: model.agent, modelProfileId: model.id, modelTier: tier, ...(effort ? { effort } : {}) }).then((run) => {
        const name = run.actual?.modelName ?? run.modelName ?? null;
        if (alive) setPreviews((current) => ({ ...current, [key]: { model: name, source: run.origin?.label ?? run.sourceLabel ?? null, harness: run.harness ?? model.agent } }));
      }, () => asked.current.delete(key));
    }
    return () => { alive = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 草稿、改过的岗位和模型变了才再问
  }, [ready, local.runner, local.models, drafts, edits, roles]);
  /**
   * 胶囊上写的（67 条）：「来源 · 模型」，思考在旁边的胶囊；没单独选时模型写「自动」，订阅读不到模型名只写来源；执行方在悬停里（见 pickLabel）。
   * 本机开工前算出来的（previewRun）优先；还没回（或老版本不报）时照模型配置写。
   */
  const modelText = (draft: TCardDraftView, model: TLocalModelProfile, role: CardRole, auto: boolean) => {
    const preview = previews[previewKey(model, tierOf(draft, role), effortOf(draft, model))];
    return pickLabel({ harness: preview?.harness ?? model.agent, model: preview?.model ?? (model.model ? profileModel(model) : null),
      source: preview?.source ?? profileSource(model), subscription: model.source === "subscription" }, auto);
  };

  // 项目没绑文件夹时点了开始：先问在哪个文件夹开工。
  const [asking, setAsking] = useState(false);
  const start = async (chosen?: { id: string; path: string; label: string }) => {
    if (!kept.length || busy) return;
    // 设预算却一项都没填对：停在填的地方。
    const budget = taskId ? budgetOf(mode, limits) : null;
    if (taskId && !budget) { hoursRef.current?.focus(); return; }
    const where = chosen ?? folder;
    if (ready && !where) { setAsking(true); return; }
    setBusy(true);
    try {
      for (const draft of drafts.filter((entry) => edits[entry.id]?.dropped)) await dismissDraft(draft.id).catch(() => undefined);
      // 换过岗位的随放进看板一起记到卡上（没有岗位的是人自己的活）。
      // 这台电脑能开就马上开（带上每张卡选的模型）；开不了（手机、本机没连）就登记要开工，配对的电脑上开着的网页认领后开（第 4.4 节）。
      const picked = kept.map((draft) => {
        const role = roleOf(draft);
        const changed = (role?.id || null) !== (draftRole(draft)?.id ?? null);
        return { id: draft.id, ...(edits[draft.id]?.title?.trim() ? { title: edits[draft.id]!.title!.trim() } : {}), ...(changed ? { roleId: role?.id || null } : {}) };
      });
      const cards = taskId ? await acceptDrafts(taskId, picked, !(ready && where), touched.current && budget ? budget : undefined, afterSequence)
        : await acceptProjectDrafts((target as { projectId: string }).projectId, picked, !(ready && where), afterSequence);
      const plans: StartPlan[] = kept.flatMap((draft, index) => {
        const item = cards[index];
        const role = roleOf(draft);
        const model = modelOf(draft);
        return item && role && model ? [{ item, model, cwd: where?.path ?? "", role: roles.find((entry) => entry.id === role.id) ?? null, ...(projectMode ? { permissionMode: projectMode } : {}), effort: effortOf(draft, model) }] : [];
      });
      if (ready && where) {
        await startBatch(local.runner, plans);
        await local.refresh();
      }
      setEdits({});
      setEditing(false);
      onChanged();
    } finally {
      setBusy(false);
    }
  };

  const agents = kept.filter((draft) => roleOf(draft)).length;
  // 设预算只出这次计划用得到的那几项（11.3）：用订阅的出本周额度，用 TokenHub 的出金额；还不知道用哪个模型时只出本周额度。
  const sources = new Set(kept.flatMap((draft) => { const model = modelOf(draft); return model ? [model.source] : []; }));
  const subscription = sources.has("subscription") || !sources.size;
  const gateway = sources.has("gateway");
  const steps = (
    <>
    {[...said].filter(([, found]) => !found.matched).map(([words]) => (
      <p key={words} className={h.stepSum} title={words} data-testid="model-words-missing">没找到「{words.length > 24 ? `${words.slice(0, 23)}…` : words}」</p>
    ))}
    <ol className={h.steps}>
      {kept.map((draft, index) => {
        const role = roleOf(draft);
        const model = modelOf(draft);
        return (
          <li key={draft.id} data-testid="plan-step">
            <span className={h.stepNo}>{index + 1}.</span>
            <span className={h.stepMain}>
              {editing ? <input value={edits[draft.id]?.title ?? draft.title} maxLength={120} aria-label="这一步" onChange={(event) => edit(draft.id, { title: event.target.value })} />
                : <span className={h.stepTitle}>{edits[draft.id]?.title ?? draft.title}</span>}
              <span className={h.stepMeta}>{[role?.name ?? "我自己", draft.criterionIndex ? `约定第 ${draft.criterionIndex} 条` : null].filter(Boolean).join(" · ")}</span>
              <SourceWords words={draft.sourceWords} className={h.stepWords} />
            </span>
            <span className={h.stepSide}>
              {editing ? <>
                <Pick label={role?.name ?? "我自己"} value={role?.id || "self"}
                  options={[...workerRoles.map((entry) => ({ id: entry.id, label: entry.name })), { id: "self", label: "我自己" }]}
                  onPick={(id) => edit(draft.id, { role: id === "self" ? null : { id, name: workerRoles.find((entry) => entry.id === id)!.name, kind: "worker" }, modelId: undefined })} />
                <button type="button" className={h.icon} aria-label={`去掉「${draft.title}」`} title="删除" onClick={() => edit(draft.id, { dropped: true })}><X {...ICON} /></button>
              </> : role ? (local.models.length && model ? <ModelPick models={local.models} value={pickedModel(draft) ?? AUTO_MODEL}
                  shown={modelText(draft, model, role, !pickedModel(draft))}
                  auto={(() => { const fallback = modelForTier(local.models, tierOf(draft, role)); return fallback ? modelText(draft, fallback, role, false).label : null; })()}
                  onPick={(id) => {
                    // 换了模型：原来选的思考程度新模型不支持就回到自动。
                    const next = id === AUTO_MODEL ? modelForTier(local.models, tierOf(draft, role)) : local.models.find((entry) => entry.id === id);
                    edit(draft.id, modelPickPatch(id, next, pickedEffort(draft)));
                  }} />
                : <span className={h.chip}>{TIER_LABEL[tierOf(draft, role)]}</span>) : null}
              {role && model?.efforts?.length && !editing ? <Pick label={effortText(effortOf(draft, model))} value={effortOf(draft, model) ?? ""}
                options={[{ id: "", label: effortText(null) }, ...model.efforts.map((entry) => ({ id: entry, label: effortText(entry) }))]}
                onPick={(id) => edit(draft.id, { effort: id === "none" ? undefined : id as TLocalEffort })} /> : null}
            </span>
          </li>
        );
      })}
    </ol>
    {agents ? <p className={h.stepSum}>{agents} 个子会话</p> : null}
    {taskId ? <div className={x.mode} data-testid="plan-mode">
      <SegmentedSwitch label="预算" segments={MODES} selected={mode} onSelect={pickMode} />
      {mode === "set" ? (
        <span className={x.limits}>
          <label><input ref={hoursRef} inputMode="decimal" value={limits.hours} aria-label="时长上限（小时）" onChange={(event) => setLimit("hours", event.target.value)} />小时</label>
          {subscription ? <label><input inputMode="numeric" value={limits.percent} aria-label="本周额度上限（百分比）" onChange={(event) => setLimit("percent", event.target.value)} />% 本周额度</label> : null}
          {gateway ? <label>¥<input inputMode="decimal" value={limits.money} aria-label="TokenHub 金额上限" onChange={(event) => setLimit("money", event.target.value)} />TokenHub</label> : null}
        </span>
      ) : null}
    </div> : null}
    </>
  );
  const footer = ready ? <>
    {/* 同输入框下面：项目在这台电脑上绑了只写名字，没绑才给下拉。 */}
    {folder ? <FolderText name={folder.label} title={folder.path} /> : onSetFolder ? <FolderMenu folders={local.folders} onPick={(id) => void onSetFolder(id)} onPickOther={onPickFolder} onCreate={onCreateFolder} /> : null}
    <span className={h.grow} />
    <span className={h.slotsLine}>本机 <Slots used={used} cap={SLOT_CAP} /> {used}/{SLOT_CAP}</span>
  </> : null;

  return (
    <>
      <DecisionBox kind="plan" testId="plan-decision" title={`${name}：这样开工？`} body={steps} busy={busy} footer={footer}
        options={editing ? [{ label: START_LABEL, recommended: true }, { label: "改好了" }] : [{ label: START_LABEL, recommended: true }, { label: "改一改" }]}
        onPick={([picked]) => (picked === 0 ? start() : setEditing(!editing))}
        // 管线正在回话时发不出去（send 回 false）：算失败，框里原处写「失败 · 重试」，打的字留着。
        other={{ onSubmit: async (text) => { if ((await onSay(text)) === false) throw new Error("没发出去"); } }} />
      {asking && ready && !folder ? (
        <FolderAsk folders={local.folders} onPickOther={() => local.pickFolder()}
          onBind={async (picked) => { await onSetFolder?.(picked.id); setAsking(false); await start(picked); }} />
      ) : null}
    </>
  );
}

/**
 * 选模型（21 条）：「自动」在最上面、写明落到哪一个；下面按执行方分组（Claude Code、Codex），每行写模型名，后面淡色写来源，如「Opus 5.5 · 我的 Claude 订阅」「GPT-6.1 · Codex 订阅 · 经 magpie」。
 * 胶囊上写「来源 · 模型」（自动时「来源 · 自动」），太长出省略号、下拉箭头始终在；悬停是全称（执行方 · 模型 · 来源）。
 */
function ModelPick({ models, value, shown, auto, onPick }: {
  models: TLocalModelProfile[]; value: string; shown: { label: string; title: string }; auto: string | null; onPick: (id: string) => void;
}) {
  const mark = (id: string) => (id === value ? <Check {...ICON} /> : null);
  const groups = (Object.keys(HARNESS_NAME) as (keyof typeof HARNESS_NAME)[]).map((agent) => ({ agent, list: models.filter((model) => model.agent === agent) })).filter((group) => group.list.length);
  return (
    <Dropdown>
      <Dropdown.Trigger className={h.chip} aria-label={`模型：${shown.title}`} data-testid="model-pick"><span title={shown.title}>{shown.label}</span><ChevronDown {...ICON} /></Dropdown.Trigger>
      <Dropdown.Popover placement="bottom end" offset={8} className={h.pop}>
        <Dropdown.Menu aria-label="模型" className={h.menuList} onAction={(key) => onPick(String(key))}>
          <Dropdown.Section className={h.menuSection}>
            <Dropdown.Item key={AUTO_MODEL} id={AUTO_MODEL} textValue="自动" className={h.menuItem}>
              <span className={h.grow}>自动{auto ? <span className={h.menuFaint}> · {auto}</span> : null}</span>{mark(AUTO_MODEL)}
            </Dropdown.Item>
          </Dropdown.Section>
          {groups.map((group) => (
            <Dropdown.Section key={group.agent} className={h.menuSection}>
              <Header className={h.menuHeader}>{HARNESS_NAME[group.agent]}</Header>
              {group.list.map((model) => (
                <Dropdown.Item key={model.id} id={model.id} textValue={`${profileSource(model)} ${profileModel(model)}`} className={h.menuItem} data-testid="model-option">
                  <span className={h.grow}><span className={h.menuFaint}>{sourceName(profileSource(model))} · </span>{profileModel(model)}</span>{mark(model.id)}
                </Dropdown.Item>
              ))}
            </Dropdown.Section>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/** 一个小下拉：点开是弹层（全站唯一那种），当前那项行尾打勾。 */
function Pick({ label, options, value, onPick }: { label: string; options: { id: string; label: string }[]; value: string; onPick: (id: string) => void }) {
  return (
    <Dropdown>
      <Dropdown.Trigger className={h.chip}><span title={label}>{label}</span><ChevronDown {...ICON} /></Dropdown.Trigger>
      <Dropdown.Popover placement="bottom end" offset={8} className={h.pop}>
        <Dropdown.Menu aria-label={label} className={h.menuList} onAction={(key) => onPick(String(key))}>
          {options.map((option) => (
            <Dropdown.Item key={option.id || "none"} id={option.id || "none"} textValue={option.label} className={h.menuItem}>
              <span className={h.grow}>{option.label}</span>{option.id === value ? <Check {...ICON} /> : null}
            </Dropdown.Item>
          ))}
        </Dropdown.Menu>
      </Dropdown.Popover>
    </Dropdown>
  );
}

/** 规划员在拆：一行「拆卡中 · 第 2/3 步」；排着时写在等什么。 */
export function plannerText(planner: Worker, step: { step: number; total: number } | null): string {
  if (planner.state === "queued") return `拆卡 · ${QUEUE_LABEL[planner.reason ?? "start"]}`;
  return step ? `拆卡中 · 第 ${step.step}/${step.total} 步` : "拆卡中";
}

/** 规划员在拆：一行进度；它要权限、问你时，选项框就接在这一行下面（只有这台电脑上能答）。 */
export function PlanningLine({ planner }: { planner: Worker }) {
  const local = useLocalRunner();
  const handheld = useHandheld();
  const session = planner.state === "doing" ? planner.session : null;
  const { view } = useSessionEvents(local.runner, session?.id ?? null);
  const step = planStep(view.plan) ?? (planner.step ? { step: planner.step.n, total: planner.step.total } : null);
  const blocked = canCommandHere(planner, local.phase === "ready", handheld) ? null : awayChip(planner.device);
  // 连上事件流以后只认事件流（答过、作废了就是没有），还没连上时照会话摘要。
  const question = session ? (view.lastSeq ? view.question : session.pendingQuestion ?? null) : null;
  return (
    <>
      <p className={h.line} data-testid="planning-line"><StateIcon state={planner.state === "queued" ? "queued" : "running"} />{plannerText(planner, step)}</p>
      {session && view.pending.length ? (
        <ApprovalDecision requests={view.pending} blocked={blocked} onDecide={(request, decision, { forSession, message }) => local.runner.decidePermission(session.id, request.requestId,
          { decision, ...(forSession ? { allowForSession: true } : {}), ...(message ? { message } : {}) })} />
      ) : null}
      {session && question ? (
        <QuestionDecision key={question.requestId} request={question} blocked={blocked}
          onAnswer={(body) => local.runner.answerQuestion(session.id, question.requestId, body).then(() => local.refresh())} />
      ) : null}
    </>
  );
}

const WAIT_TEXT: Record<string, string> = { approval: "等你批准", question: "等你回复", verdict: "受阻", merge: "等你合回" };
/** 事件行的阶段（5.6 状态词）。 */
export function subStage(sub: SubSession): string {
  switch (sub.state) {
    case "queued": return subQueueText(sub)!;
    // 停下了、没在问你：一轮做完的「做完一轮」，真停了的「已停下」（契约 aa6aba9e、stopWhy）；第一次验收没过是进行中的「重做中」（5.4.2），不是失败。
    case "waiting": return sub.waiting ? WAIT_TEXT[sub.waiting] ?? "等你" : stoppedLabel(sub);
    case "done": return "已完成";
    case "failed": return "重做中";
    default: return "进行中";
  }
}

/**
 * 开了以后（5.4.3「事件行」）：开工的选项框收成一行（勾 · 问题 · 就按这个开始），下面是开出的子会话，一行一个（和左栏同样式、带竖线）：
 * 状态图标 · 名字 · 阶段，原地跟着状态变；子会话要批准、提问时这一行写「等你批准」，点了进子会话去答（选项框不在两处各画一遍）。
 */
export function StartedRecord({ task, subs, onOpen }: { task: string; subs: SubSession[]; onOpen: (sub: SubSession) => void }) {
  return (
    <div className={h.started} data-testid="started-record">
      <p className={h.resolvedLine}><Check {...ICON} /><span className={h.resolvedQ}>{task}：这样开工？</span><span className={h.resolvedA}>{START_LABEL}</span></p>
      <ul className={h.eventList}>
        {subs.map((sub) => (
          <li key={sub.id}>
            <button type="button" className={h.event} onClick={() => onOpen(sub)} data-state={sub.state}>
              <StateIcon {...subIcon(sub)} /><span className={h.eventName}>{sub.title}</span><span className={h.eventStage}> · {subStage(sub)}</span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
