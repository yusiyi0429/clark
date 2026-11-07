"use client";

/**
 * 首页选中一个 Task 后右边的交付物面板（spec 5.3；样子见 .scratch/next-phase/Task页面样子_2026-10-29.html，10/29 晚改：叫「交付」、少框）。
 * 11/03 定：评审只作参考——不卡交付、不当进展，收成一行「参考评审」，点开才看圆环、结论和逐条。
 * 从上到下：负责人和按什么评一行 → 材料和 Task 对不上时的一句提醒 → 验收标准（点开参考评审时带逐条判定）→ 交付物（版本、材料）
 * → 交付以后伙伴写的说明 → 动作（传新版本、说说现状、交付）→ 展开的「我的事项」和新建。
 * 只有能改的人（负责人；本体没登记负责人时是 Mission 负责人，服务端给 canEdit）看得到动作。
 * 约定与对表（设计 V1 第 8 节，useTaskAgreement）：每条标准下面是约定，标题行有「对表」，结果标在每条上、结论在列表上面；
 * 对表开着时最新一版或它的评审变了就再对一次。checkOnOpen（从飞书链接进来）打开就对一次。
 * 别人的 Task（认可人、Mission 负责人、战场负责人、CEO 只读地看）不传 activities，就没有「我的事项」那一行。
 * 列表写本体当前的标准（标准改过以后也是新的那句），点开参考评审时才换成评审时的原文和逐条判定。
 */
import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight, LoaderCircle } from "lucide-react";
import type { THomePlanTask } from "@warmap/contracts";
import { avatarInitial } from "@/components/AccountMenu";
import { HeroButton } from "@/components/HeroButton";
import { PersonAvatar } from "@/components/avatar/PersonAvatar";
import { useTaskDeliverable } from "./useTaskDeliverable";
import { useTaskAgreement } from "./useTaskAgreement";
import { AgreementLine, BeyondScope, CheckLine, CheckSummary, Exclusions, agreementBody } from "./Agreement";
import { ReviewHeader } from "./ReviewHeader";
import { CriteriaList } from "./CriteriaList";
import { VersionItems } from "./VersionItems";
import { DeliverableComposer } from "./DeliverableComposer";
import { VersionNote } from "./VersionNote";
import d from "@/styles/task-deliverable.module.css";

const ICON = { size: 16, strokeWidth: 1.8 } as const;

type Composer = "files" | "statement" | null;

export function TaskDeliverable({ task, activities, activityCount = 0, newItem, checkOnOpen = false }: {
  task: Pick<THomePlanTask, "taskId">;
  /** 这个 Task 下的执行事项三栏，放在底部，默认展开；不传就没有「我的事项」那一行。 */
  activities?: ReactNode;
  activityCount?: number;
  /** 「我的事项」那一行右边的新建键。 */
  newItem?: ReactNode;
  /** 打开就对一次表（从飞书「请 X 看」的链接进来）。 */
  checkOnOpen?: boolean;
}) {
  const api = useTaskDeliverable(task.taskId);
  const pact = useTaskAgreement(task.taskId);
  const [picked, setPicked] = useState<string | null>(null);
  const [composer, setComposer] = useState<Composer>(null);
  const [itemsOpen, setItemsOpen] = useState(true);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [delivering, setDelivering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = api.data;
  const latestVersion = data?.versions[0] ?? null;
  // 对表跟着最新一版走：换了一版、评审跑完、交付或撤回，结果就过时了。
  const latestKey = latestVersion ? `${latestVersion.id}:${latestVersion.review.status}:${latestVersion.deliveredAt ?? ""}` : "";
  const { runCheck } = pact;
  const checkShown = pact.check !== null;
  useEffect(() => { if (checkOnOpen) void runCheck(); }, [checkOnOpen, runCheck]);
  useEffect(() => { if (checkShown) void runCheck(); }, [latestKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = activities === undefined ? null : (
    <div>
      <div className={d.foldHead}>
        <button type="button" className={d.foldToggle} aria-expanded={itemsOpen} onClick={() => setItemsOpen((open) => !open)}>
          <ChevronRight {...ICON} aria-hidden="true" />我的事项 {activityCount}
        </button>
        {newItem}
      </div>
      {itemsOpen && activityCount > 0 ? <div className={d.foldBody}>{activities}</div> : null}
    </div>
  );

  if (!data) {
    return <div className={d.panel} data-plan-task={task.taskId} aria-busy={!api.error}>{api.error ? <p className={d.error} role="alert">{api.error}</p> : <div className={d.loading} role="status" aria-label="加载中"><LoaderCircle {...ICON} aria-hidden="true" /></div>}{items}</div>;
  }

  const latest = data.versions[0] ?? null;
  const selected = data.versions.find((version) => version.id === picked) ?? latest;
  const onLatest = selected !== null && selected.id === latest?.id;
  const reviewing = latest?.review.status === "queued" || latest?.review.status === "running";
  const composing = data.canEdit && data.basis !== "none" && (composer !== null || !latest);
  const source = data.basis === "acceptance" ? `本体 · 验收标准 ${data.criteria.length} 条` : data.basis === "definition" ? "本体 · 完成定义" : "没有可对照的标准";
  const shown = selected && !selected.deliveredAt ? selected.review : null;
  const referenceLabel = !shown ? null : shown.status === "queued" || shown.status === "running" ? "评审中"
    : shown.status === "failed" ? "没评完" : shown.total ? `${shown.met}/${shown.total}` : null;

  const result = (problem: { ok: boolean; message?: string }) => (problem.ok ? null : problem.message ?? "没成功，请重试");
  const agreement = pact.agreement;
  const check = onLatest || !latest ? pact.check : null;
  const criterionOf = (index: number) => agreement?.criteria.find((row) => row.index === index) ?? null;
  const checkOf = (index: number) => check?.criteria.find((row) => row.index === index) ?? null;
  /** 对表后每条的圈：有证据（含要别人确认）是 ✓，差按最新一版评审的部分 / 未达到画。 */
  const markOf = (index: number) => {
    const row = checkOf(index);
    if (row?.status === "evidenced" || row?.status === "needs_acceptor") return "met" as const;
    if (row?.status === "gap") return latest?.review.criteria.find((item) => item.index === index)?.verdict === "partial" ? "partial" as const : "unmet" as const;
    return null;
  };
  const deliver = async () => {
    if (!latest) return;
    setDelivering(true);
    setError(result(await api.deliver(latest.id)));
    setDelivering(false);
  };

  return (
    <div className={d.panel} data-plan-task={task.taskId}>
      <p className={d.facts}>
        <span className={d.owner} data-missing={data.responsibleName ? undefined : true}>
          {data.responsibleName ? <PersonAvatar personId={data.responsibleId} className={d.ownerAvatar}>{avatarInitial(data.responsibleName)}</PersonAvatar> : null}
          {data.responsibleName ?? "负责人未登记"}
        </span>
        <span>{source}</span>
      </p>

      {data.basis !== "none" ? <>
        {selected?.review.mismatch ? <p className={d.mismatch} role="status">{selected.review.mismatch}</p> : null}

        {referenceLabel ? (
          <button type="button" className={d.referenceToggle} aria-expanded={referenceOpen} onClick={() => setReferenceOpen((open) => !open)}>
            <ChevronRight {...ICON} aria-hidden="true" />参考评审 · {referenceLabel}
          </button>
        ) : null}
        {referenceOpen && selected && shown ? (
          <ReviewHeader version={selected} basis={data.basis} criteriaCount={data.criteria.length} canEdit={data.canEdit && onLatest}
            onRetry={() => void api.retry(selected.id).then((value) => setError(result(value)))} />
        ) : null}

        <CriteriaList title={data.basis === "definition" ? "完成定义" : "验收标准"} texts={data.criteria}
          results={referenceOpen && selected?.review.criteria.length ? selected.review.criteria : null}
          canDissent={referenceOpen && data.canEdit && onLatest && !selected?.deliveredAt}
          onDissent={async (index, reason) => (selected ? result(await api.dissent(selected.id, index, reason)) : null)}
          tools={<>
            {agreement?.basisChanged ? <span className={d.changed}>标准改过</span> : null}
            <span className={d.grow} />
            <HeroButton variant="tertiary" size="sm" isDisabled={pact.checking} onPress={() => void runCheck()}>{pact.checking ? "对表中…" : "对表"}</HeroButton>
          </>}
          lead={<>
            {pact.checkError ? <p className={d.error} role="alert">{pact.checkError}</p> : null}
            {check ? <CheckSummary check={check} /> : null}
          </>}
          markOf={markOf}
          below={(index) => {
            const criterion = criterionOf(index);
            const row = checkOf(index);
            return <>
              {criterion && agreement ? <AgreementLine criterion={criterion} source={agreement.source} canEdit={agreement.canEdit}
                onSave={(proof, acceptorId) => pact.save(agreementBody(agreement, { index, proof, acceptorId }))} /> : null}
              {row && check ? <CheckLine row={row} canNotify={check.canNotify} asked={pact.asked.includes(index)} feishuOff={pact.feishuOff} onNotify={pact.notify} /> : null}
            </>;
          }}>
          {agreement ? <Exclusions items={agreement.exclusions} canEdit={agreement.canEdit} onSave={(exclusions) => pact.save(agreementBody(agreement, { exclusions }))} /> : null}
          {check ? <BeyondScope items={check.beyondScope} /> : null}
        </CriteriaList>

        {selected ? <VersionItems versions={data.versions} selected={selected} onPick={(id) => setPicked(id)} itemHref={api.itemHref} /> : null}

        {selected ? <VersionNote version={selected} canEdit={data.canEdit}
          onPatch={async (patch) => result(await api.patchNote(selected.id, patch))}
          onWithdraw={async () => result(await api.withdraw(selected.id))} /> : null}

        {composing ? (
          <DeliverableComposer key={latest?.id ?? "first"} previous={latest} startWithStatement={composer === "statement"}
            onCancel={latest ? () => setComposer(null) : null}
            onSubmit={async (input) => {
              const problem = result(await api.createVersion(input));
              if (!problem) { setComposer(null); setPicked(null); }
              return problem;
            }} />
        ) : null}

        {data.canEdit && latest && !composing ? (
          <div className={d.actions}>
            <HeroButton variant="tertiary" size="sm" onPress={() => { setComposer("files"); setPicked(null); }}>上传新版本</HeroButton>
            <HeroButton variant="tertiary" size="sm" onPress={() => { setComposer("statement"); setPicked(null); }}>说说现状</HeroButton>
            <span className={d.grow} />
            {!latest.deliveredAt ? (
              <HeroButton variant="primary" size="sm" isDisabled={reviewing || delivering} onPress={() => void deliver()}>{delivering ? "正在交付…" : "交付"}</HeroButton>
            ) : null}
          </div>
        ) : null}
      </> : null}

      {error ? <p className={d.error} role="alert">{error}</p> : null}
      {items}
    </div>
  );
}
