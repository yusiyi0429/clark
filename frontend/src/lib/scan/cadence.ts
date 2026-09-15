/**
 * 扫描的节奏：**从实际发生过的轮次里算出来**，不是抄一句「每天一轮」。
 *
 * 屏幕上那句话原来是三处各自手写的中文，背后没有任何数据 —— 抓取那一侧改了定时，
 * 这三处一个字都不会变，而一号位看着的正是这一句。所以这里换成一个只有一个出处的
 * 算法加一个只有一个出处的措辞：算的人只算，说的人只说，三个视图都来这里取。
 *
 * ## 声称的周期这一侧拿不到
 *
 * 真正的定时器在抓取作业那一侧（不在这个仓库里），本仓库是被动收件方，读不到对面的
 * 定时配置。所以这里**不说「应该每几小时一轮」**，只说「实际上大约每几小时来了一轮」。
 * 这两句话在跑得好的时候一样，在对面停摆的时候正好相反 —— 而后者才是他要看见的。
 */
import type { ScanRound } from "@/lib/data/types";
import { formatAgo } from "@/lib/format";

/** 算出来的节奏。`medianHours` 为 null = 手上的自动轮次还不够，算不出来。 */
export type ScanCadence = {
  /** 算进节奏的轮次数 —— **只数自动的那些**（见 `scanCadence`）。 */
  counted: number;
  /** 相邻两轮之间隔了多久，取中位数，小时。不够 `MIN_AUTO_ROUNDS` 轮时为 null。 */
  medianHours: number | null;
  /** 最近一轮的时刻。**自动手动都算** —— 「上次什么时候扫的」不关心是谁起的。 */
  lastAt: string | null;
};

/**
 * 少于这么多轮自动记录就不说节奏。
 *
 * 两轮只有一个间隔，那不是节奏是一次巧合；三轮才有两个间隔，中位数才有话说。
 * 宁可在屏幕上说「还说不出来」，也不拿一个间隔当周期报给他。
 */
const MIN_AUTO_ROUNDS = 3;

/**
 * 从扫描台账里算节奏。
 *
 * **只数 `trigger === "auto"` 的轮次。** 没有这一格的老记录（这一格是后加的）一律
 * 当「不知道来路」排除掉 —— 绝不能默认成自动：他在屏幕上点「主动开始扫描」连点两下
 * 也会各落一条账，混进来的话算出来的「节奏」会变成几分钟，那比不说更坏。
 */
export function scanCadence(rounds: readonly ScanRound[]): ScanCadence {
  const dated = rounds.filter((r) => Number.isFinite(Date.parse(r.scannedAt)));

  const lastAt = dated.length
    ? dated.reduce((a, b) => (Date.parse(b.scannedAt) > Date.parse(a.scannedAt) ? b : a)).scannedAt
    : null;

  const auto = dated
    .filter((r) => r.trigger === "auto")
    .map((r) => Date.parse(r.scannedAt))
    .sort((a, b) => a - b);

  if (auto.length < MIN_AUTO_ROUNDS) return { counted: auto.length, medianHours: null, lastAt };

  const gaps: number[] = [];
  for (let i = 1; i < auto.length; i++) gaps.push((auto[i] - auto[i - 1]) / 3_600_000);

  return { counted: auto.length, medianHours: round1(median(gaps)), lastAt };
}

/**
 * 中位数，**不是平均数**。
 *
 * 对面漏跑一轮（间隔翻倍）或者作业重投补一次（间隔接近零），都会把平均值拖到一个
 * 从来没发生过的数上；中位数是「多数时候实际隔多久」，那才是他问「多久一轮」时要的答案。
 * 偶数条取中间两条的平均 —— 标准取法，别自作主张挑一边。
 */
function median(nums: number[]): number {
  const s = [...nums].sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** 留一位小数：屏幕上只显示整数，但账上多一位，便于对着数字核。 */
function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/**
 * 屏幕上那一句。**全站唯一的出处** —— 三个视图（首页雷达、待挑的信号、扫描记录）
 * 都调它，改措辞只改这里。这一条正是这次要根治的病：原来那句话是三处手抄的。
 *
 * **只报事实，不解释。** 算不出节奏就只说上一轮什么时候，后面不跟任何一句「为什么
 * 说不出来」——那种话是替产品找补，不是他要的信息。
 *
 * 一轮都没有时回空串：**那一行整个不渲染**。屏幕上没有这一行，本身就说明了没有扫过。
 */
export function formatScanCadence(c: ScanCadence, now: number = Date.now()): string {
  if (!c.lastAt) return "";

  const last = `上一轮 ${formatAgo(c.lastAt, now)}`;
  if (c.medianHours === null) return last;

  // 不足一小时的节奏写成分钟：屏幕上不出现「约每 0 小时一轮」。
  const every =
    c.medianHours >= 1
      ? `${Math.round(c.medianHours)} 小时`
      : `${Math.max(1, Math.round(c.medianHours * 60))} 分钟`;
  return `最近 ${c.counted} 轮 · 约每 ${every}一轮 · ${last}`;
}
