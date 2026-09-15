/**
 * 已部署那一屏右半边的内容 —— **这一份是示意数据，不是真账。**
 *
 * ## 为什么它单独一个文件，而且名字里带 mock
 *
 * 这个产品有一条硬规矩：不许假装能用。屏幕上每一个数、每一句话都要答得出自己怎么来的。
 * 而「一件已部署的议题对应哪一条 Mission」这层关系，**本体里现在还不存在** ——
 * `MissionCard` 挂在域上（`domainId` + `driId`），`Issue` 上没有任何一格指向它。
 *
 * 所以这一份分成两半，而且这两半在屏幕上要分得开：
 *
 *   **真的**   议题编号、标题、当时定的那一句（`monitoringNote`）、承接人的名字
 *              （域的 DRI，`findDomainDri` 那条口径）。它们都从对象库里取。
 *   **示意的** Mission 那一节、岗位、交接时刻、最近一次回话。它们是为了让这一屏的
 *              形状能被看见、被讨论而编的，`mocked` 那一格逐项点名，屏幕上照登。
 *
 * 单独一个文件是为了让它**删得掉**：这层关系接上之后，整个文件连同 `mocked` 那一格
 * 一起删，`getDeployment` 改成从本体读。混进 `seed-*.ts` 的话，将来没人分得清哪几行
 * 是当时为了看形状编的。
 *
 * ## 为什么是定死的，不是随机的
 *
 * 同一件议题每次打开必须看到同一份内容。随机生成的话，他刷新一次 Mission 就换了一条
 * —— 而那种画面会让人以为系统在瞎编（它确实在编，但编得前后不一致会让人以为**别处**
 * 也在编）。所以按议题编号取模，从下面这几条里挑一条：同一件议题永远是同一条。
 */
import type { DeploymentDetail, DomainSummary, IssueSummary } from "./types";

/**
 * 示意用的 Mission 池。
 *
 * 措辞照 `MissionCard` 那个形状写（`code` / `name` / `milestone`），也照公司真实纲领
 * 的口气写 —— 编一条读起来像玩具的（「完成 XX 功能开发」）会让这一屏看不出它将来
 * 长什么样，而这一屏存在的全部理由就是让人先看见形状。
 */
const MISSIONS: { code: string; name: string; milestone: string; status: DeploymentDetail["mission"] extends null ? never : "running" | "confirmed" | "pending" }[] = [
  {
    code: "04-2",
    name: "灯塔项目按正式商业项目交付，不按内部体验项目降标准",
    milestone: "本月内出完整工作计划与阶段交付物清单，与王总对齐迭代频率",
    status: "running",
  },
  {
    code: "04-3",
    name: "首版端到端形态成立：能力可以浅，但一条路要走通",
    milestone: "首版覆盖深度与验收口径落成文字，不再是未决事项",
    status: "pending",
  },
  {
    code: "05-1",
    name: "共同底座的每一项能力都说得出它解开灯塔的哪一个具体阻塞",
    milestone: "逐项对齐阻塞清单，说不出的先不投",
    status: "running",
  },
  {
    code: "05-4",
    name: "对外表达收敛到一个名称，材料不再同时用两个说法",
    milestone: "本轮客户材料全部换成同一口径",
    status: "confirmed",
  },
];

/** 示意用的岗位。真实岗位在本体里（六个岗位都写着「在位人待确认」），这一层不去猜。 */
const ROLES = ["产品负责人", "数据负责人", "交付负责人", "商业负责人"];

/** 按编号取一个稳定的下标 —— 同一件议题永远落在同一条上（见文件头）。 */
function seatOf(issueId: string): number {
  let n = 0;
  for (const ch of issueId) n = (n * 31 + ch.charCodeAt(0)) >>> 0;
  return n;
}

/**
 * 拼出这一件已部署议题的右半边。
 *
 * `domain` 可能没有：手动立的议题刚进来时确实没有域（`Issue.domainId` 上写着）。
 * 那时承接人这一格**照实空着**，不拿任何一个人顶上去 —— 编一个负责人比没有负责人坏
 * 得多（同 A7 那条「不许编负责人」）。
 */
export function mockDeployment(
  issue: IssueSummary,
  domain: DomainSummary | undefined,
): DeploymentDetail {
  const seat = seatOf(issue.id);
  const mission = MISSIONS[seat % MISSIONS.length];
  const role = ROLES[seat % ROLES.length];

  /*
   * 承接人：点过名的那个人优先，其次是这个域的 DRI（`findDomainDri` 同一条口径）。
   * 两者在屏幕上分得开 —— `real` 为 true 的那一格是从对象库里取的名字。
   */
  const ownerName = issue.assigneeName || domain?.driName || "";

  const mocked = [
    "对应的 Mission（议题和 Mission 之间的关系本体里还没有）",
    "岗位、交接时刻、最近一次回话",
  ];

  return {
    issueId: issue.id,
    owners: ownerName
      ? [{ name: ownerName, role, domainName: domain?.name, real: true }]
      : [],
    /*
     * 交接时刻拿 `updatedAt` 顶着，**而且在 `mocked` 里点了名**：议题上没有
     * 「什么时候交出去的」这一格（`IssueSummary` 只有 `updatedAt` 和 `ageDays`），
     * 而 `updatedAt` 是最后一次有动静，不是交接那一刻 —— 一件被打回又跑过一轮的
     * 议题，这两个时刻能差几个月。
     */
    handedOverAt: issue.updatedAt,
    mission: {
      code: mission.code,
      name: mission.name,
      milestone: mission.milestone,
      status: mission.status,
      periodLabel: "本期",
    },
    ...(ownerName
      ? {
          lastWord: {
            at: issue.updatedAt,
            text: "承接研究已交回，等一号位抽查。",
          },
        }
      : {}),
    mocked,
  };
}
