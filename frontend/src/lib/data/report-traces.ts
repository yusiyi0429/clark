/**
 * 判断板上那一行灰字里的引用，怎么变成一个点得开的地址 —— 以及**什么时候坚决不变**。
 *
 * ## ISS-239 的账
 *
 * 判断板上出现过 `href=/docs/E30`。E30 是那份报告的**证据编号**，`/docs/…` 是**本地文档
 * 库**的路由 —— 两个命名空间被拼成了一个地址。点开它，`getDoc` 只查本地文档，必然报
 * 「不存在」。而它能走到屏幕上，是因为这里的判据只有一句：字符串以 `/` 开头就算有效。
 *
 * 「以 `/` 开头」证明的是**这个字符串长得像一个路径**，不是**这个路径指向的东西存在**。
 * 一号位点开一个空链接之后，这一屏上每一个可点的东西都跟着掉价 —— 这正是下面这个文件
 * 头一行注释里那句「点开是空的链接比没有链接更伤」说的事。
 *
 * ## 解析次序：先编号，后文档，都要验
 *
 *   1. **先在本报告作用域内解析 E 编号。** 认得出 `E30`、`[E30]`、`#E30`，也认得出旧数据
 *      里那种 `/docs/E30`。映射到**这一份报告这一个版本**的证据登记表（`boardReport` 取回
 *      的那一份），拿它的外部地址。
 *   2. **再处理本地文档 ID**，并验证它确实存在（`docExists`）。
 *   3. 绝对地址（`http/https`）照旧放行。
 *   4. 其余以 `/` 开头的字符串按**应用真有的那几条路由**核一遍，不在表上的不放行。
 *   5. 一条都对不上：**保留文字，加一句「未定位」，不产出死链。**
 *
 * ## 重复编号跨报告不可串联
 *
 * E30 在两份报告里是两条完全不同的证据（三条链路各自取证，编号各自从 E1 开始）。所以
 * 解析永远只在**传进来的那一份 `doc`** 里做，一次都不许退到「全库找一个叫 E30 的」——
 * 那样找到的是另一份报告的另一页，而屏幕上看不出串了。没有 `doc` 就是解析不出，不是
 * 「去别处找找」。
 */

import type { AgentRunRecord, BoardJudgement, ResearchDoc, Trace } from "./types";

/**
 * 应用里**真有**的那几条一级路由。`src/app/(tkos)` 与同级几个段，2026-09-07 核过。
 *
 * 写死一张表而不是放行所有 `/…`：放行所有的代价就是 `/docs/E30`——一个语法正确、语义
 * 不存在的地址。这张表哪天和路由走岔了，表现是某类内部引用不可点（读得到文字），
 * 而不是点开一片空白。两种走岔里这一种便宜得多。
 */
const APP_ROUTES = new Set([
  "docs",
  "judgments",
  "issues",
  "issues-log",
  "decisions",
  "outcomes",
  "meetings",
  "recordings",
  "sensors",
  "signals",
  "signals-inbox",
  "signals-log",
  "signals-scans",
  "archive",
  "changelog",
  "deployed",
  "actions",
  "access",
  "dri",
  "operator",
  "sec",
  "showcase",
]);

/** 本地文档 ID 的形状。`DOC-01`、`DOC-D4`、`DOC-51`。**`E30` 不是这个形状。** */
const DOC_ID = /^DOC-[A-Za-z0-9][A-Za-z0-9-]*$/;

/** 证据编号的形状。 */
const EVIDENCE_ID = /^E\d+$/i;

/** 对不上任何东西的引用，文字后面缀这一句。屏幕上仍是灰字，只是多说明了一句。 */
const UNRESOLVED = "（未定位）";

const firstSegment = (href: string): string => href.replace(/^\/+/, "").split(/[/?#]/)[0] ?? "";

/**
 * 这个 href 能不能点。**渲染那一侧的最后一道闸**（`judgement-board.tsx` 直接用它）。
 *
 * 2026-09-07 收紧：以前是「`http(s)://` 或者以 `/` 开头」。后半句放过了 `/docs/E30`。
 * 现在内部地址要过两关 —— 一级路由在 `APP_ROUTES` 上，而且 `/docs/…` 后面那一段必须
 * 长得像文档 ID。`resolveReportTraces` 已经把解析不出的 href 摘掉了，这里是第二层：
 * 老数据、别处直接构造的 `Trace`、以及将来新写的调用点都走这一条。
 */
export const navigableTrace = (href?: string): boolean => {
  const raw = (href ?? "").trim();
  if (!raw) return false;
  if (/^https?:\/\//i.test(raw)) return true;
  // `//evil.com` 是协议相对的外链，不是内部路由。
  if (!/^\/(?![/\\])/.test(raw)) return false;
  const seg = firstSegment(raw);
  if (!APP_ROUTES.has(seg)) return false;
  if (seg === "docs") {
    const id = raw.replace(/^\/+docs\/+/, "").split(/[/?#]/)[0] ?? "";
    return DOC_ID.test(id);
  }
  return true;
};

/**
 * 从一条引用里把**证据编号**抠出来。抠不出返回空串。
 *
 * 认这几种形态，全是库里真出现过的：`E30`、`e30`、`[E30]`、`#E30`、`/docs/E30`、`docs/E30`。
 * 最后两种是 2026-09-07 之前落库的旧数据 —— A5 把证据编号当成文档 ID 拼进了文档路由。
 * 认它不是为了迁就，是为了**把旧数据里那些死链改成能定位的外链**：E30 在那份报告里真的
 * 有一页原文，只是地址拼错了。
 */
export function evidenceRefOf(token: string): string {
  const raw = (token ?? "").trim().replace(/^\[|\]$/g, "");
  if (!raw) return "";
  const bare = raw
    .replace(/^\/+/, "")
    .replace(/^docs\/+/i, "")
    .replace(/^#/, "")
    .split(/[?#]/)[0]
    ?.trim()
    .replace(/^\[|\]$/g, "");
  if (!bare) return "";
  return EVIDENCE_ID.test(bare) ? `E${bare.slice(1)}` : "";
}

/** 从一条引用里把**本地文档 ID** 抠出来。抠不出返回空串。`/docs/DOC-51`、`DOC-51`。 */
export function docIdOf(token: string): string {
  const raw = (token ?? "").trim();
  if (!raw) return "";
  const bare = raw
    .replace(/^\/+/, "")
    .replace(/^docs\/+/i, "")
    .split(/[/?#]/)[0]
    ?.trim();
  return bare && DOC_ID.test(bare) ? bare : "";
}

export interface ResolveOptions {
  /**
   * 这个本地文档 ID 在库里存在吗。
   *
   * **必须由调用方递** —— 这个文件在数据层，它不该反过来去读 `store`（循环依赖，而且
   * `store.ts` 在别人手上）。不递的时候退到**只验形状**：`/docs/E30` 照样被拦下
   * （E30 不是 `DOC-…`），但一个格式正确却已经删掉的 `DOC-99` 会漏过去。
   *
   * 所以接线的那一侧要把它递上：`(id) => store.docs.some((d) => d.id === id)`。
   */
  docExists?: (id: string) => boolean;
}

const withHint = (trace: Trace): Trace => {
  const rest = { ...trace };
  delete rest.href;
  return rest.source.endsWith(UNRESOLVED) ? rest : { ...rest, source: `${rest.source}${UNRESOLVED}` };
};

const stripHref = (trace: Trace): Trace => {
  const rest = { ...trace };
  delete rest.href;
  return rest;
};

/**
 * 把一条判断上的引用解析成能点开的地址。
 *
 * `doc` 是**生成这条判断的那一份报告的那一个版本**（`boardReport` 取回来的）。E 编号只在
 * 它里面解析 —— 见文件头「重复编号跨报告不可串联」。
 */
export function resolveReportTraces(traces: Trace[], doc?: ResearchDoc, opts: ResolveOptions = {}): Trace[] {
  const evidence = doc?.blocks?.evidence ?? [];
  const urlsOf = (matches: typeof evidence): string[] => [
    ...new Set(
      matches.map((e) => e.url).filter((url): url is string => Boolean(url && /^https?:\/\//i.test(url)))
    ),
  ];

  return traces.map((trace) => {
    const token = (trace.href || trace.source).trim();

    /* 1. 证据编号。`/docs/E30` 这种旧形态在这一步就被认出来，不会走到「像个路径」那一支。 */
    const ref = evidenceRefOf(token);
    if (ref) {
      const urls = urlsOf(evidence.filter((e) => e.id.toUpperCase() === ref.toUpperCase()));
      // 唯一才接。同一个编号解析出两个地址时接哪个都是猜，猜错就是指向另一页原文。
      return urls.length === 1 ? { ...stripHref(trace), kind: "ext" as const, href: urls[0] } : withHint(trace);
    }

    /* 2. 本地文档 ID。形状对，还要真的在库里。 */
    const docId = docIdOf(token);
    if (docId) {
      const exists = opts.docExists ? opts.docExists(docId) : true;
      return exists ? { ...trace, kind: "int" as const, href: `/docs/${docId}` } : withHint(trace);
    }

    /* 3. 绝对地址原样放行；4. 其余内部路由按 `APP_ROUTES` 核一遍。 */
    if (trace.href && navigableTrace(trace.href)) return { ...trace };

    /*
     * 5. 兜底：拿它当来源名去证据表里找。找得到唯一一条就接外链，找不到就保留文字。
     *
     * 这一支**不加「未定位」**：走到这里的多半是「一号位说的」「上一轮判断」这类本来就
     * 没有地址的溯源，给它们缀一句「未定位」等于把一条正常的说明标成缺陷。加提示的只有
     * 上面那两支 —— 那两支是**明确引了一个编号或一份文档、而它对不上**。
     */
    const name = token.replace(/^\[|\]$/g, "");
    const urls = urlsOf(evidence.filter((e) => e.sourceName === name));
    return urls.length === 1 ? { ...stripHref(trace), kind: "ext" as const, href: urls[0] } : stripHref(trace);
  });
}

/** 旧板未保存版本：必须找到生成该条的 A5，以及它开始前已完成的 A4 快照。 */
export function boardReport(j: BoardJudgement, runs: AgentRunRecord[]): ResearchDoc | undefined {
  if (j.origin !== "research") return undefined;
  const time = Date.parse(j.at);
  const a5 = runs.filter((r) => r.agent === "A5" && r.input.startsWith(`${j.issueId} ·`) && r.output &&
    Math.abs(Date.parse(r.finishedAt ?? "") - time) < 2000);
  if (a5.length !== 1) return undefined;
  const before = Date.parse(a5[0].createdAt);
  const a4 = runs.filter((r) => r.agent === "A4" && r.output?.issueId === j.issueId &&
    Date.parse(r.finishedAt ?? "") <= before).sort((a, b) => Date.parse(b.finishedAt!) - Date.parse(a.finishedAt!))[0];
  return a4?.output as unknown as ResearchDoc | undefined;
}
