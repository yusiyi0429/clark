"use client";

import { useState } from "react";

import { ALL_ISSUES, ConsoleShell } from "@/components/agenda/console-shell";
import { DeployedPane } from "@/components/agenda/deployed-pane";
import { DeploymentDetail, DeploymentEmpty } from "@/components/agenda/deployment-detail";
import { api } from "@/lib/data/client";
import type { DeploymentDetail as Detail, DomainSummary, IssueSummary } from "@/lib/data/types";
import { useResource } from "@/lib/use-resource";

/**
 * 已部署 —— **和战略议题那一屏是同一个壳，只换右边那一块。**
 *
 * 右边缘那两颗点之间的切换是一次左右移动，不是一次跳页：左边那一列（雷达、八块生意、
 * 字标）一个像素都不动，所以两屏共用 `ConsoleShell`。各写一份的话它们会慢慢漂开，
 * 而任何一处不一致都会被读成「页面跳了一下」。
 *
 * ## 域的选中态不跨屏带过来
 *
 * 他在战略议题那屏选的是「此刻要处理哪一块」，在这一屏问的是「这一块已经交出去几件」——
 * 是两个问题。带过来会让他在这一屏开局就被筛掉大半，而且那个筛子不是他为这一屏设的。
 * 所以这一屏自己从「所有议题」起。
 */
export function DeployedView() {
  const issuesRes = useResource<IssueSummary[]>("issues", () => api.listIssues());
  const domainsRes = useResource<DomainSummary[]>("domains", () => api.listDomains());
  const [domainId, setDomainId] = useState(ALL_ISSUES);

  const issues = issuesRes.data ?? [];
  const domains = domainsRes.data ?? [];

  /* 口径和首页那一处必须一模一样（`home-view` 的 `deployedCount`）：交出去还在跑的算，
     彻底完了的（`Closed` / `Dismissed`）不算 —— 那一档的价值只是可查，不占这一屏。 */
  const deployed = issues.filter(
    (i) => i.settled && i.state !== "Closed" && i.state !== "Dismissed",
  );
  const inDomain =
    domainId === ALL_ISSUES ? deployed : deployed.filter((i) => i.domainId === domainId);

  /*
   * 右半边摊开的是哪一件。**默认是这一列的第一件** —— 一进来右边就空着的话，这一屏
   * 有一半在说「这里什么都没有」，而它其实只是在等他先点一下。
   *
   * 切域之后选中的那一件可能不在新的这一列里了（`inDomain` 变了）：那时自动落回新列
   * 的第一件，而不是留着一个不在屏幕上的选中态 —— 那会让右半边摊着一件左边找不到的
   * 议题，而他没法退回去。
   */
  const [picked, setPicked] = useState<string | null>(null);
  const selectedId = picked && inDomain.some((i) => i.id === picked)
    ? picked
    : (inDomain[0]?.id ?? null);
  const selected = inDomain.find((i) => i.id === selectedId);

  const detail = useResource<Detail | null>(
    selectedId ? `deployment:${selectedId}` : "deployment:none",
    () => (selectedId ? api.getDeployment(selectedId) : Promise.resolve(null)),
  );

  return (
    <ConsoleShell
      current="deployed"
      domains={domains}
      domainId={domainId}
      onPickDomain={setDomainId}
      /* 左栏那一列的每一个数都**仍然是在办的那个数**，不是这一屏的条数：那一列问的是
         「我手上还有几件事」，它在两屏之间不该跟着变 —— 变了的话，切一下屏那些数就成了
         另一个含义，而屏幕上没有任何一处说明它们换了口径。所以两屏都把全量交给壳，
         由壳一处算完（见 `ConsoleShell`）。 */
      issues={issues}
    >
      {/*
       * 和另外两屏同一块托盘、同一条中缝（首页是「议题 | 待确认纪要」，编排是
       * 「议题 | 这一天」）。呈现区永远是两半 —— 从右边缘那两颗点走过来的那一下是一次
       * 左右移动，换一套几何会读成跳到了另一个产品。
       */}
      <section className="grid h-full grid-cols-2 divide-x divide-hairline overflow-hidden rounded-2xl bg-list-ground [--r:1rem]">
        <DeployedPane
          issues={inDomain}
          domains={domains}
          domainId={domainId === ALL_ISSUES ? null : domainId}
          loading={issuesRes.isLoading}
          selectedId={selectedId}
          onSelect={setPicked}
        />

        {selected ? (
          <DeploymentDetail
            detail={detail.data ?? null}
            issueId={selected.id}
            title={selected.title}
            domainName={domains.find((d) => d.id === selected.domainId)?.name}
            monitoringNote={selected.monitoringNote ?? undefined}
          />
        ) : (
          <DeploymentEmpty
            note={
              domainId === ALL_ISSUES
                ? "现在没有已部署的议题。"
                : "这个域下没有已部署的议题。"
            }
          />
        )}
      </section>
    </ConsoleShell>
  );
}
