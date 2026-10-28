import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { Value } from "@sinclair/typebox/value";
import {
  RadarAnchor,
  RadarSources,
  type TRadarAnchor,
  type TRadarCandidateSubmission,
  type TRadarScanResponse,
  type TRadarSourceItem,
  type TRadarSources,
} from "@warmap/contracts";
import { assessPromotion } from "./issues.js";
import { plainCompanyNames, type BattlefieldName } from "./companyNames.js";
import { fetchCovers, type CoverImageFetcher } from "./signalCover.js";
import { fetchArticles, fullTextKeepsQuotes, type ArticleFetcher } from "./articleText.js";
import {
  ARTICLE_DEDUPE_LOOKBACK_DAYS,
  findSimilarIssue,
  sameArticle,
  sameIssueScope,
  type SupplementarySignal,
} from "./radarDedupe.js";
import type { TIssueLocation } from "@warmap/contracts";
import { AGENT_ROLES, randomTurnSuffix, stableThreadId, tracedTurn } from "./tracing.js";

export type FingerprintedRadarSource = TRadarSourceItem & { sourceFingerprint: string };

export type RadarWebAdapter = {
  configured: boolean;
  search(input: { query: string; domains?: string[]; lookbackHours: number }, signal: AbortSignal): Promise<TRadarSourceItem[]>;
};

export type RadarWechatAdapter = {
  configured: boolean;
  fetchLatest(input: { accountId: string; accountName: string }, signal: AbortSignal): Promise<TRadarSourceItem[]>;
};

export type RadarOutletAdapter = {
  configured: boolean;
  fetchLatest(input: { outletIds: string[]; lookbackHours: number }, signal: AbortSignal): Promise<TRadarSourceItem[]>;
};

/** 送给研判模型判重的现有待决策议题：模型判定候选与其中某条是同一决策问题时返回 attachToIssueId。 */
export type RadarExistingIssue = { id: string; title: string; coreQuestion: string | null; location: TIssueLocation };

export type RadarAssessor = {
  assess(
    input: { anchors: TRadarAnchor[]; sources: FingerprintedRadarSource[]; existingIssues?: RadarExistingIssue[] },
    signal: AbortSignal,
  ): Promise<TRadarCandidateSubmission>;
};

export type RadarService = {
  runManual(): Promise<TRadarScanResponse>;
  runScheduled(): Promise<TRadarScanResponse>;
  /** 启动补偿：进程崩溃时留下的 running 扫描必须可见地标为 failed（doc 03 §16），不自动重跑。 */
  recoverStaleRuns(): Promise<void>;
  providerStatus: { web: boolean; wechat: boolean; outlets: boolean };
};

type RadarConfigRow = {
  timezone: string;
  lookback_hours: number;
  anchors: unknown;
  sources: unknown;
  scheduled_company_day: string | Date | null;
};

const LOCK_KEY = "radar:default";
/** 单批送入 assess 的来源上限与监测方向上限（doc 03 §6/§11 固定上限，避免无界 prompt）。 */
const ASSESS_BATCH_SIZE = 5;
/**
 * 单次扫描时限（后台任务，不挡首页和雷达页）：Haiku 每批 30–208 秒，线上一轮最多约 7 批、并发 3，
 * 180 秒会截断，所以放到 6 分钟（agents-model-migration §6.4）。
 */
export const RADAR_SCAN_TIMEOUT_MS = 6 * 60_000;
/** 给 CEO 看的时限说法：整分钟写「6 分钟」，否则写秒。 */
const scanLimitText = (ms: number) => (ms >= 60_000 && ms % 60_000 === 0 ? `${ms / 60_000} 分钟` : `${ms / 1000} 秒`);
/** assess 批次并发数：串行时单批 9–23 秒（Haiku 30–208 秒），只靠并发不足以在时限内跑完。 */
const ASSESS_CONCURRENCY = 3;
const MAX_ANCHORS = 20;
/** outlets 是整份 feed，不按 anchor 检索；总量必须受限，保证扫描时限真正可达。 */
const MAX_OUTLET_ITEMS = 20;
/** 网页检索按 anchor 相乘：每个监测方向只取时间窗内最新几条，控制研判量与自动升级的 Issue 量。 */
const MAX_WEB_ITEMS_PER_ANCHOR = 3;
/** 送给研判模型判重的现有待决策议题上限（最近更新的在前）。 */
const MAX_EXISTING_ISSUES = 40;
/** 信号层同文去重：回看已入库信号的条数上限。 */
const MAX_RECENT_SIGNAL_TITLES = 500;

/**
 * 把一条新信号作为补充依据挂到现有议题上（调用方在事务内）：信号的 promoted_issue_id 指向该议题，
 * 议题 origin_ref.supplementarySignals 追加一条（议题页「判断的依据」显示为「雷达补充：<信号标题>」），版本 +1。
 * 议题已不在待决策、或这条信号已经挂过（含议题自己的原始信号）时不改议题。
 */
export async function attachSignalToIssue(
  client: Pick<PoolClient, "query">,
  input: { issueId: string; signalId: string; promotionFingerprint: string | null; supplement: SupplementarySignal },
): Promise<boolean> {
  await client.query(
    "UPDATE signals SET promoted_issue_id = $2, promotion_fingerprint = COALESCE($3, promotion_fingerprint) WHERE id = $1",
    [input.signalId, input.issueId, input.promotionFingerprint],
  );
  const updated = await client.query(
    `UPDATE issues
        SET origin_ref = jsonb_set(
              origin_ref,
              '{supplementarySignals}',
              COALESCE(origin_ref->'supplementarySignals', '[]'::jsonb) || jsonb_build_array($2::jsonb)
            ),
            version = version + 1,
            updated_at = now()
      WHERE id = $1 AND status = 'pending'
        AND COALESCE(origin_ref->>'signalId', '') <> $3
        AND NOT COALESCE(origin_ref->'supplementarySignals', '[]'::jsonb) @> jsonb_build_array(jsonb_build_object('signalId', $3::text))`,
    [input.issueId, JSON.stringify(input.supplement), input.signalId],
  );
  return updated.rowCount === 1;
}

function companyDay(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(now);
  const value = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return `${value.year}-${value.month}-${value.day}`;
}

export function canonicalizeRadarUrl(value: string): string {
  const url = new URL(value);
  url.protocol = url.protocol.toLowerCase();
  url.hostname = url.hostname.toLowerCase();
  url.hash = "";
  for (const key of [...url.searchParams.keys()]) {
    if (/^(utm_.+|fbclid|gclid|spm)$/i.test(key)) url.searchParams.delete(key);
  }
  url.searchParams.sort();
  if (url.pathname !== "/") url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

export function sourceFingerprint(canonicalUrl: string): string {
  return createHash("sha256").update(`v1\n${canonicalUrl}`).digest("hex");
}

function dateOnly(value: string | Date | null): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : String(value).slice(0, 10);
}

export function createRadarService({
  pool,
  web,
  wechat,
  outlets,
  assessor,
  onIssuePromoted,
  promoteIssues = true,
  now = () => new Date(),
  scanTimeoutMs = RADAR_SCAN_TIMEOUT_MS,
  coverImage,
  articleText,
}: {
  pool: Pool;
  web: RadarWebAdapter;
  wechat?: RadarWechatAdapter;
  outlets?: RadarOutletAdapter;
  assessor: RadarAssessor;
  onIssuePromoted?: (issueId: string) => void;
  /** 信号够格时自动建议题（或挂到现有议题）；false 时只存信号，议题由一号位自己从信号建。 */
  promoteIssues?: boolean;
  now?: () => Date;
  scanTimeoutMs?: number;
  /** 给没有配图的来源取原文封面（og:image 等）；不传就不抓。单条失败或超时只是没有图，不影响入库。 */
  coverImage?: CoverImageFetcher;
  /** 给要落库的检索条目抓原文页全文（通用正文提取）；不传就只存检索摘要。失败、过短、登录墙都退回摘要。 */
  articleText?: ArticleFetcher;
}): RadarService {
  async function run(trigger: "manual" | "scheduled"): Promise<TRadarScanResponse> {
    const startedAt = now();
    let day = companyDay(startedAt, "Asia/Shanghai");
    let locked = false;
    let client: PoolClient | undefined;
    let scanTimer: NodeJS.Timeout | undefined;
    let timedOut = false;
    // warnings 会原样展示给 CEO：只写「本轮真的出了问题」的中文说明；
    // 截取上限、时间窗过滤、引文校验等常规记录和技术原因只进服务端日志。
    const notes: string[] = [];
    const logNotes = () => {
      if (notes.length) console.info(`radar ${trigger} scan ${day}: ${notes.join("; ")}`);
    };
    try {
      client = await pool.connect();
      const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [LOCK_KEY]);
      locked = lock.rows[0]?.locked === true;
      if (!locked) return { trigger, status: "busy", companyDay: day, createdSignals: 0, warnings: ["Radar scan already running"] };

      const result = await client.query<RadarConfigRow>(
        "SELECT timezone, lookback_hours, anchors, sources, scheduled_company_day::text AS scheduled_company_day FROM radar_config WHERE id = 'default'",
      );
      const config = result.rows[0];
      if (!config) throw new Error("RadarConfig missing");
      day = companyDay(startedAt, config.timezone);
      if (trigger === "scheduled" && dateOnly(config.scheduled_company_day) === day) {
        return { trigger, status: "skipped", companyDay: day, createdSignals: 0, warnings: [] };
      }
      if (!Array.isArray(config.anchors) || !config.anchors.every((anchor) => Value.Check(RadarAnchor, anchor))
        || !Value.Check(RadarSources, config.sources)) throw new Error("RadarConfig is invalid");
      const anchors = config.anchors as TRadarAnchor[];
      const sources = config.sources as TRadarSources;

      const running = { trigger, status: "running", companyDay: day, startedAt: startedAt.toISOString(), warnings: [] };
      await client.query(
        `UPDATE radar_config
            SET scheduled_company_day = CASE WHEN $1 = 'scheduled' THEN $2::date ELSE scheduled_company_day END,
                last_scheduled_at = CASE WHEN $1 = 'scheduled' THEN $3 ELSE last_scheduled_at END,
                last_run = $4::jsonb,
                updated_at = now()
          WHERE id = 'default'`,
        [trigger, day, startedAt, JSON.stringify(running)],
      );

      const warnings: string[] = [];
      const reason = (cause: unknown) => (cause as Error).message || String(cause);
      // 固定上限：监测方向与单批 assess 都有上限，避免无界 prompt
      const monitoredAnchors = anchors.slice(0, MAX_ANCHORS);
      if (anchors.length > monitoredAnchors.length) {
        warnings.push(`监测方向超过 ${MAX_ANCHORS} 个，本轮只看了前 ${monitoredAnchors.length} 个`);
      }
      const collected: TRadarSourceItem[] = [];
      // 网页结果归属的监测方向：时间窗过滤与去重之后按方向截取最新条目
      const webAnchorOf = new Map<TRadarSourceItem, string>();
      let attempted = 0;
      let succeeded = 0;
      const abort = new AbortController();
      // 单次扫描有时限：Provider 悬挂时释放锁并把失败写入 last_run，不无限占用后续扫描
      scanTimer = setTimeout(() => {
        timedOut = true;
        abort.abort(new Error(`Radar scan exceeded ${scanTimeoutMs}ms`));
      }, scanTimeoutMs);
      scanTimer.unref();
      const failedWebAnchors = new Set<string>();
      for (const site of sources.sites.filter((source) => source.enabled)) {
        for (const anchor of monitoredAnchors) {
          attempted += 1;
          try {
            const found = await web.search(
              { query: anchor.query, domains: site.domains, lookbackHours: config.lookback_hours },
              abort.signal,
            );
            for (const item of found) webAnchorOf.set(item, anchor.id);
            collected.push(...found);
            succeeded += 1;
          } catch (cause) {
            failedWebAnchors.add(anchor.id);
            notes.push(`Web source ${site.name} failed for ${anchor.id}: ${reason(cause)}`);
          }
        }
      }
      if (failedWebAnchors.size > 0) warnings.push(`网页搜索有 ${failedWebAnchors.size} 个监测方向没取到结果，这些方向本轮可能有遗漏`);
      for (const account of sources.wechatAccounts.filter((source) => source.enabled)) {
        attempted += 1;
        if (!wechat?.configured) {
          warnings.push(`公众号「${account.name}」还没接通，本轮没有读取`);
          continue;
        }
        try {
          collected.push(...await wechat.fetchLatest({ accountId: account.accountId, accountName: account.name }, abort.signal));
          succeeded += 1;
        } catch (cause) {
          warnings.push(`公众号「${account.name}」读取失败，本轮没有读到`);
          notes.push(`wechat ${account.name} failed: ${reason(cause)}`);
        }
      }
      // 发布方级来源（方案 A）：一次取整份最新列表，不按 anchor 相乘，不增加博查配额。
      // 窗口内零条目时单条 warning；绝不回落到全网检索，否则「限定 7 家」就成了谎话。
      let outletCollected = 0;
      for (const source of (sources.outlets ?? []).filter((entry) => entry.enabled)) {
        if (outletCollected >= MAX_OUTLET_ITEMS) {
          notes.push(`发布方来源超过总上限 ${MAX_OUTLET_ITEMS} 条，剩余来源未采集`);
          break;
        }
        attempted += 1;
        if (!outlets?.configured) {
          warnings.push(`媒体来源「${source.name}」还没接通，本轮没有读取`);
          continue;
        }
        try {
          const fetched = await outlets.fetchLatest(
            { outletIds: source.outlets, lookbackHours: config.lookback_hours },
            abort.signal,
          );
          const accepted = fetched.slice(0, MAX_OUTLET_ITEMS - outletCollected);
          collected.push(...accepted);
          outletCollected += accepted.length;
          succeeded += 1;
          if (accepted.length === 0) notes.push(`发布方来源 ${source.name} 在 ${config.lookback_hours} 小时窗口内无条目`);
          if (accepted.length < fetched.length) notes.push(`发布方来源 ${source.name} 超过总上限 ${MAX_OUTLET_ITEMS} 条，已截断`);
        } catch (cause) {
          warnings.push(`媒体来源「${source.name}」读取失败，本轮没有读到`);
          notes.push(`outlet ${source.name} failed: ${reason(cause)}`);
        }
      }
      if (attempted === 0) warnings.push("雷达还没有启用任何来源");
      if (succeeded === 0) {
        const response: TRadarScanResponse = { trigger, status: "failed", companyDay: day, createdSignals: 0, warnings };
        await client.query("UPDATE radar_config SET last_run = $1::jsonb, updated_at = now() WHERE id = 'default'", [
          JSON.stringify({ ...response, startedAt: startedAt.toISOString(), completedAt: now().toISOString() }),
        ]);
        logNotes();
        return response;
      }

      const earliest = startedAt.getTime() - config.lookback_hours * 60 * 60 * 1000;
      const unique = new Map<string, FingerprintedRadarSource>();
      const webAnchorByFingerprint = new Map<string, string | undefined>();
      for (const source of collected) {
        const publishedAt = Date.parse(source.publishedAt);
        if (!Number.isFinite(publishedAt) || publishedAt < earliest || publishedAt > startedAt.getTime()) {
          notes.push(`来源超出时间窗: ${source.title}`);
          continue;
        }
        try {
          const canonicalUrl = canonicalizeRadarUrl(source.url);
          const fingerprint = sourceFingerprint(canonicalUrl);
          unique.set(fingerprint, { ...source, url: canonicalUrl, sourceFingerprint: fingerprint });
          webAnchorByFingerprint.set(fingerprint, webAnchorOf.get(source));
        } catch {
          notes.push(`来源 URL 无效: ${source.title}`);
        }
      }
      // 已存成信号的来源不再研判：时间窗跨多天，同一篇文章会被反复检索到
      if (unique.size > 0) {
        const known = await client.query<{ source_fingerprint: string }>(
          "SELECT source_fingerprint FROM signals WHERE source_fingerprint = ANY($1::text[])",
          [[...unique.keys()]],
        );
        for (const { source_fingerprint } of known.rows) unique.delete(source_fingerprint);
      }
      // 同一篇文章不同来源（转载、移动版、不同检索词命中的不同 URL）只保留一条：URL 指纹之外再按文章标题核心判重，
      // 先比最近已入库的信号，再比本轮内部（先到先留）。
      if (unique.size > 0) {
        const recent = (await client.query<{ source_title: string }>(
          `SELECT source_title FROM signals WHERE collected_at > now() - make_interval(days => $1)
            ORDER BY collected_at DESC LIMIT $2`,
          [ARTICLE_DEDUPE_LOOKBACK_DAYS, MAX_RECENT_SIGNAL_TITLES],
        )).rows.map((row) => row.source_title);
        const kept: string[] = [];
        let sameArticleSkipped = 0;
        for (const [fingerprint, source] of [...unique]) {
          if ([...recent, ...kept].some((title) => sameArticle(title, source.title))) {
            unique.delete(fingerprint);
            sameArticleSkipped += 1;
            continue;
          }
          kept.push(source.title);
        }
        if (sameArticleSkipped > 0) notes.push(`同一篇文章的其他来源略过 ${sameArticleSkipped} 条`);
      }
      // 每个监测方向的网页结果只留最新几条（无发布时间的条目已被时间窗剔除）
      const webByAnchor = new Map<string, FingerprintedRadarSource[]>();
      for (const [fingerprint, anchorId] of webAnchorByFingerprint) {
        if (!anchorId || !unique.has(fingerprint)) continue;
        const items = webByAnchor.get(anchorId) ?? [];
        items.push(unique.get(fingerprint)!);
        webByAnchor.set(anchorId, items);
      }
      let skippedWeb = 0;
      for (const items of webByAnchor.values()) {
        items.sort((left, right) => Date.parse(right.publishedAt) - Date.parse(left.publishedAt));
        for (const item of items.slice(MAX_WEB_ITEMS_PER_ANCHOR)) {
          unique.delete(item.sourceFingerprint);
          skippedWeb += 1;
        }
      }
      if (skippedWeb > 0) notes.push(`网页搜索每个监测方向只取最新 ${MAX_WEB_ITEMS_PER_ANCHOR} 条，本轮略过 ${skippedWeb} 条`);

      let createdSignals = 0;
      let assessFailed = false;
      if (unique.size > 0) {
        const anchorById = new Map(monitoredAnchors.map((anchor) => [anchor.id, anchor]));
        const batches: FingerprintedRadarSource[][] = [];
        const deduped = [...unique.values()];
        for (let index = 0; index < deduped.length; index += ASSESS_BATCH_SIZE) {
          batches.push(deduped.slice(index, index + ASSESS_BATCH_SIZE));
        }
        // 现有待决策议题交给研判模型判重：同一决策问题返回 attachToIssueId，不新建
        const existingIssues: RadarExistingIssue[] = (await client.query<{
          id: string; title: string; location: TIssueLocation; core: string | null;
        }>(
          `SELECT id, title, location,
                  COALESCE(research->'doc'->>'summary', origin_ref->>'strategicImpact', origin_ref->>'summary') AS core
             FROM issues WHERE status = 'pending' ORDER BY updated_at DESC LIMIT $1`,
          [MAX_EXISTING_ISSUES],
        )).rows.map((row) => ({ id: row.id, title: row.title, coreQuestion: row.core ? row.core.slice(0, 300) : null, location: row.location }));
        const candidates: TRadarCandidateSubmission["candidates"] = [];
        let failedBatches = 0;
        let failedSources = 0;
        let completedBatches = 0;
        let interruptedSources = 0;
        let nextBatch = 0;
        const assessWorker = async () => {
          // 某个 candidate 运行没有及时响应 abort 时，绝不能继续启动后续 batch。
          // 否则扫描时限只会成为提示，扫描仍可能跑数分钟。
          while (nextBatch < batches.length && !abort.signal.aborted) {
            const batch = batches[nextBatch];
            nextBatch += 1;
            try {
              candidates.push(...(await assessor.assess({ anchors: monitoredAnchors, sources: batch, existingIssues }, abort.signal)).candidates);
              completedBatches += 1;
            } catch (cause) {
              if (abort.signal.aborted) {
                // 超时中断：计入未研判，不算批失败
                interruptedSources += batch.length;
              } else {
                // 批失败：该批不保存候选，不影响其他批
                failedBatches += 1;
                failedSources += batch.length;
                notes.push(`Radar assess 批失败: ${reason(cause)}`);
              }
            }
          }
        };
        await Promise.all(Array.from({ length: ASSESS_CONCURRENCY }, assessWorker));
        const unassessed = interruptedSources + batches.slice(nextBatch).flat().length;
        if (unassessed > 0) {
          // 超时：已完成批次的候选照常校验落库；一批都没完成时整次扫描仍标为 failed
          if (completedBatches === 0) throw abort.signal.reason ?? new Error(`Radar scan exceeded ${scanTimeoutMs}ms`);
          warnings.push(`本轮有 ${unassessed} 条来源没来得及研判（扫描超过 ${scanLimitText(scanTimeoutMs)}上限）`);
        }
        assessFailed = failedBatches === batches.length;
        if (failedSources > 0) warnings.push(`有 ${failedSources} 条来源研判失败，本轮可能漏掉其中的信号`);
        let failedSaves = 0;
        // 升级议题的标题面向 CEO：战场代号（TK、FDD）换成中文公司名
        const battlefieldNames = candidates.length
          ? ((await client.query<BattlefieldName>("SELECT id, name, code FROM battlefield_config")).rows) : [];
        // 检索条目的全文：研判（含引文）是对着检索摘要做的，所以只给通过引文校验、确定要落库的检索条目抓原文页，
        // 至多 15 篇；全文逐字包含这条来源上每条候选的引文（含 red 截止日引文）才替换，否则保留摘要，引文永远是原文子串。
        if (articleText) {
          const quotesBySource = new Map<string, string[]>();
          for (const candidate of candidates) {
            const source = unique.get(candidate.sourceFingerprint);
            if (!source || source.sourceRef.type !== "web-search" || !anchorById.has(candidate.anchorId)
              || !source.excerpt.includes(candidate.evidenceQuote)) continue;
            const evidence = candidate.promotion?.urgency.decisionByEvidence?.quote;
            quotesBySource.set(source.sourceFingerprint, [
              ...(quotesBySource.get(source.sourceFingerprint) ?? []), candidate.evidenceQuote, ...(evidence ? [evidence] : []),
            ]);
          }
          const pages = [...quotesBySource.keys()].map((fingerprint) => unique.get(fingerprint)!);
          const articles = await fetchArticles(pages.map((source) => ({ url: source.url, title: source.title })), articleText, { signal: abort.signal });
          let adopted = 0;
          for (const source of pages) {
            const article = articles.get(source.url);
            if (!fullTextKeepsQuotes(source.excerpt, article, quotesBySource.get(source.sourceFingerprint)!)) continue;
            unique.set(source.sourceFingerprint, {
              ...source,
              excerpt: article.text,
              sourceRef: { ...source.sourceRef, fullText: true },
              ...(article.images.length ? { images: article.images } : {}),
            });
            adopted += 1;
          }
          if (pages.length) notes.push(`检索条目原文页全文 ${adopted}/${pages.length} 篇，其余保留检索摘要`);
        }
        // 原文封面：只给要落库、自身没带配图的来源抓，并发且各自带超时；抓不到就按无图入库。
        const covers = coverImage
          ? await fetchCovers(
              candidates.flatMap((candidate) => {
                const source = unique.get(candidate.sourceFingerprint);
                return source && !source.images?.length ? [source.url] : [];
              }),
              coverImage,
            )
          : new Map<string, string>();
        for (const candidate of candidates) {
          const source = unique.get(candidate.sourceFingerprint);
          const anchor = anchorById.get(candidate.anchorId);
          if (!source || !anchor || !source.excerpt.includes(candidate.evidenceQuote)) {
            notes.push(`候选未通过来源引文或归属校验: ${candidate.sourceFingerprint}`);
            continue;
          }
          // 单事务：Signal 与自动升级的 pending Issue 要么一起落库，要么都不落
          await client.query("BEGIN");
          try {
            const inserted = await client.query(
              `INSERT INTO signals
                 (id, version, source_type, source_fingerprint, source_title, source_url, published_at, excerpt,
                  source_ref, anchor_id, location, summary, strategic_impact, evidence_quote, unknowns, score, source_images)
               VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11, $12, $13, $14::jsonb, $15::jsonb, $16::jsonb)
               ON CONFLICT (source_fingerprint) DO NOTHING
               RETURNING id`,
              [
                randomUUID(), source.sourceType, source.sourceFingerprint, source.title, source.url, source.publishedAt,
                source.excerpt, JSON.stringify(source.sourceRef), candidate.anchorId, JSON.stringify(anchor.location),
                candidate.summary, candidate.strategicImpact, candidate.evidenceQuote, JSON.stringify(candidate.unknowns),
                JSON.stringify(candidate.score),
                JSON.stringify(source.images?.length ? source.images : covers.has(source.url) ? [{ src: covers.get(source.url), after: 0 }] : []),
              ],
            );
            const signalInserted = inserted.rowCount === 1;
            let newlyPromotedIssueId: string | null = null;
            if (signalInserted && candidate.promotion && promoteIssues) {
              const signalId = inserted.rows[0].id as string;
              const promoted = assessPromotion({
                promotion: candidate.promotion,
                excerpt: source.excerpt,
                evidenceQuote: candidate.evidenceQuote,
                score: candidate.score,
              });
              const issueTitle = promoted.ok ? plainCompanyNames(promoted.promotion.decisionQuestion, battlefieldNames) : "";
              // 升级前查重（事务内读最新的待决策议题，含本轮刚建的）：模型判定的同一决策问题优先；
              // 模型漏判时按同战场标题相似度兜底。命中就把本条信号挂靠为补充依据，不新建议题。
              let attachTarget: { issue: { id: string; title: string }; via: "model" | "similarity" } | null = null;
              if (promoted.ok) {
                const pending = (await client.query<{ id: string; title: string; location: TIssueLocation }>(
                  "SELECT id, title, location FROM issues WHERE status = 'pending'",
                )).rows;
                const location = promoted.promotion.location;
                const named = candidate.attachToIssueId
                  ? pending.find((issue) => issue.id === candidate.attachToIssueId && sameIssueScope(location, issue.location))
                  : undefined;
                if (named) attachTarget = { issue: named, via: "model" };
                else {
                  if (candidate.attachToIssueId) notes.push(`模型给的挂靠议题不存在、已不在待决策或不在同一战场: ${candidate.attachToIssueId}`);
                  const companyNames = battlefieldNames.flatMap((entry) => [entry.name, entry.code ?? ""]);
                  const similar = findSimilarIssue({ title: issueTitle, location }, pending, companyNames);
                  if (similar) attachTarget = { issue: similar.issue, via: "similarity" };
                }
              }
              if (!promoted.ok) {
                notes.push(`候选未通过升级门槛: ${promoted.reason}`);
              } else if (attachTarget) {
                await attachSignalToIssue(client, {
                  issueId: attachTarget.issue.id,
                  signalId,
                  promotionFingerprint: promoted.promotion.fingerprint,
                  supplement: {
                    signalId, sourceTitle: source.title, sourceUrl: source.url, evidenceQuote: candidate.evidenceQuote,
                    summary: candidate.summary, attachedAt: now().toISOString(), via: attachTarget.via,
                  },
                });
                notes.push(`候选「${issueTitle}」与现有议题「${attachTarget.issue.title}」是同一决策问题（${attachTarget.via}），已作为补充依据挂靠`);
              } else {
                const created = await client.query<{ id: string }>(
                  `INSERT INTO issues
                     (id, version, origin, origin_ref, title, location, urgency, status, research, promotion_fingerprint)
                   VALUES ($1, 1, 'radar', $2::jsonb, $3, $4::jsonb, $5::jsonb, 'pending', $6::jsonb, $7)
                   ON CONFLICT DO NOTHING
                   RETURNING id`,
                  [
                    randomUUID(),
                    JSON.stringify({
                      signalId, sourceFingerprint: source.sourceFingerprint, anchorId: candidate.anchorId,
                      summary: candidate.summary, strategicImpact: candidate.strategicImpact,
                      options: promoted.promotion.options, evidenceQuote: candidate.evidenceQuote,
                      // 自动升级、无人参与：AI 识别的候选议题（nature=ai_suggested，origin=radar；界面只显示来自雷达，dataOrigin.ts）。
                      nature: "ai_suggested",
                    }),
                    issueTitle,
                    JSON.stringify(promoted.promotion.location),
                    JSON.stringify(promoted.promotion.urgency),
                    JSON.stringify({
                      status: "pending", pendingSince: new Date().toISOString(),
                      runId: null, previousRunIds: [], error: null,
                    }),
                    promoted.promotion.fingerprint,
                  ],
                );
                const issueId = created.rowCount === 1
                  ? created.rows[0].id
                  : (await client.query<{ id: string }>(
                      "SELECT id FROM issues WHERE promotion_fingerprint = $1",
                      [promoted.promotion.fingerprint],
                    )).rows[0]?.id;
                // 重复执行只得到一个 Issue：第二个等价候选只绑定到已有 Issue，不新建
                if (issueId) {
                  await client.query("UPDATE signals SET promoted_issue_id = $2, promotion_fingerprint = $3 WHERE id = $1", [
                    signalId, issueId, promoted.promotion.fingerprint,
                  ]);
                }
                if (created.rowCount === 1 && issueId) newlyPromotedIssueId = issueId;
              }
            }
            await client.query("COMMIT");
            // 只有提交成功的 Signal 才计入本次扫描结果
            if (signalInserted) createdSignals += 1;
            // 提交后启动唯一深度预研；不阻塞扫描，也不在事务内调模型
            if (newlyPromotedIssueId) onIssuePromoted?.(newlyPromotedIssueId);
          } catch (cause) {
            await client.query("ROLLBACK").catch(() => undefined);
            failedSaves += 1;
            notes.push(`候选保存失败: ${reason(cause)}`);
          }
        }
        if (failedSaves > 0) warnings.push(`有 ${failedSaves} 条信号保存失败`);
      }

      // 全部 assess 批失败等于“没有研判结果”：如实标为 failed，而非 completed
      const status: TRadarScanResponse["status"] = assessFailed ? "failed" : "completed";
      const response: TRadarScanResponse = { trigger, status, companyDay: day, createdSignals, warnings };
      await client.query("UPDATE radar_config SET last_run = $1::jsonb, updated_at = now() WHERE id = 'default'", [
        JSON.stringify({ ...response, startedAt: startedAt.toISOString(), completedAt: now().toISOString() }),
      ]);
      logNotes();
      return response;
    } catch (cause) {
      notes.push(`scan failed: ${(cause as Error).message || String(cause)}`);
      logNotes();
      const warnings = [timedOut ? `扫描超过 ${scanLimitText(scanTimeoutMs)}上限，没有完成` : "扫描出错，没有完成，请稍后再试"];
      const response: TRadarScanResponse = { trigger, status: "failed", companyDay: day, createdSignals: 0, warnings };
      if (client && locked) await client.query("UPDATE radar_config SET last_run = $1::jsonb, updated_at = now() WHERE id = 'default'", [
        JSON.stringify({ ...response, startedAt: startedAt.toISOString(), completedAt: now().toISOString() }),
      ]).catch(() => undefined);
      return response;
    } finally {
      clearTimeout(scanTimer);
      if (client) {
        if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_KEY]).catch(() => undefined);
        client.release();
      }
    }
  }

  /**
   * LangSmith：一次扫描 = 一个 Turn（rdr-<公司日>-<随机>），Thread = 公司雷达；检索与各批 radar-assess 都挂在它下面。
   * 根节点按需物化：被占用、当日已扫描而跳过的扫描没有任何真实步骤，不留轨迹。
   */
  const tracedRun = (trigger: "manual" | "scheduled") => tracedTurn({
    resolve: async () => ({
      agentRole: AGENT_ROLES.radarAssess,
      logicalTurnId: `rdr-${companyDay(now(), "Asia/Shanghai").replace(/-/g, "")}-${randomTurnSuffix()}`,
      attempt: 1,
      threadId: await stableThreadId(pool.query.bind(pool), "radar|company"),
      scope: "global",
      accepts: ["radar-assess"],
    }),
    outputs: (response) => ({ status: response.status, createdSignals: response.createdSignals }),
    errorOf: (response) => (response.status === "failed" ? "radar scan failed" : undefined),
  }, () => run(trigger));

  return {
    runManual: () => tracedRun("manual"),
    runScheduled: () => tracedRun("scheduled"),
    async recoverStaleRuns(): Promise<void> {
      const client = await pool.connect();
      let locked = false;
      try {
        // 正在扫描的进程持有同一 advisory lock：不得把它的运行中标为中断
        const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [LOCK_KEY]);
        locked = lock.rows[0]?.locked === true;
        if (!locked) return;
        await client.query(
          `UPDATE radar_config
              SET last_run = jsonb_set(
                    jsonb_set(last_run, '{status}', '"failed"'),
                    '{warnings}',
                    COALESCE(last_run->'warnings', '[]'::jsonb) || '"扫描被服务重启打断，没有完成"'::jsonb
                  ),
                  updated_at = now()
            WHERE id = 'default' AND last_run->>'status' = 'running'`,
        );
        await client.query(
          `UPDATE agent_runs
              SET status = 'failed', error = '进程重启中断，未产生候选', completed_at = now()
            WHERE kind = 'radar-assess' AND status = 'running'`,
        );
      } finally {
        if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [LOCK_KEY]).catch(() => undefined);
        client.release();
      }
    },
    providerStatus: { web: web.configured, wechat: wechat?.configured === true, outlets: outlets?.configured === true },
  };
}
