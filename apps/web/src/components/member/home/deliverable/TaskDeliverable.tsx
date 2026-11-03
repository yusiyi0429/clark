"use client";

/**
 * 首页选中一个 Task 后右边的交付物面板（spec 5.3；样子见 .scratch/next-phase/Task页面样子_2026-10-29.html，10/29 晚改：叫「交付」、少框）。
 * 11/03 定：评审只作参考——不卡交付、不当进展，收成一行「参考评审」，点开才看圆环、结论和逐条。
 * 从上到下：负责人和按什么评一行 → 材料和 Task 对不上时的一句提醒 → 验收标准（点开参考评审时带逐条判定）→ 交付物（版本、材料）
 * → 交付以后伙伴写的说明 → 动作（传新版本、说说现状、交付）→ 展开的「我的事项」和新建。
 * 只有能改的人（负责人；本体没登记负责人时是 Mission 负责人，服务端给 canEdit）看得到动作。
 */
import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import type { THomePlanTask } from "@warmap/contracts";
import { avatarInitial } from "@/components/AccountMenu";
import { useTaskDeliverable } from "./useTaskDeliverable";
import { ReviewHeader } from "./ReviewHeader";
import { CriteriaList } from "./CriteriaList";
import { VersionItems } from "./VersionItems";
import { DeliverableComposer } from "./DeliverableComposer";
import { VersionNote } from "./VersionNote";
import d from "@/styles/task-deliverable.module.css";

type Composer = "files" | "statement" | null;

export function TaskDeliverable({ task, activities, activityCount, newItem }: {
  task: THomePlanTask;
  /** 这个 Task 下的执行事项三栏，放在底部，默认展开。 */
  activities: ReactNode;
  activityCount: number;
  /** 「我的事项」那一行右边的新建键。 */
  newItem?: ReactNode;
}) {
  const api = useTaskDeliverable(task.taskId);
  const [picked, setPicked] = useState<string | null>(null);
  const [composer, setComposer] = useState<Composer>(null);
  const [itemsOpen, setItemsOpen] = useState(true);
  const [referenceOpen, setReferenceOpen] = useState(false);
  const [delivering, setDelivering] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const data = api.data;

  const items = (
    <div className={d.fold}>
      <div className={d.foldHead}>
        <button type="button" className={d.foldToggle} aria-expanded={itemsOpen} onClick={() => setItemsOpen((open) => !open)}>
          <ChevronRight size={14} aria-hidden="true" />我的事项 {activityCount}
        </button>
        {newItem}
      </div>
      {itemsOpen && activityCount > 0 ? <div className={d.foldBody}>{activities}</div> : null}
    </div>
  );

  if (!data) {
    return <div className={d.panel} aria-busy={!api.error}>{api.error ? <p className={d.error} role="alert">{api.error}</p> : <div className={d.loading} aria-hidden="true" />}{items}</div>;
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
  const deliver = async () => {
    if (!latest) return;
    setDelivering(true);
    setError(result(await api.deliver(latest.id)));
    setDelivering(false);
  };

  return (
    <div className={d.panel}>
      <p className={d.facts}>
        <span className={d.owner} data-missing={data.responsibleName ? undefined : true}>
          {data.responsibleName ? <i aria-hidden="true">{avatarInitial(data.responsibleName)}</i> : null}
          {data.responsibleName ?? "负责人未登记"}
        </span>
        <span>{source}</span>
      </p>

      {data.basis !== "none" ? <>
        {selected?.review.mismatch ? <p className={d.mismatch} role="status">{selected.review.mismatch}</p> : null}

        {referenceLabel ? (
          <button type="button" className={d.referenceToggle} aria-expanded={referenceOpen} onClick={() => setReferenceOpen((open) => !open)}>
            <ChevronRight size={14} aria-hidden="true" />参考评审 · {referenceLabel}
          </button>
        ) : null}
        {referenceOpen && selected && shown ? (
          <ReviewHeader version={selected} basis={data.basis} criteriaCount={data.criteria.length} canEdit={data.canEdit && onLatest}
            onRetry={() => void api.retry(selected.id).then((value) => setError(result(value)))} />
        ) : null}

        <CriteriaList title={data.basis === "definition" ? "完成定义" : "验收标准"} texts={selected?.review.criteria.length ? selected.review.criteria.map((row) => row.text) : data.criteria}
          results={referenceOpen && selected?.review.criteria.length ? selected.review.criteria : null}
          canDissent={referenceOpen && data.canEdit && onLatest && !selected?.deliveredAt}
          onDissent={async (index, reason) => (selected ? result(await api.dissent(selected.id, index, reason)) : null)} />

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
            <button type="button" className={d.plain} onClick={() => { setComposer("files"); setPicked(null); }}>上传新版本</button>
            <button type="button" className={d.plain} onClick={() => { setComposer("statement"); setPicked(null); }}>说说现状</button>
            <span className={d.grow} />
            {!latest.deliveredAt ? <>
              {reviewing ? <span className={d.hint}>参考评审中</span> : null}
              <button type="button" className={d.primary} disabled={reviewing || delivering} onClick={() => void deliver()}>{delivering ? "正在交付…" : "交付"}</button>
            </> : null}
          </div>
        ) : null}
      </> : null}

      {error ? <p className={d.error} role="alert">{error}</p> : null}
      {items}
    </div>
  );
}
