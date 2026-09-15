"use client";

import { AsyncBoundary } from "@/components/async-boundary";
import { DebriefColumn } from "@/components/agenda/debrief-column";
import { api } from "@/lib/data/client";
import type { DomainSummary, IssueSummary, MeetingSlot } from "@/lib/data/types";
import { useResource } from "@/lib/use-resource";

/**
 * 纪要审阅 —— 秘书那一侧的整页。
 *
 * ## 它是把首页右栏那一叠搬了过来，不是重做一份
 *
 * 同一件事在屏幕上只该有一套做法：按会分组、摞着、展开才铺开、两颗键（无需再议 /
 * 还需再议）。所以这一页直接用 `DebriefColumn`，一行都不抄。它本来就是自足的——
 * 判据只有 `debrief` 一个，外面传一份「全部的」还是一份「会开完的」都不影响它的内容。
 *
 * ## 为什么审纪要在这一侧
 *
 * 「这场会谈拢了没有、要不要再开一次」是一个读完材料就能判的事实问题，不是一次拍板。
 * 摆在一号位面前，他每天要先从一堆不用他管的事里把要拍板的那几件挑出来 —— 而挑
 * 这一下正是这个系统本来要替他省掉的东西。
 *
 * ## 全集在这一页，子集在他那一屏
 *
 * 一号位首页那块动态面板（`DynamicPanel`）只摊两样：要他拍板的，和会上点了他名的。
 * 那是**故意的子集** —— 别的都不进他那一屏，他才不必每天先挑一遍。
 *
 * 代价是他那一屏上有个结构性的窟窿：**一条谁也没接的待办，和一条本来就不该给他看的
 * 待办，在那儿长得一模一样 —— 都是不在。** 于是「有没有哪一条掉在了地上」这个问题，
 * 在他那一屏上根本问不出来。
 *
 * 这一页补的就是这个：**它摊的是全集**，上面那个 `filter` 只滤掉「还没有提炼」的议题
 * （那些议题一条待办都还不存在），凡是提炼出来的，它的每一条待办都在这一屏上，一条
 * 不滤。再给每一条标上它去了哪儿（`showTodoDestination`，做法在 `todoDestination`），
 * 「没人接」的那几条才和「已经派出去」的那几条在屏幕上分得开 —— 这条链路「一条都不许
 * 丢」的保证，到这一步才成为一件秘书当场核得动的事，而不是一句没人能核对的话。
 *
 * ## 那一栏要一个有界高度的父块
 *
 * `DebriefColumn` 自己是 `grid-rows-[auto_minmax(0,1fr)]`，里面那一格靠
 * `overflow-y-auto` 滚。父块不给高度的话它会一直长，页面整体滚 —— 那时抬头那一行
 * 会跟着滚走，而他正是靠抬头认出「这几张是同一场会」的。
 *
 * **这个高度不写成一个算出来的常数。** 上一版这里是 `h-[calc(100vh-11rem)]`——
 * 那个 `11rem` 是把外壳顶栏、这一页自己的 `py-6`、标题行全部量出来再加总的结果，
 * 而这几层里任何一处的内边距、字号、行高只要改一个数，这个总和就悄悄错了：多出
 * 一截空白，或者页面整体又能滚——两种坏法都不像布局问题，反而像别的什么东西坏了。
 * 所以这里改成让 flex 自己去量：外壳（`SecLayout`）给一整屏高度，这一页和这个区块
 * 各自只占「剩下的那一份」（`flex-1` 配 `min-h-0`），谁改了上面量多少都不用回来
 * 改这个数字。
 */
export function SecDebriefsView() {
  const issuesRes = useResource<IssueSummary[]>("issues", () => api.listIssues());
  const slotsRes = useResource<MeetingSlot[]>("slots", () => api.listSlots());
  const domainsRes = useResource<DomainSummary[]>("domains", () => api.listDomains());

  const refresh = async () => {
    await Promise.all([issuesRes.mutate(), slotsRes.mutate()]);
  };

  return (
    /*
     * 没有这一页自己的 `<h1>`。原来这里写着「待审的会议纪要」，`DebriefColumn` 紧接着
     * 又渲染一遍自己的「待确认的会议纪要」——16px 之内堆两个几乎同义的标题，加上导航
     * 里这条路叫「纪要审阅」，一个页面同时挂着三个名字。`DebriefColumn` 是和一号位
     * 首页共用的组件，它自己的表头不能动；能删的是这一层多出来的那个。
     *
     * 删掉之后 flex 链条不用补：`AsyncBoundary` 只透传 `children(data)`，不额外包一层
     * 容器（见 `async-boundary.tsx`），所以 `<section>` 现在是这个 `flex-col` 容器
     * 唯一的子节点，`flex-1` 照样把外壳分给这一页的高度整段交给它。
     */
    <div className="mx-auto flex h-full w-full max-w-[900px] flex-col px-6 py-6">
      <AsyncBoundary resource={issuesRes} skeleton={<ColumnSkeleton />}>
        {(issues) => (
          <section className="grid min-h-0 flex-1 overflow-hidden rounded-2xl bg-list-ground [--r:1rem]">
            <DebriefColumn
              issues={issues.filter((i) => i.debrief)}
              slots={slotsRes.data ?? []}
              domains={domainsRes.data ?? []}
              today={api.today}
              onRefresh={refresh}
              /*
               * 这一页把「每条待办去了哪儿」那句标注打开。**只有这一页开** ——
               * 理由整段写在上面的「全集在这一页，子集在他那一屏」，以及
               * `todoDestination` 上。
               *
               * 开关握在页面这一层、不由 `DebriefColumn` 自己决定，是因为那一句
               * 成不成立取决于屏幕上摊的是不是全集，而全不全只有递数据的人知道：
               * 上面那个 `filter` 只滤掉「还没有提炼」的议题，凡是提炼出来的，它的
               * 每一条待办都在这一屏上，一条不少。
               */
              showTodoDestination
            />
          </section>
        )}
      </AsyncBoundary>
    </div>
  );
}

function ColumnSkeleton() {
  return (
    <div aria-live="polite" className="space-y-2 p-2">
      {[0, 1, 2].map((i) => (
        <div key={i} className="list-block concentric px-3.5 py-3">
          <span className="skeleton block h-2.5 w-24" />
          <span className="skeleton mt-2 block h-4 w-[82%]" />
        </div>
      ))}
    </div>
  );
}
