/**
 * 当前版本的更新说明：每个人进入工作台弹一次，看过按人记在服务端（seen mark `release:<id>`）。
 * 发新版只改这里：换 id 所有人会重新看到一次；条目保持一句话。
 */
export const RELEASE = {
  id: "2026-10",
  label: "10 月更新",
  title: "这次更新了什么",
  items: [
    "月末复盘：Co-Agent 起草，72 小时定稿",
    "本人审核任务卡，全员完成后自动汇总",
    "执行事项能拉人协作，和 Agent 一起改文档",
    "听写更顺手，说完直接发送",
  ],
} as const;

export const releaseSeenKey = (id: string) => `release:${id}`;
