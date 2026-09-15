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

export type FingerprintedRadarSource = TRadarSourceItem & { sourceFingerprint: string };

export type RadarWebAdapter = {
  configured: boolean;
  search(input: { query: string; domains?: string[] }, signal: AbortSignal): Promise<TRadarSourceItem[]>;
};

export type RadarWechatAdapter = {
  configured: boolean;
  fetchLatest(input: { accountId: string; accountName: string }, signal: AbortSignal): Promise<TRadarSourceItem[]>;
};

export type RadarAssessor = {
  assess(input: { anchors: TRadarAnchor[]; sources: FingerprintedRadarSource[] }, signal: AbortSignal): Promise<TRadarCandidateSubmission>;
};

export type RadarService = {
  runManual(): Promise<TRadarScanResponse>;
  runScheduled(): Promise<TRadarScanResponse>;
  /** 启动补偿：进程崩溃时留下的 running 扫描必须可见地标为 failed（doc 03 §16），不自动重跑。 */
  recoverStaleRuns(): Promise<void>;
  providerStatus: { web: boolean; wechat: boolean };
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
const MAX_ANCHORS = 20;

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

function sourceFingerprint(canonicalUrl: string): string {
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
  assessor,
  now = () => new Date(),
  scanTimeoutMs = 180_000,
}: {
  pool: Pool;
  web: RadarWebAdapter;
  wechat?: RadarWechatAdapter;
  assessor: RadarAssessor;
  now?: () => Date;
  scanTimeoutMs?: number;
}): RadarService {
  async function run(trigger: "manual" | "scheduled"): Promise<TRadarScanResponse> {
    const startedAt = now();
    let day = companyDay(startedAt, "Asia/Shanghai");
    let locked = false;
    let client: PoolClient | undefined;
    let scanTimer: NodeJS.Timeout | undefined;
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
      // 固定上限：监测方向与单批 assess 都有上限，避免无界 prompt
      const monitoredAnchors = anchors.slice(0, MAX_ANCHORS);
      if (anchors.length > monitoredAnchors.length) {
        warnings.push(`Radar 监测方向超过上限 ${MAX_ANCHORS}，本次只处理前 ${monitoredAnchors.length} 个`);
      }
      const collected: TRadarSourceItem[] = [];
      let attempted = 0;
      let succeeded = 0;
      const abort = new AbortController();
      // 单次扫描有时限：Provider 悬挂时释放锁并把失败写入 last_run，不无限占用后续扫描
      scanTimer = setTimeout(() => abort.abort(new Error(`Radar scan exceeded ${scanTimeoutMs}ms`)), scanTimeoutMs);
      scanTimer.unref();
      for (const site of sources.sites.filter((source) => source.enabled)) {
        for (const anchor of monitoredAnchors) {
          attempted += 1;
          try {
            collected.push(...await web.search({ query: anchor.query, domains: site.domains }, abort.signal));
            succeeded += 1;
          } catch (cause) {
            warnings.push(`Web source ${site.name} failed: ${(cause as Error).message || String(cause)}`);
          }
        }
      }
      for (const account of sources.wechatAccounts.filter((source) => source.enabled)) {
        attempted += 1;
        if (!wechat?.configured) {
          warnings.push(`微信公众号 ${account.name} 未配置账号级 Provider`);
          continue;
        }
        try {
          collected.push(...await wechat.fetchLatest({ accountId: account.accountId, accountName: account.name }, abort.signal));
          succeeded += 1;
        } catch (cause) {
          warnings.push(`微信公众号 ${account.name} failed: ${(cause as Error).message || String(cause)}`);
        }
      }
      if (attempted === 0) warnings.push("Radar 未配置启用的来源");
      if (succeeded === 0) {
        const response: TRadarScanResponse = { trigger, status: "failed", companyDay: day, createdSignals: 0, warnings };
        await client.query("UPDATE radar_config SET last_run = $1::jsonb, updated_at = now() WHERE id = 'default'", [
          JSON.stringify({ ...response, startedAt: startedAt.toISOString(), completedAt: now().toISOString() }),
        ]);
        return response;
      }

      const earliest = startedAt.getTime() - config.lookback_hours * 60 * 60 * 1000;
      const unique = new Map<string, FingerprintedRadarSource>();
      for (const source of collected) {
        const publishedAt = Date.parse(source.publishedAt);
        if (!Number.isFinite(publishedAt) || publishedAt < earliest || publishedAt > startedAt.getTime()) {
          warnings.push(`来源超出时间窗: ${source.title}`);
          continue;
        }
        try {
          const canonicalUrl = canonicalizeRadarUrl(source.url);
          const fingerprint = sourceFingerprint(canonicalUrl);
          unique.set(fingerprint, { ...source, url: canonicalUrl, sourceFingerprint: fingerprint });
        } catch {
          warnings.push(`来源 URL 无效: ${source.title}`);
        }
      }

      let createdSignals = 0;
      let assessFailed = false;
      if (unique.size > 0) {
        const anchorById = new Map(monitoredAnchors.map((anchor) => [anchor.id, anchor]));
        const batches: FingerprintedRadarSource[][] = [];
        const deduped = [...unique.values()];
        for (let index = 0; index < deduped.length; index += ASSESS_BATCH_SIZE) {
          batches.push(deduped.slice(index, index + ASSESS_BATCH_SIZE));
        }
        const candidates: TRadarCandidateSubmission["candidates"] = [];
        let failedBatches = 0;
        for (const batch of batches) {
          try {
            candidates.push(...(await assessor.assess({ anchors: monitoredAnchors, sources: batch }, abort.signal)).candidates);
          } catch (cause) {
            // 批失败：该批不保存候选，不影响其他批
            failedBatches += 1;
            warnings.push(`Radar assess 批失败: ${(cause as Error).message || String(cause)}`);
          }
        }
        assessFailed = failedBatches === batches.length;
        for (const candidate of candidates) {
          const source = unique.get(candidate.sourceFingerprint);
          const anchor = anchorById.get(candidate.anchorId);
          if (!source || !anchor || !source.excerpt.includes(candidate.evidenceQuote)) {
            warnings.push(`候选未通过来源引文或归属校验: ${candidate.sourceFingerprint}`);
            continue;
          }
          const inserted = await client.query(
            `INSERT INTO signals
               (id, version, source_type, source_fingerprint, source_title, source_url, published_at, excerpt,
                source_ref, anchor_id, location, summary, strategic_impact, evidence_quote, unknowns, score)
             VALUES ($1, 1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10::jsonb, $11, $12, $13, $14::jsonb, $15::jsonb)
             ON CONFLICT (source_fingerprint) DO NOTHING`,
            [
              randomUUID(), source.sourceType, source.sourceFingerprint, source.title, source.url, source.publishedAt,
              source.excerpt, JSON.stringify(source.sourceRef), candidate.anchorId, JSON.stringify(anchor.location),
              candidate.summary, candidate.strategicImpact, candidate.evidenceQuote, JSON.stringify(candidate.unknowns),
              JSON.stringify(candidate.score),
            ],
          );
          createdSignals += inserted.rowCount ?? 0;
        }
      }

      // 全部 assess 批失败等于“没有研判结果”：如实标为 failed，而非 completed
      const status: TRadarScanResponse["status"] = assessFailed ? "failed" : "completed";
      const response: TRadarScanResponse = { trigger, status, companyDay: day, createdSignals, warnings };
      await client.query("UPDATE radar_config SET last_run = $1::jsonb, updated_at = now() WHERE id = 'default'", [
        JSON.stringify({ ...response, startedAt: startedAt.toISOString(), completedAt: now().toISOString() }),
      ]);
      return response;
    } catch (cause) {
      const warnings = [(cause as Error).message || String(cause)];
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

  return {
    runManual: () => run("manual"),
    runScheduled: () => run("scheduled"),
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
                    COALESCE(last_run->'warnings', '[]'::jsonb) || '"扫描被进程重启中断，状态已标为 failed"'::jsonb
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
    providerStatus: { web: web.configured, wechat: wechat?.configured === true },
  };
}
