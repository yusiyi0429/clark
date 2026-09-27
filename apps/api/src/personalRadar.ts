import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { TPersonalRadarJudgeSubmission, TPersonalRadarRun, TRadarDirection, TRadarSourceItem } from "@warmap/contracts";
import type { CompanyMemoryRepository } from "./companyMemory.js";
import type { GithubTrendingReader, TrendingRepo, TrendingSince } from "./githubTrending.js";
import { roleOf } from "./memberAccess.js";
import type { Query } from "./meetingStore.js";
import { sourceLabel } from "./personalSignals.js";
import { canonicalizeRadarUrl, sourceFingerprint, type RadarOutletAdapter, type RadarWebAdapter } from "./radar.js";
import { directionId, readStoredSource, urlWithinSite } from "./radarSettings.js";

/**
 * 个人雷达扫描（ADR-0021）：进程内串行队列，一次扫一个人；只写 person_radar 与 person_radar_signals。
 * 结果只给本人看：这里没有升级、没有议题，也不碰公司雷达的配置与信号。
 */

/** 一次扫描的固定上限（设计 §2.3）。 */
const LOOKBACK_HOURS = 48;
const MAX_WEB_ITEMS_PER_DIRECTION = 3;
const MAX_FEED_ITEMS = 20;
/** 一版榜单最多判几个（按时段内 star 多的先）：榜单每天约 25 个，全判会挤掉其他来源。 */
const MAX_LIST_ITEMS = 10;
const MAX_CANDIDATES = 30;
const JUDGE_BATCH_SIZE = 10;
const JUDGE_EXCERPT_CHARS = 2_000;
const MIN_RELEVANCE = 3;
/** 每人每个 Company Day 最多保留的条数，按 collected_at 计；这是上限，不是产量目标。 */
export const DAILY_CAP = 10;
const SCAN_TIMEOUT_MS = 90_000;
const MANUAL_COOLDOWN_MS = 10 * 60_000;

export type PersonalRadarTrigger = "scheduled" | "manual";

export type PersonalRadarJudgeInput = {
  personId: string;
  directions: TRadarDirection[];
  /** 榜单条目没有发布时间（publishedAt 为 null），只有上榜日 listedOn。 */
  sources: { sourceFingerprint: string; title: string; excerpt: string; publishedAt: string | null; listedOn?: string; from: string }[];
};

/** 判定器：给一批来源按本人方向打分；schema 里没有升级字段（contracts PersonalRadarJudgeSubmission）。 */
export type PersonalRadarJudge = {
  judge(input: PersonalRadarJudgeInput, signal: AbortSignal): Promise<TPersonalRadarJudgeSubmission>;
};

export type PersonalRadarService = {
  providerStatus: { webSearch: boolean };
  /**
   * 已在队列里的人忽略；正在扫描的人排到后面，由认领语句决定要不要再扫
   * （定时扫描今天扫过就跳过；手动扫描已先过 /scan 的 CAS，库里是排队中）。
   */
  enqueue(personId: string, trigger: PersonalRadarTrigger): void;
  /** 把今天还没扫过、开着雷达的成员排进队列，立即返回。 */
  runScheduled(): Promise<void>;
  /** 启动补偿：排队中、扫描中的标为 failed，不自动重跑。 */
  recoverStaleRuns(): Promise<void>;
  idle(): Promise<void>;
};

/** 一条候选来源：网页与订阅源有发布时间；榜单条目没有，只有上榜日（02b），不伪造发布时间。 */
type SourceItem = Omit<TRadarSourceItem, "sourceType" | "publishedAt" | "sourceRef"> & {
  sourceType: TRadarSourceItem["sourceType"] | "list";
  publishedAt: string | null;
  listedOn?: string;
  sourceRef: unknown;
};
type Candidate = SourceItem & { sourceFingerprint: string; /** 网页结果归属的方向；订阅源与榜单条目没有 */ directionId?: string };
type Judged = TPersonalRadarJudgeSubmission["candidates"][number];
type Outcome = { status: "completed" | "failed"; createdSignals: number };

const message = (cause: unknown) => (cause as Error | undefined)?.message || String(cause);
const stringList = (value: unknown): string[] | null =>
  Array.isArray(value) && value.every((item) => typeof item === "string" && item.length > 0) ? value : null;
const companyDay = (at: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(at);

const PERIOD = { daily: "今日", weekly: "本周", monthly: "本月" } as const;

/** 榜单条目进管线：只记上榜日；原文如实拼成一句，仓库没写描述就写「没有描述」，不编。 */
function listItem(repo: TrendingRepo, since: TrendingSince, listedOn: string): SourceItem {
  const facts = [repo.language ? `语言 ${repo.language}` : null, repo.starsInPeriod === null ? null : `${PERIOD[since]} ${repo.starsInPeriod} star`]
    .filter(Boolean).join("，");
  return {
    sourceType: "list",
    title: repo.fullName,
    url: repo.url,
    publishedAt: null,
    listedOn,
    excerpt: `${repo.fullName}：${repo.description ?? "没有描述"}${facts ? `（${facts}）` : ""}`,
    sourceRef: { type: "list", provider: "github-trending", listName: "GitHub Trending", language: repo.language, starsInPeriod: repo.starsInPeriod, since },
  };
}

/** 本人在这个 Company Day（Asia/Shanghai）已经收了几条。 */
export async function countCollectedToday(q: Query, personId: string, at: Date): Promise<number> {
  const result = await q(
    `SELECT count(*)::int AS count FROM person_radar_signals
      WHERE person_id = $1 AND (collected_at AT TIME ZONE 'Asia/Shanghai')::date = ($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date`,
    [personId, at],
  );
  return result.rows[0].count as number;
}

export type ManualScanRejection = { status: 409 | 429; code: string; message: string; retryAfterSeconds?: number };

/** 手动扫描：今天收满先拒；再用一条 CAS 语句排队（开着、不在冷却、不在排队或扫描中）；排不上再读一次说明原因。 */
export async function requestManualScan(q: Query, personId: string, at: Date): Promise<{ queued: true } | { rejected: ManualScanRejection }> {
  if (await countCollectedToday(q, personId, at) >= DAILY_CAP) {
    return { rejected: { status: 409, code: "RADAR_DAILY_CAP_REACHED", message: `今天已收满 ${DAILY_CAP} 条，明天再扫` } };
  }
  const queued = await q(
    `UPDATE person_radar
        SET last_manual_scan_at = $2,
            last_run = jsonb_build_object('trigger', 'manual', 'status', 'queued', 'queuedAt', $3::text, 'createdSignals', 0, 'warnings', '[]'::jsonb)
      WHERE person_id = $1 AND enabled
        AND (last_manual_scan_at IS NULL OR last_manual_scan_at <= $4)
        AND COALESCE(last_run->>'status', '') NOT IN ('queued', 'running')
      RETURNING person_id`,
    [personId, at, at.toISOString(), new Date(at.getTime() - MANUAL_COOLDOWN_MS)],
  );
  if (queued.rowCount === 1) return { queued: true };
  const row = (await q("SELECT enabled, last_run->>'status' AS status, last_manual_scan_at FROM person_radar WHERE person_id = $1", [personId]))
    .rows[0] as { enabled: boolean; status: string | null; last_manual_scan_at: Date | null } | undefined;
  if (!row?.enabled) return { rejected: { status: 409, code: "RADAR_DISABLED", message: "雷达还没开，先在设置里打开" } };
  const retryAt = row.last_manual_scan_at ? row.last_manual_scan_at.getTime() + MANUAL_COOLDOWN_MS : 0;
  if (row.status !== "queued" && row.status !== "running" && retryAt > at.getTime()) {
    const retryAfterSeconds = Math.ceil((retryAt - at.getTime()) / 1000);
    return { rejected: { status: 429, code: "RADAR_SCAN_RATE_LIMITED", message: `刚扫过，${Math.ceil(retryAfterSeconds / 60)} 分钟后可以再扫一次`, retryAfterSeconds } };
  }
  // 正在排队或扫描；两条语句之间状态刚变化的少见情况也按这个说
  return { rejected: { status: 409, code: "RADAR_SCAN_IN_PROGRESS", message: "正在扫描，稍等片刻" } };
}

export function createPersonalRadarService({
  pool,
  companyMemory,
  web,
  outlets,
  judge,
  trending,
  now = () => new Date(),
  scanTimeoutMs = SCAN_TIMEOUT_MS,
}: {
  pool: Pool;
  companyMemory: Pick<CompanyMemoryRepository, "searchPeople">;
  /** 与公司雷达共用的博查 adapter：从不传 domains（博查实测忽略 site:）。 */
  web: RadarWebAdapter;
  /** 与公司雷达共用的发布方 feed adapter，直接用目录 id 调用。 */
  outlets: RadarOutletAdapter;
  judge: PersonalRadarJudge;
  /** GitHub Trending 读取器（02b）；没接上时榜单来源只写 warning。 */
  trending?: GithubTrendingReader;
  now?: () => Date;
  scanTimeoutMs?: number;
}): PersonalRadarService {
  type Entry = { personId: string; trigger: PersonalRadarTrigger; queuedAt: string };
  const pending: Entry[] = [];
  /**
   * 排队中的人（不含正在扫描的）：扫描刚写完 last_run 时，手动请求可能已被 CAS 接受；
   * 把正在扫描的人也算进来会丢掉这次请求，让它一直停在「排队中」。
   */
  const queued = new Set<string>();
  let draining: Promise<void> | null = null;
  const q: Query = (sql, params) => pool.query(sql, params);

  /** 采集：来源为空时每个方向全网检索一次；来源不为空时只看这些来源，不回落全网。 */
  async function collect(directions: TRadarDirection[], values: string[], signal: AbortSignal, warnings: string[], listedOn: string) {
    const found: { item: SourceItem; directionId?: string }[] = [];
    let attempted = 0;
    let succeeded = 0;
    const plans = values.map((value) => readStoredSource(value, web.configured));
    const outletNames = new Map(plans.flatMap((plan) => (plan.outletId ? [[plan.outletId, plan.setting.name ?? plan.setting.value] as const] : [])));
    const sites = plans.filter((plan) => plan.setting.kind === "site" && web.configured).map((plan) => plan.setting.value);
    for (const { setting } of plans) {
      // 暂不支持、没开通检索的网站、没接上读取器的榜单：扫描时跳过，如实写原因
      if (setting.kind === "unsupported" || (setting.kind === "site" && !web.configured)) warnings.push(`${setting.name ?? setting.value}：${setting.note}`);
      if (setting.kind === "list" && !trending) warnings.push(`${setting.name ?? setting.value}：榜单读取器没有接上，这次没读`);
    }
    // 榜单（02b）：每一版读一次页面，按时段内 star 多的先取前 10；页面结构变了、空榜都写 warning
    for (const { setting, list } of plans) {
      if (!list || !trending || signal.aborted) continue;
      attempted += 1;
      try {
        const { repos, warnings: notes } = await trending.read(list, signal);
        warnings.push(...notes);
        const top = [...repos].sort((left, right) => (right.starsInPeriod ?? -1) - (left.starsInPeriod ?? -1)).slice(0, MAX_LIST_ITEMS);
        for (const repo of top) found.push({ item: listItem(repo, list.since, listedOn) });
        succeeded += 1;
      } catch (cause) {
        if (!signal.aborted) warnings.push(`${setting.name ?? setting.value}读取失败：${message(cause)}`);
      }
    }
    const searchAll = values.length === 0;
    if (searchAll && !web.configured) warnings.push("全网检索未开通，只写方向暂时读不到");
    if (web.configured && (searchAll || sites.length > 0)) {
      for (const direction of directions) {
        if (signal.aborted) break;
        attempted += 1;
        try {
          const items = await web.search({ query: direction.text, lookbackHours: LOOKBACK_HOURS }, signal);
          for (const item of items) {
            if (searchAll || sites.some((site) => urlWithinSite(item.url, site))) found.push({ item, directionId: direction.id });
          }
          succeeded += 1;
        } catch (cause) {
          if (!signal.aborted) warnings.push(`全网检索「${direction.text}」失败：${message(cause)}`);
        }
      }
    }
    if (outletNames.size > 0 && !signal.aborted) {
      attempted += 1;
      try {
        const items = await outlets.fetchLatest({ outletIds: [...outletNames.keys()], lookbackHours: LOOKBACK_HOURS }, signal);
        for (const [outletId, name] of outletNames) {
          if (!items.some((item) => item.sourceRef.type === "outlet" && item.sourceRef.outletId === outletId)) {
            warnings.push(`${name}：${LOOKBACK_HOURS} 小时内没有新条目`);
          }
        }
        found.push(...items.map((item) => ({ item })));
        succeeded += 1;
      } catch (cause) {
        if (!signal.aborted) warnings.push(`订阅源读取失败：${message(cause)}`);
      }
    }
    return { found, attempted, succeeded };
  }

  async function scan(personId: string, row: { directions: unknown; sources: unknown }, startedAt: Date, warnings: string[]): Promise<Outcome> {
    const texts = stringList(row.directions);
    const values = stringList(row.sources);
    if (!texts || !values) throw new Error("雷达设置数据无效");
    const directions = texts.map((text) => ({ id: directionId(text, "person"), text }));
    const remaining = DAILY_CAP - await countCollectedToday(q, personId, startedAt);
    // 今天收满就短路：不调博查，也不调模型
    if (remaining <= 0) {
      warnings.push(`今天已收满 ${DAILY_CAP} 条`);
      return { status: "completed", createdSignals: 0 };
    }

    const limitText = `超过 ${scanTimeoutMs / 1000} 秒上限`;
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(new Error(`扫描${limitText}`)), scanTimeoutMs);
    timer.unref();
    try {
      const { found, attempted, succeeded } = await collect(directions, values, abort.signal, warnings, companyDay(startedAt));
      if (abort.signal.aborted) throw new Error(`扫描${limitText}，已中断`);
      if (attempted > 0 && succeeded === 0) return { status: "failed", createdSignals: 0 };

      // 时间窗 [开始 − 48 小时, 开始]；榜单条目没有发布时间，按今天的上榜日收。按规范化网址在批内去重，再去掉本人已有的
      const earliest = startedAt.getTime() - LOOKBACK_HOURS * 3_600_000;
      const timeOf = (item: SourceItem) => (item.publishedAt === null ? startedAt.getTime() : Date.parse(item.publishedAt));
      const newestFirst = (left: SourceItem, right: SourceItem) => timeOf(right) - timeOf(left);
      const unique = new Map<string, Candidate>();
      for (const { item, directionId: from } of found) {
        const at = timeOf(item);
        if (!Number.isFinite(at) || at < earliest || at > startedAt.getTime()) continue;
        let url: string;
        try {
          url = canonicalizeRadarUrl(item.url);
        } catch {
          continue;
        }
        const fingerprint = sourceFingerprint(url);
        if (!unique.has(fingerprint)) unique.set(fingerprint, { ...item, url, sourceFingerprint: fingerprint, directionId: from });
      }
      if (unique.size > 0) {
        const known = await q(
          "SELECT source_fingerprint FROM person_radar_signals WHERE person_id = $1 AND source_fingerprint = ANY($2::text[])",
          [personId, [...unique.keys()]],
        );
        for (const { source_fingerprint } of known.rows as { source_fingerprint: string }[]) unique.delete(source_fingerprint);
      }

      // 截断：每个方向的网页结果留最新 3 条，订阅源最多 20 条（榜单读取时已按版限量），合计最多 30 条，新的优先
      const all = [...unique.values()];
      const webKept = directions.flatMap((direction) =>
        all.filter((item) => item.directionId === direction.id).sort(newestFirst).slice(0, MAX_WEB_ITEMS_PER_DIRECTION));
      const feedKept = all.filter((item) => item.directionId === undefined && item.sourceType !== "list").sort(newestFirst).slice(0, MAX_FEED_ITEMS);
      const listKept = all.filter((item) => item.sourceType === "list");
      const candidates = [...webKept, ...feedKept, ...listKept].sort(newestFirst).slice(0, MAX_CANDIDATES);
      // 截取上限与引文复核是常规过滤：只进服务端日志，不展示给成员
      if (candidates.length < all.length) console.info(`personal radar ${personId}: 条目超过上限，只研判最新的 ${candidates.length} 条，略过 ${all.length - candidates.length} 条`);
      if (candidates.length === 0) {
        if (succeeded > 0) warnings.push(`${LOOKBACK_HOURS} 小时内没有新条目`);
        return { status: "completed", createdSignals: 0 };
      }

      // 判定：每批 10 条串行，每批开始前看是否超时；复核由代码做
      const ownDirections = new Set(directions.map((direction) => direction.id));
      const accepted = new Map<string, { candidate: Judged; source: Candidate }>();
      let completedBatches = 0;
      let unassessed = 0;
      let rejected = 0;
      for (let index = 0; index < candidates.length; index += JUDGE_BATCH_SIZE) {
        if (abort.signal.aborted) {
          unassessed += candidates.length - index;
          break;
        }
        const batch = candidates.slice(index, index + JUDGE_BATCH_SIZE);
        // 判定只看每条原文的前 2000 字，引文也只在这 2000 字里核对
        const seen = new Map(batch.map((source) => [source.sourceFingerprint, { source, excerpt: Array.from(source.excerpt).slice(0, JUDGE_EXCERPT_CHARS).join("") }]));
        try {
          const submission = await judge.judge({
            personId,
            directions,
            sources: [...seen.values()].map(({ source, excerpt }) => ({
              sourceFingerprint: source.sourceFingerprint, title: source.title, excerpt, publishedAt: source.publishedAt,
              ...(source.listedOn ? { listedOn: source.listedOn } : {}), from: sourceLabel(source.sourceRef, source.url),
            })),
          }, abort.signal);
          completedBatches += 1;
          for (const candidate of submission.candidates) {
            const judged = seen.get(candidate.sourceFingerprint);
            if (!judged || !ownDirections.has(candidate.directionId) || !judged.excerpt.includes(candidate.evidenceQuote)) {
              rejected += 1;
              continue;
            }
            if (candidate.relevance < MIN_RELEVANCE) continue;
            // 一条来源只归一个方向：重复提交时留相关度更高的那次
            const previous = accepted.get(candidate.sourceFingerprint);
            if (!previous || previous.candidate.relevance < candidate.relevance) accepted.set(candidate.sourceFingerprint, { candidate, source: judged.source });
          }
        } catch (cause) {
          if (abort.signal.aborted) unassessed += batch.length;
          else warnings.push(`研判失败：${message(cause)}`);
        }
      }
      if (rejected > 0) console.info(`personal radar ${personId}: ${rejected} 条候选没有通过引文或归属复核`);
      if (unassessed > 0) warnings.push(`有 ${unassessed} 条没来得及研判（${limitText}）`);
      if (completedBatches === 0) return { status: "failed", createdSignals: 0 };

      // 按相关度、再按发布时间取今天剩下的名额写入；同一人同一网址只一行
      const ranked = [...accepted.values()].sort((left, right) =>
        right.candidate.relevance - left.candidate.relevance || newestFirst(left.source, right.source));
      const kept = ranked.slice(0, remaining);
      if (ranked.length > kept.length) warnings.push(`今天的 ${DAILY_CAP} 条名额已满，另有 ${ranked.length - kept.length} 条没有保存`);
      const directionText = new Map(directions.map((direction) => [direction.id, direction.text]));
      let createdSignals = 0;
      for (const { candidate, source } of kept) {
        try {
          const inserted = await q(
            `INSERT INTO person_radar_signals
               (id, person_id, source_type, source_fingerprint, source_title, source_url, published_at, listed_on, excerpt, source_ref,
                direction_id, direction_text, summary, reason, evidence_quote, relevance, collected_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8::date, $9, $10::jsonb, $11, $12, $13, $14, $15, $16, $17)
             ON CONFLICT (person_id, source_fingerprint) DO NOTHING`,
            [
              randomUUID(), personId, source.sourceType, source.sourceFingerprint, source.title.slice(0, 500), source.url, source.publishedAt,
              source.listedOn ?? null, source.excerpt.slice(0, 10_000), JSON.stringify(source.sourceRef), candidate.directionId, directionText.get(candidate.directionId),
              candidate.summary, candidate.reason, candidate.evidenceQuote, candidate.relevance, now(),
            ],
          );
          createdSignals += inserted.rowCount ?? 0;
        } catch (cause) {
          warnings.push(`保存失败：${message(cause)}`);
        }
      }
      return { status: "completed", createdSignals };
    } finally {
      clearTimeout(timer);
    }
  }

  /** 一个人的一次扫描：认领不到就跳过；任何失败只写他自己的 last_run。 */
  async function scanOne({ personId, trigger, queuedAt }: Entry): Promise<void> {
    const startedAt = now();
    const run = { trigger, queuedAt, startedAt: startedAt.toISOString() };
    // 认领（多进程安全）：定时扫描还要求今天没扫过，保证一天只扫一次
    const claim = await q(
      `UPDATE person_radar
          SET last_run = $2::jsonb, last_scan_day = ($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date
        WHERE person_id = $1 AND enabled AND COALESCE(last_run->>'status', '') <> 'running'
          AND ($4::text = 'manual' OR last_scan_day IS NULL OR last_scan_day < ($3::timestamptz AT TIME ZONE 'Asia/Shanghai')::date)
        RETURNING directions, sources`,
      [personId, JSON.stringify({ ...run, status: "running", createdSignals: 0, warnings: [] }), startedAt, trigger],
    );
    if (claim.rowCount !== 1) {
      // 排队后雷达被关掉：取消这次扫描，不让它一直停在「排队中」
      await q(
        `UPDATE person_radar
            SET last_run = last_run || jsonb_build_object('status', 'failed', 'completedAt', $2::text,
                  'warnings', COALESCE(last_run->'warnings', '[]'::jsonb) || to_jsonb($3::text))
          WHERE person_id = $1 AND NOT enabled AND last_run->>'status' = 'queued'`,
        [personId, now().toISOString(), "雷达已关闭，这次扫描取消了"],
      );
      return;
    }
    const warnings: string[] = [];
    let outcome: Outcome;
    try {
      outcome = await scan(personId, claim.rows[0] as { directions: unknown; sources: unknown }, startedAt, warnings);
    } catch (cause) {
      warnings.push(message(cause));
      outcome = { status: "failed", createdSignals: 0 };
    }
    const finished: TPersonalRadarRun = {
      ...run, ...outcome, completedAt: now().toISOString(), warnings: warnings.slice(0, 50).map((warning) => warning.slice(0, 500)),
    };
    await q("UPDATE person_radar SET last_run = $2::jsonb WHERE person_id = $1", [personId, JSON.stringify(finished)]);
  }

  async function drain(): Promise<void> {
    try {
      while (pending.length > 0) {
        const entry = pending.shift()!;
        queued.delete(entry.personId);
        try {
          await scanOne(entry);
        } catch (cause) {
          // 写不了 last_run 时只记日志：留下的 running 由下次启动补偿标为 failed
          console.warn(`personal radar scan for ${entry.personId} threw: ${message(cause)}`);
        }
      }
    } finally {
      draining = null;
    }
  }

  function enqueue(personId: string, trigger: PersonalRadarTrigger): void {
    if (queued.has(personId)) return;
    queued.add(personId);
    pending.push({ personId, trigger, queuedAt: now().toISOString() });
    draining ??= drain();
  }

  return {
    providerStatus: { webSearch: web.configured },
    enqueue,
    async runScheduled() {
      const due = await q(
        `SELECT person_id FROM person_radar
          WHERE enabled AND (last_scan_day IS NULL OR last_scan_day < ($1::timestamptz AT TIME ZONE 'Asia/Shanghai')::date)
          ORDER BY person_id`,
        [now()],
      );
      // 只扫还在 seed 里的成员；CEO 的雷达是公司雷达
      const members = new Set(companyMemory.searchPeople(undefined).filter((person) => roleOf(person) === "member").map((person) => person.personId));
      for (const { person_id } of due.rows as { person_id: string }[]) if (members.has(person_id)) enqueue(person_id, "scheduled");
    },
    async recoverStaleRuns() {
      await q(
        `UPDATE person_radar
            SET last_run = last_run || jsonb_build_object('status', 'failed', 'completedAt', $1::text,
                  'warnings', COALESCE(last_run->'warnings', '[]'::jsonb) || to_jsonb($2::text))
          WHERE last_run->>'status' IN ('queued', 'running')`,
        [now().toISOString(), "扫描被进程重启中断"],
      );
      await q(
        `UPDATE agent_runs SET status = 'failed', error = '进程重启中断，未产生候选', completed_at = now()
          WHERE kind = 'personal-radar-assess' AND status = 'running'`,
      );
    },
    async idle() {
      while (draining) await draining;
    },
  };
}
