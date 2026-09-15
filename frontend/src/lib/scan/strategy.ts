/**
 * 「监控策略」那一屏读的东西 —— **雷达此刻按的是哪一份靶点策略。**
 *
 * ## 它现在读的是本仓库里那一份
 *
 * 这一页原来每打开一次就去实验台读一遍，理由是「抓取参数的唯一真源在实验台」。
 * 那条理由跟着抓取一起搬走了：现在扫描是这个仓库自己在跑（`run.ts`），策略正文和
 * 那几个数都签在 `strategy-body.ts` 里，所以真源就在手边 —— 不出网、不缓存、
 * 也不会有「读不到」这一档。
 *
 * 少掉的那一档是好事：`MonitorStrategy.unavailable` 从此永远是空的。它原来唯一的
 * 用途是替一台没起着的本机 python 服务解释自己，而那句话跟一号位问的「你在盯什么」
 * 没有关系。
 *
 * ## 解析仍然是尽力而为的，这一点没变
 *
 * 策略正文是给模型读的 markdown（四节：主体画像 / 观察域与 KIQ / 源类型指引 /
 * 准入标准）。这里把「战略假设」和「观察域 + KIQ」认出来摊成条目，是为了让他扫一眼
 * 就知道在盯什么。**格式一改，认不出来的那部分就是空的** —— 所以详情页同时照登正文
 * 原文（`body`）：认出来的那几条是方便，正文才是凭据。
 */
import type { MonitorDomain } from "@/lib/data/types";
import { providerLabel, providers } from "@/lib/research/search";

import { CATCHING_SPEC, CATCHING_STRATEGY } from "./strategy-body";

/** 此刻在用的那一份靶点策略。 */
export type ScanStrategy = {
  origin: string;
  hypotheses: string[];
  domains: MonitorDomain[];
  limits: string[];
  body: string;
};

/**
 * 读这一份策略。**同步、不出网、不会失败。**
 *
 * 每次现算而不是存一个模块级常量：`limits` 里最后那一句要报此刻真正配着的检索家，
 * 而那是从环境变量读的 —— 存下来的话，改了 `TKOS_SEARCH_PROVIDER` 之后屏幕上
 * 还写着上一次进程启动时的阵容。这一趟的开销是解析一段 128 行的 markdown，
 * 一次打开折叠面算一次，不值得为它留一份会过期的副本。
 */
export function scanStrategy(): ScanStrategy {
  const parsed = parseStrategyBody(CATCHING_STRATEGY);
  return {
    origin: "靶点策略 v0.1 · 本仓库",
    body: CATCHING_STRATEGY,
    hypotheses: parsed.hypotheses,
    domains: parsed.domains,
    limits: [...limitsOf(CATCHING_SPEC), `搜索走${providerLabel(providers().list)}`],
  };
}

/* -------------------------------------------------------------------------- */

/**
 * 从策略正文里认出战略假设和观察域。**认不出来就是空的，不猜。**
 *
 * 正文里这两样长这样（`\n` 是原文的换行，续行缩进）：
 *
 *     H1 「AI 转型必须从一号位开始」是有效的市场切入；
 *     **D1 竞争与替代**（对应 H1、H2）
 *     - KIQ1.1 Palantir / Aera 类平台有无面向中国市场或
 *       一号位场景的新动作？
 *
 * 所以要做的就两件事：认出每一条的开头，把缩进的续行接回去。接回去的时候中文之间
 * 不补空格、拉丁词之间补一个 —— 原文是排版换行，`Gartner\n  DIP` 接成 `GartnerDIP`
 * 是错的，`或\n  一号位场景` 接成 `或 一号位场景` 也是错的。
 */
export function parseStrategyBody(body: string): {
  hypotheses: string[];
  domains: MonitorDomain[];
} {
  const hypotheses: string[] = [];
  const domains: MonitorDomain[] = [];

  /** 当前正在攒的那一条：它攒完之后进哪个筐。 */
  let bucket: "hypothesis" | "kiq" | null = null;
  let buf = "";

  const flush = () => {
    const text = buf.trim();
    buf = "";
    const where = bucket;
    bucket = null;
    if (!text || !where) return;
    if (where === "hypothesis") hypotheses.push(text);
    // KIQ 只挂在已经开了的那个域下面。域还没开就出现的 KIQ 一律丢 —— 那说明格式变了，
    // 而把它挂到「上一个域」上是在编一条对应关系。
    else if (domains.length > 0) domains[domains.length - 1].kiqs.push(text);
  };

  for (const raw of body.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    const trimmed = line.trim();

    if (!trimmed) {
      flush();
      continue;
    }

    // `**D1 竞争与替代**（对应 H1、H2）` —— 标题带上后面那个括号：那一句写的是
    // 这个域对着哪几条假设，是这一行里最有用的半句。
    const domain = /^\*\*(D\d+)\s+([^*]+?)\*\*(.*)$/.exec(trimmed);
    if (domain) {
      flush();
      domains.push({
        code: domain[1],
        title: `${domain[2].trim()}${domain[3].trim()}`,
        kiqs: [],
      });
      continue;
    }

    const kiq = /^[-*]\s+(KIQ\S*\s+.+)$/.exec(trimmed);
    if (kiq) {
      flush();
      bucket = "kiq";
      buf = kiq[1];
      continue;
    }

    const hypothesis = /^(H\d+)\s+(.+)$/.exec(trimmed);
    if (hypothesis) {
      flush();
      bucket = "hypothesis";
      buf = `${hypothesis[1]} ${hypothesis[2]}`;
      continue;
    }

    // 小节标题、别的条目 —— 都不是我们要的，但它们终结上一条。
    if (/^#{1,6}\s/.test(trimmed) || /^[-*]\s/.test(trimmed)) {
      flush();
      continue;
    }

    // 缩进的续行。只在正攒着某一条的时候才算续行。
    if (bucket && /^\s/.test(line)) buf = join(buf, trimmed);
    else flush();
  }
  flush();

  // 句末那个分号是原文断句用的，摊成条目之后它只是一个多余的符号。
  return { hypotheses: hypotheses.map((h) => h.replace(/[；;]$/, "")), domains };
}

/** 中文接中文不补空格，别的补一个。 */
function join(left: string, right: string): string {
  const a = left.slice(-1);
  const b = right.slice(0, 1);
  const cjk = (c: string) => /[^\x00-\xff]/.test(c);
  return cjk(a) && cjk(b) ? left + right : `${left} ${right}`;
}

/**
 * spec 里那几个数摊成人话。**只写 spec 里真有的那几项** —— 缺哪一项就少一句，
 * 不补默认值：这一页说的是「雷达此刻按什么扫」，补一个默认值等于替它答。
 *
 * 检索家那一句不在这里 —— 它不是 spec 里的数，是这台机器此刻真配着的阵容，
 * 由 `scanStrategy()` 拿 `providers()` 现写（理由写在 `CATCHING_SPEC` 上）。
 */
function limitsOf(spec: Record<string, unknown>): string[] {
  const out: string[] = [];
  const num = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

  const hours = num(spec.time_window_hours);
  if (hours !== undefined) {
    out.push(`只看最近 ${hours} 小时内发布的（约 ${Math.round(hours / 24)} 天），更旧的直接落掉`);
  }
  const threshold = num(spec.threshold);
  if (threshold !== undefined) {
    out.push(`研判打分低于 ${threshold} 的不端到您面前`);
  }
  const triage = num(spec.max_signals_to_triage);
  if (triage !== undefined) out.push(`每轮最多逐条研判 ${triage} 条`);
  /*
   * 「每个源」改成「每条检索式」。源驱动那套抓法里一个源是一个 RSS/发布页，取 10 篇
   * 是在给单个源封顶；这条路上没有源清单，封的是一条问法能带回多少条 —— 说成「源」
   * 会让人以为屏幕背后有一份订阅列表，而它不存在。
   */
  const perQuery = num(spec.per_source_limit);
  if (perQuery !== undefined) out.push(`每条检索式每轮最多取 ${perQuery} 条`);

  const pinned = Array.isArray(spec.pinned_sources) ? spec.pinned_sources.length : undefined;
  if (pinned !== undefined) {
    out.push(pinned === 0 ? "没有钉住的源，每轮都从搜索里找" : `钉住的源 ${pinned} 个`);
  }

  return out;
}
