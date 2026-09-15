/**
 * 「主动开始扫描」按下去之后真正发生的事。
 *
 * 一号位按一下 → 这里按靶点策略拟出问法、去检索、去重、逐条研判、把过线的收进
 * 待挑列表。**全程在这个仓库里跑**，不依赖任何别的服务起没起着。
 *
 * ## 它原来不是这样的
 *
 * 上一版是去实验台（本机一台 python 服务）起一轮 `catching`、一步一步把它推完、
 * 把产出收下来。那台服务没起着的时候，屏幕上就是「连不上实验台
 * （http://127.0.0.1:8080）」—— 而一号位按的那个键跟它起没起着没有任何关系。
 * 抓取参数「唯一真源在实验台」那条规矩跟着一起没了：策略正文和那几个数现在签在
 * `strategy-body.ts` 里。
 *
 * ## 五步，每一步的名字就是它真在做的事
 *
 *   ① 通不通     检索这条路走不走得通 —— 走不通就在这儿停，别花后面那几次调用
 *   ② 拟 + 检索  读策略把 KIQ 变成问法（`queries.ts`），一条问法发一次（`research/search.ts`）
 *   ③ 过筛       归一化去重、落窗外的丢掉、已经在列表里的丢掉、封顶 30 条
 *   ④ 研判       每 10 条一批，按策略第四节五维打分（`triage.ts`）
 *   ⑤ 收         过线的抓一次正文，拼成契约 → 收件校验 → 落库
 *
 * ## 三条不许破的规矩
 *
 * 1. **屏幕上那行进度必须是这一刻真在做的事。** 原来这条写的是「必须是实验台给的
 *    原话」，意思没变，落法变了：现在这五步是我们自己在跑，所以那几句话由我们写 ——
 *    而它们必须对应到真的在发生的一步，一个字不许编（产品原则那一条：绝不出现
 *    「正在分析全网资讯」）。
 * 2. **起不来就照实说起不来。** 没配检索 key、演示档不出网，都原样写在屏幕上，
 *    不做「看起来在扫」的假动作。
 * 3. **收下来的东西走同一个收件校验**（`parseInboxPayload` + `inboxSignalsPut`），
 *    和 DRI 上报、和将来任何别的来路一模一样。这边不另开一条宽松的入口。
 */
import { parseInboxPayload } from "@/lib/data/inbox";
import { isDemo } from "@/lib/data/mode";
import {
  inboxSignalsPut,
  listInboxDedupeKeys,
  monitorFocusText,
  persistSoon,
  scanRoundPut,
} from "@/lib/data/store";
import type { ScanState } from "@/lib/data/types";
import { fetchPage } from "@/lib/research/fetch";
import { providerLabel, providers, searchAll, type SearchHit } from "@/lib/research/search";
import { runTask, taskState } from "@/lib/agent/tasks";

import { normalizeUrl } from "./normalize-url";
import { buildQueries } from "./queries";
import { scanStrategy } from "./strategy";
import { CATCHING_STRATEGY, specNum } from "./strategy-body";
import { triage, type Candidate, type Scored } from "./triage";

/**
 * 全局只有一轮。任务表按 kind + id 记状态，这条链路没有「哪一件事」这一维 ——
 * 扫的是公司布下的靶点，不是某条议题。
 */
const KIND = "scan";
const ID = "signals";

/** 这一步走到哪了。原来这个形状是实验台给的，现在是我们自己写的。 */
type Step = { label: string; no?: number; total?: number };

/** 这一轮的进度与产出。任务表只记 idle/running/done/failed，这些是它记不下的部分。 */
let live: {
  runId?: string;
  progress?: Step;
  got?: NonNullable<ScanState["got"]>;
  finishedAt?: string;
} = {};

/** 扫描现在到哪了。前端在跑的时候轮询这个。 */
export function scanState(): ScanState {
  const st = taskState(KIND, ID);
  /*
   * **扫描不排队**：下面那句 `runTask` 不给 `lane`，所以 `queued` 在这条路上到不了。
   *
   * 收在这里而不是把 `ScanState.status` 跟着放宽一档：放宽等于对屏幕说「这里可能排队」，
   * 于是有人会去写一句永远不显示的排队文案。真给这条路排上队的那天，这一行要连着屏幕上
   * 那句话一起改 —— 那正是该被逼着想一遍的地方。
   */
  const out: ScanState = { status: st.status === "queued" ? "running" : st.status };
  if (st.error) out.error = st.error;
  if (live.runId) out.runId = live.runId;
  if (live.got) out.got = live.got;
  if (live.finishedAt) out.finishedAt = live.finishedAt;
  if (live.progress) {
    out.step = live.progress.label;
    if (live.progress.no !== undefined) out.no = live.progress.no;
    if (live.progress.total !== undefined) out.total = live.progress.total;
  }
  /*
   * 「这条路现在走不通」和「这一轮跑失败了」是两件事，屏幕上说的话不一样：前者要
   * 说的是「按了也没用，去配那个变量」，后者是「刚才那一轮没跑成」。
   *
   * 走不通现在只剩一种：演示档。检索没配 key 不在这一档 —— 那要等真按下去才知道
   * （`providers()` 会把「配了 bocha 但没配 key」这种话原样带回来），而且它是可以
   * 当场修好的，不该长期占着屏幕上那一行。
   */
  if (isDemo()) out.unavailable = "演示档不出网抓取。";
  return out;
}

/** 起一轮。正在跑就原样返回 —— 连点两下不该变成两轮真实的扫描。 */
export function startScan(): ScanState {
  const cur = scanState();
  if (cur.unavailable) return cur;
  if (cur.status === "running") return cur;

  // 上一轮的产出留在屏幕上，直到这一轮真的开始 —— 清早了会让「收下 4 条」凭空消失。
  live = {};
  runTask(KIND, ID, async () => {
    await driveOneScan();
    return {};
  });
  return scanState();
}

const step = (label: string, no?: number, total?: number) => {
  live = { ...live, progress: { label, ...(no === undefined ? {} : { no }), ...(total === undefined ? {} : { total }) } };
};

/** 这一轮的编号。实验台那边是它的 run id，本地这条路自己发一个 —— 扫描记录按它分组。 */
const newRunId = (at: Date): string =>
  `s-${at.toISOString().slice(0, 16).replace(/[-:T]/g, "")}-${Math.random().toString(36).slice(2, 6)}`;

/**
 * 起一轮、跑到底、收下来。
 *
 * 参数全部来自 `CATCHING_SPEC`（窗、封顶、阈值、上桌条数），一个都不在这里写死 ——
 * 屏幕上「什么才端到您面前」那几句话译的就是那几个数，两处必须是同一份。
 */
async function driveOneScan(): Promise<void> {
  const startedAt = new Date();
  live = { runId: newRunId(startedAt) };

  const windowHours = specNum("time_window_hours", 72);
  const perQuery = specNum("per_source_limit", 10);
  const maxTriage = specNum("max_signals_to_triage", 30);
  const threshold = specNum("threshold", 3.5);
  const maxReview = specNum("max_review_items", 8);

  /* ① 检索这条路通不通 -------------------------------------------------- */
  /*
   * **先问这一件，再花那次模型调用。**
   *
   * 拟检索式是一次真实的模型调用。检索用不上的时候拟出来的问法一条都发不出去，
   * 那次调用就是白花的钱 —— 所以顺序是「先确认有地方可问，再去想问什么」。
   */
  const setup = providers();
  /*
   * `none` 那一支不算数：它是深研那条路上「故意不搜」的对照组（`providers()` 在
   * 没配 `TKOS_SEARCH_PROVIDER` 时返回的就是它，而且 `reason` 是空的）。
   * 扫描的全部内容就是去外面看一眼，拿一支永远返回空数组的检索去扫，等于假装扫过。
   */
  const usable = setup.list.filter((p) => !p.reason && p.name !== "none");
  if (usable.length === 0) {
    /*
     * 一家都用不上 = 这一轮**失败**，不是「外面没东西」。
     *
     * 深研那条路上查不到是合法结果（HP-5），一次深研不该因为没配 key 就失败。这条路
     * 不一样：检索不通的时候「收下 0 条」和「外面确实没有值得看的」在屏幕上一模一样，
     * 而它们要他做的事完全相反 —— 一个是去配 key，一个是什么都不用做。
     */
    const why = [...setup.list.map((p) => p.reason), ...setup.skipped].filter(Boolean).join("；");
    throw new Error(
      `这台机器现在一家检索都用不上：${why || "没有配 TKOS_SEARCH_PROVIDER（或者配成了 none）"}`,
    );
  }
  if (setup.skipped.length > 0) console.warn(`[tkos:scan] 没用上的检索家：${setup.skipped.join("；")}`);

  /* ② 拟检索式 ---------------------------------------------------------- */
  step("读靶点策略、拟这一轮的检索式");
  const strategy = scanStrategy();
  /*
   * 他自己交代的那句「这一轮多盯着点什么」进这一步的提示词。
   * 它**只改取向不改阈值**（理由写在 `MonitorFocus` 上）：拟问法时侧重它，
   * 而准入门槛和过线分数仍然由策略第四节说了算。
   */
  const focus = monitorFocusText();
  if (focus) console.log(`[tkos:scan] 这一轮带着一号位的交代：${focus}`);
  const plan = await buildQueries({ strategy, focus });
  if (plan.degraded) console.warn(`[tkos:scan] 检索式退化成 KIQ 原文：${plan.degraded}`);

  const label = `按 ${plan.queries.length} 条检索式检索（${providerLabel(usable)}）`;
  step(label, 0, plan.queries.length);
  const found = await searchAll(usable, plan.queries.map((q) => q.q), perQuery, windowHours);
  step(label, plan.queries.length, plan.queries.length);
  if (found.errors.length > 0) console.warn(`[tkos:scan] 检索报错 ${found.errors.length} 条：${found.errors.join("；")}`);

  /* ③ 过筛 -------------------------------------------------------------- */
  step("去重、落窗、封顶");
  const kiqOf = new Map(plan.queries.map((q) => [q.q, q.kiq] as const));
  const candidates = sift({
    hits: found.hits,
    kiqOf,
    known: listInboxDedupeKeys(),
    windowHours,
    now: startedAt,
    cap: maxTriage,
  });

  if (candidates.length === 0) {
    /*
     * 一条候选都没有是**合法结果**（策略第四节：一次扫描零条过线是合法结果）。
     * 照样落一条扫描记录 —— 不落的话，扫描记录那一页上「扫过一遍，外面没东西」
     * 和「压根没扫」长得一模一样（理由写在 `ScanRound` 上）。
     */
    await land({ runId: live.runId!, scannedAt: startedAt, signals: [], scored: 0 });
    return;
  }

  /* ④ 研判 -------------------------------------------------------------- */
  step("逐条研判", 0, Math.ceil(candidates.length / 10));
  const judged = await triage({
    candidates,
    strategyBody: CATCHING_STRATEGY,
    onBatch: (no, total) => step("逐条研判", no, total),
  });
  for (const e of judged.errors) console.warn(`[tkos:scan] ${e}`);
  if (judged.scored.length === 0 && judged.rejected === 0 && judged.errors.length > 0) {
    // 每一批都挂了 = 这一轮没有研判发生过。这不是「零条过线」，是失败。
    throw new Error(`研判这一步整个没跑成：${judged.errors[0]}`);
  }

  const passed = judged.scored
    .filter((s) => s.score >= threshold)
    .sort((a, b) => b.score - a.score)
    .slice(0, maxReview);
  console.log(
    `[tkos:scan] 研判 ${candidates.length} 条 → 够不上门槛 ${judged.rejected}、` +
      `打了分 ${judged.scored.length}、过 ${threshold} 分 ${passed.length}（上桌封顶 ${maxReview}）`,
  );

  /* ⑤ 收 ---------------------------------------------------------------- */
  const withText = await fillText(passed);
  await land({ runId: live.runId!, scannedAt: startedAt, signals: withText, scored: judged.scored.length });
}

/* -------------------------------------------------------------------------- */
/* ③ 过筛                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * 搜索命中 → 候选。**四道筛，每一道都必须说得出为什么。**
 *
 * 1. 没有 URL 的丢掉 —— 幂等键就是归一化后的 URL，没有键，下一轮必然堆一条重复的。
 * 2. 归一化后重复的丢掉 —— 两条问法搜到同一页是常态。
 * 3. **已经在待挑列表里的丢掉** —— 这一道是省钱的那一道：研判是按条收费的，把上一轮
 *    已经端上去过的再判一遍，花的是真钱，换回来的是同一条。策略里那句「已在近期扫描
 *    中出现过的同一事实」在这一侧的落法就是它。
 * 4. 落在时间窗外的丢掉 —— **只丢那些标了日期且确实超窗的**。没标日期的一律留下：
 *    博查的 `publishedAt` 常常是空的，按「没日期就算超窗」处理会把大半批扔掉，
 *    而那不是策略的意思。窗这件事在屏幕上由「只看最近 72 小时」那句话承诺，
 *    这里做到的是「标了日期的都在窗内」。
 */
export function sift(opts: {
  hits: SearchHit[];
  kiqOf: Map<string, string>;
  known: Set<string>;
  windowHours: number;
  now: Date;
  cap: number;
}): Candidate[] {
  const out: Candidate[] = [];
  const seen = new Set<string>();
  const floor = opts.now.getTime() - opts.windowHours * 3600_000;

  for (const h of opts.hits) {
    const key = normalizeUrl(h.url);
    if (!key || seen.has(key) || opts.known.has(key)) continue;

    if (h.publishedAt) {
      const at = Date.parse(h.publishedAt);
      if (Number.isFinite(at) && at < floor) continue;
    }

    seen.add(key);
    out.push({
      url: h.url,
      title: h.title,
      snippet: h.snippet,
      source: h.siteName || h.sourceDomain,
      ...(h.publishedAt ? { publishedAt: h.publishedAt } : {}),
      kiq: (h.matchedQuery && opts.kiqOf.get(h.matchedQuery)) || "",
    });
    if (out.length >= opts.cap) break;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* ⑤ 收                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 给过线的那几条补正文。**抓不到就留摘要，不失败。**
 *
 * 搜索摘要是被剥过口径的东西，而这个 `text` 后面要喂给 A1a 立案 —— 拿一段两行的
 * 摘要去立一件议题，立出来的正文就是那两行。所以过线的这 ≤8 条各抓一次正文。
 *
 * 只抓过线的，不是全部候选：三十条全抓是三十次出网，而其中二十几条马上就要被
 * 阈值筛掉。
 */
async function fillText(passed: Scored[]): Promise<Scored[]> {
  if (passed.length === 0) return passed;
  /*
   * `TKOS_MODEL_MOCK=1` 的含义是**这一轮不出网**（见 `research/search.ts` 顶上那段，
   * 那个开关在那边压倒一切）。抓正文是这条链路上最后一次出网，所以它也听这一条 ——
   * 不听的话，离线跑一轮扫描会去访问假检索编出来的那几个域名。
   */
  if (process.env.TKOS_MODEL_MOCK === "1") return passed;
  step("给过线的那几条抓正文", 0, passed.length);
  const out: Scored[] = [];
  for (const [i, s] of passed.entries()) {
    let text = s.snippet;
    try {
      const snap = await fetchPage(s.url);
      if (snap.text.trim().length > text.length) text = snap.text.trim();
    } catch {
      // 抓不到是常事（反爬、超时、PDF）。摘要照用 —— 这一条仍然是一条真信号。
    }
    out.push({ ...s, snippet: text });
    step("给过线的那几条抓正文", i + 1, passed.length);
  }
  return out;
}

/** 拼成契约、过收件校验、落库。**零条也走这一趟** —— 那一轮同样要在扫描记录上留一条。 */
async function land(opts: {
  runId: string;
  scannedAt: Date;
  signals: Scored[];
  scored: number;
}): Promise<void> {
  const payload = {
    run_id: opts.runId,
    scanned_at: opts.scannedAt.toISOString(),
    signals: opts.signals.map((s) => ({
      dedupe_key: normalizeUrl(s.url),
      title: s.title,
      url: s.url,
      text: s.snippet,
      published_at: s.publishedAt ?? "",
      source: s.source,
      /*
       * `discovered` —— 契约只认 `pinned` / `discovered` 两种，而这条路上每一条都是
       * 从检索里现找到的，没有任何一条来自钉住的源清单（那份清单是空的）。
       */
      origin: "discovered",
      score: s.score,
      dimensions: s.dimensions,
      kiq: s.kiq,
      why: s.why,
      suggested_issue: s.suggestedIssue,
    })),
  };

  const parsed = parseInboxPayload(payload);
  if (!parsed.ok) {
    // 整批拒收，和别的来路一样。这句话会显示在屏幕上并点名是第几条的哪个字段。
    throw new Error(`这一批过不了收件口的校验：${parsed.error}`);
  }

  const { inserted, updated } = inboxSignalsPut(parsed.signals);
  scanRoundPut({
    runId: parsed.runId,
    scannedAt: parsed.scannedAt,
    nominated: parsed.signals.length,
    // 他在屏幕上按出来的这一轮。连点两下不是节奏，所以它不进那个中位数。
    trigger: "manual",
  });
  // 任务回调是「带外」写库的（不经 /api/data），落盘要自己排。
  persistSoon();

  live = {
    ...live,
    got: { received: parsed.signals.length, inserted, updated, droppedNoUrl: 0 },
    // 收工时刻在这里盖，不在前端量 —— 理由写在 `ScanState.finishedAt` 上。
    finishedAt: new Date().toISOString(),
  };
  console.log(
    `[tkos:scan] ${parsed.runId} 打分 ${opts.scored} 条 → 收下 ${parsed.signals.length}` +
      `（新增 ${inserted} / 更新 ${updated}）`,
  );
}
