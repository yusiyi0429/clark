import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { Value } from "@sinclair/typebox/value";
import {
  RADAR_DIRECTION_MAX_CHARS,
  RADAR_OUTLETS,
  RadarAnchor,
  RadarSources,
  type TCompanyRadarSettings,
  type TMyRadar,
  type TOnboardingResponse,
  type TPersonalRadarRun,
  type TPutCompanyRadarRequest,
  type TPutMyRadarRequest,
  type TRadarAnchor,
  type TRadarDirection,
  type TRadarSourceSetting,
  type TRadarSources,
  type TSessionRole,
} from "@warmap/contracts";
import type { MemoryPerson } from "./companyMemory.js";
import type { TrendingSince } from "./githubTrending.js";
import type { Query } from "./meetingStore.js";
import { readMemberWork } from "./memberWork.js";
import { companyPeriod } from "./monthlyPlans.js";
import { countUnreadPersonalSignals } from "./personalSignals.js";

/**
 * 雷达设置（ADR-0021）：成员的个人雷达与 CEO 的公司雷达共用同一套方向与来源规则（设计 §3.4）。
 * 库里只存规范化后的值；每个来源怎么读，按当前目录现算（§3.3），名单和说明只放在这里，不进公共契约。
 */
export type RadarSettingsMode = "person" | "company";

/** 一个来源现算出的读法；订阅源带目录里的发布方 id，榜单带要读的那一版，扫描据此调用对应的读取器。 */
export type ReadableSource = { setting: TRadarSourceSetting; outletId?: string; list?: { language: string | null; since: TrendingSince } };

const FEED_NOTE = "订阅源";
const SITE_NOTE = "全网检索后按域名筛，结果可能很少";
const SITE_OFFLINE_NOTE = "全网检索未开通，暂时读不到";
const COMPANY_SITE_ERROR = "公司雷达已经在全网按方向检索；单独的网站只有在有订阅源时才能加入";
const MAX_SOURCE_CHARS = 300;

/** 暂不支持：保存时接受并写明原因，扫描时跳过。 */
const UNSUPPORTED_SOURCES = [
  { value: "github.com/trending/developers", name: "GitHub Trending 开发者榜", note: "只读仓库榜，开发者榜暂不支持" },
  { value: "news.ycombinator.com", name: "Hacker News", note: "订阅源只有评论链接，暂不支持" },
  { value: "wsj.com", name: "华尔街日报", note: "订阅源已停更，暂不支持" },
];

/** 没有可用订阅源、只能全网检索后按域名筛的常用网站（2026-09-27 实测）。 */
const NAMED_SITES = [
  { value: "36kr.com", name: "36氪" },
  { value: "jiqizhixin.com", name: "机器之心" },
];

/** 建议行只放能如实读的来源（设计 §3.2）；华尔街日报、Hacker News、GitHub Trending 不放。 */
const SUGGESTED_SOURCES = [
  "ft.com", "qbitai.com", "theinformation.com", "bbc.com", "bloomberg.com", "reuters.com", "cnbc.com", "economist.com",
  "github.com/trending",
  "36kr.com", "jiqizhixin.com",
];

/** GitHub Trending（02b）：直接读仓库榜单；语言路径与 since 决定读哪一版，规范值里保留它们。 */
const TRENDING_NOTE = "读取榜单（每天一次）";
const TRENDING_VERSION = { daily: "", weekly: " · 周榜", monthly: " · 月榜" } as const;

function trendingSource(target: Target, sinceParam: string | null): { source: ReadableSource } | { error: string } | null {
  if (target.host !== "github.com" || !covers(target, { host: "github.com", path: "/trending" })) return null;
  const segments = target.path.split("/").filter(Boolean).slice(1);
  if (segments.length > 1) {
    const value = `github.com${target.path}`;
    return value.length > MAX_SOURCE_CHARS ? { error: "网址太长了" } : { source: { setting: { value, name: "GitHub Trending", kind: "unsupported", note: "只能读仓库榜，可以带一个语言" } } };
  }
  const language = segments[0]?.toLowerCase() ?? null;
  let decoded: string | null;
  try {
    decoded = language ? decodeURIComponent(language) : null;
  } catch {
    return { error: "不是有效的网址" };
  }
  const since: TrendingSince = sinceParam === "weekly" || sinceParam === "monthly" ? sinceParam : "daily";
  return { source: {
    setting: {
      value: `github.com/trending${language ? `/${language}` : ""}${since === "daily" ? "" : `?since=${since}`}`,
      name: `GitHub Trending${decoded ? ` · ${decoded}` : ""}${TRENDING_VERSION[since]}`,
      kind: "list",
      note: TRENDING_NOTE,
    },
    list: { language: decoded, since },
  } };
}

const RESERVED_SUFFIXES = new Set(["localhost", "local", "internal", "lan", "home", "test", "invalid", "example", "arpa"]);

type Target = { host: string; path: string };

/** 规范值是「域名 + 路径」：拆回主机与路径前缀。 */
function splitValue(value: string): Target {
  const slash = value.indexOf("/");
  return slash < 0 ? { host: value, path: "" } : { host: value.slice(0, slash), path: value.slice(slash) };
}

/** host === d 或是它的子域；目录项带路径时，路径还要落在这个前缀下（按段匹配）。 */
function covers(target: Target, entry: Target): boolean {
  return (target.host === entry.host || target.host.endsWith(`.${entry.host}`))
    && (!entry.path || target.path === entry.path || target.path.startsWith(`${entry.path}/`));
}

function publicHost(host: string): boolean {
  if (host.length > 253 || host.startsWith("[") || /^\d+(\.\d+){3}$/.test(host)) return false;
  const labels = host.split(".");
  if (labels.length < 2 || RESERVED_SUFFIXES.has(labels[labels.length - 1])) return false;
  return labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

const siteNote = (webSearch: boolean) => (webSearch ? SITE_NOTE : SITE_OFFLINE_NOTE);

/** 单个来源：规范化（§3.4 规则 1–10）并现算读法；不接受时返回给人看的原因。 */
export function readSource(input: string, webSearch: boolean): { source: ReadableSource } | { error: string } {
  const raw = input.trim();
  if (!raw) return { error: "来源不能为空" };
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw)?.[1];
  // 「ft.com:8080」这类是主机加端口，不是 scheme
  const hasScheme = scheme !== undefined && !/^[^:/]+:\d/.test(raw);
  if (hasScheme && !/^https?$/i.test(scheme!)) return { error: "只支持 http 或 https 网址" };
  let url: URL;
  try {
    url = new URL(hasScheme ? raw : `https://${raw}`);
  } catch {
    return { error: "不是有效的网址" };
  }
  if (url.username || url.password) return { error: "网址里不能带账号或口令" };
  if (url.port) return { error: "网址里不能带端口" };
  // URL 已把主机转成小写，IDN 转成 punycode
  const host = url.hostname.replace(/\.$/, "").replace(/^www\./, "");
  if (!publicHost(host)) return { error: "请填公开网站的域名" };
  if (host === "weixin.qq.com" || host.endsWith(".weixin.qq.com")) return { error: "公众号要按账号订阅，贴文章链接读不到" };
  const target = { host, path: url.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "") };

  const unsupported = UNSUPPORTED_SOURCES.find((entry) => covers(target, splitValue(entry.value)));
  if (unsupported) return { source: { setting: { value: unsupported.value, name: unsupported.name, kind: "unsupported", note: unsupported.note } } };
  const trending = trendingSource(target, url.searchParams.get("since"));
  if (trending) return trending;
  const outlet = RADAR_OUTLETS.find((entry) => entry.articleDomains.some((domain) => covers(target, { host: domain, path: "" })));
  if (outlet) return { source: { setting: { value: outlet.articleDomains[0], name: outlet.name, kind: "feed", note: FEED_NOTE }, outletId: outlet.outletId } };
  const named = NAMED_SITES.find((entry) => covers(target, splitValue(entry.value)));
  const value = named?.value ?? `${target.host}${target.path}`;
  // 百分号编码的中文路径会变长：规范值也不能超过契约上限
  if (value.length > MAX_SOURCE_CHARS) return { error: "网址太长了" };
  return { source: { setting: { value, ...(named ? { name: named.name } : {}), kind: "site", note: siteNote(webSearch) } } };
}

/** 库里的规范值现算读法；万一目录改了读不出来，如实标成暂不支持，不让整页失败。 */
export function readStoredSource(value: string, webSearch: boolean): ReadableSource {
  const result = readSource(value, webSearch);
  return "source" in result ? result.source : { setting: { value, kind: "unsupported", note: result.error } };
}

/** 网页结果是否落在某个 site 来源（域名、子域与路径前缀）里；全网检索后按它筛，不回落全网。 */
export function urlWithinSite(url: string, site: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "").replace(/^www\./, "");
  return covers({ host, path: parsed.pathname.replace(/\/{2,}/g, "/").replace(/\/+$/, "") }, splitValue(site));
}

/** 方向 id 由原文派生：个人方向 `d_<12>`，公司手工方向 `manual:<12>`。 */
export function directionId(text: string, mode: RadarSettingsMode): string {
  return `${mode === "person" ? "d_" : "manual:"}${createHash("sha256").update(`v1\n${text}`).digest("hex").slice(0, 12)}`;
}

function normalizeDirection(input: string): { text: string } | { error: string } {
  const text = input.normalize("NFKC").replace(/\s+/g, " ").trim();
  if (!/[\p{L}\p{N}]/u.test(text)) return { error: "方向要写成一句话" };
  if (Array.from(text).length > RADAR_DIRECTION_MAX_CHARS) return { error: `方向最多 ${RADAR_DIRECTION_MAX_CHARS} 个字` };
  return { text };
}

export type NormalizedRadarSettings =
  | { ok: true; directions: TRadarDirection[]; sources: ReadableSource[] }
  | { ok: false; code: "RADAR_DIRECTION_INVALID" | "RADAR_SOURCE_INVALID"; message: string; fieldErrors: Record<string, string> };

/** 方向与来源一起规范化；所有问题一次返回，键为 directions/<i>、sources/<i>（输入下标）。 */
export function normalizeRadarSettings(
  input: { directions: string[]; sources: string[] },
  mode: RadarSettingsMode,
  webSearch: boolean,
): NormalizedRadarSettings {
  const fieldErrors: Record<string, string> = {};
  const directions: TRadarDirection[] = [];
  const seen = new Set<string>();
  input.directions.forEach((raw, index) => {
    const result = normalizeDirection(raw);
    if ("error" in result) {
      fieldErrors[`directions/${index}`] = result.error;
      return;
    }
    const key = result.text.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    directions.push({ id: directionId(result.text, mode), text: result.text });
  });
  const directionProblems = Object.keys(fieldErrors).length > 0;
  const sources: ReadableSource[] = [];
  input.sources.forEach((raw, index) => {
    const result = readSource(raw, webSearch);
    if ("error" in result) {
      fieldErrors[`sources/${index}`] = result.error;
      return;
    }
    const { setting } = result.source;
    // 公司雷达只收订阅源：网站已由公司的全网检索覆盖，暂不支持的写明原因
    if (mode === "company" && setting.kind !== "feed") {
      fieldErrors[`sources/${index}`] = setting.kind === "site" ? COMPANY_SITE_ERROR : setting.kind === "list" ? "榜单只能加进个人雷达" : setting.note;
      return;
    }
    if (!sources.some((source) => source.setting.value === setting.value)) sources.push(result.source);
  });
  if (Object.keys(fieldErrors).length === 0) return { ok: true, directions, sources };
  return directionProblems
    ? { ok: false, code: "RADAR_DIRECTION_INVALID", message: "有方向需要改一下", fieldErrors }
    : { ok: false, code: "RADAR_SOURCE_INVALID", message: "有来源读不了或不被允许", fieldErrors };
}

/** 常用来源建议：成员在全网检索开通时才建议网站；公司只建议订阅源。 */
export function sourceSuggestions(mode: RadarSettingsMode, webSearch: boolean): TRadarSourceSetting[] {
  return SUGGESTED_SOURCES.flatMap((value) => {
    const { setting } = readStoredSource(value, webSearch);
    // 榜单直接读页面，不依赖全网检索；网站要靠全网检索后按域名筛
    return setting.kind === "feed" || (mode === "person" && (setting.kind === "list" || (webSearch && setting.kind === "site"))) ? [setting] : [];
  });
}

/** 改写成可检索的短主题：取第一个分句，按字符截到方向上限。 */
function shortTopic(text: string): string | null {
  const clause = text.normalize("NFKC").replace(/\s+/g, " ").split(/[,;!?。]/)[0].trim();
  const topic = Array.from(clause).slice(0, RADAR_DIRECTION_MAX_CHARS).join("").trim();
  return /[\p{L}\p{N}]/u.test(topic) ? topic : null;
}

/**
 * 方向建议（≤3，不自动选中）：本人本月的 Mission／任务卡里的个人任务标题、参与的战场名、这些 Mission 的能力域，
 * 三类轮流取一条；来自讨论候选（占位卡）的写明「{M} 月讨论候选」；已在本人方向里的不再建议。
 */
async function directionSuggestions(
  q: Query, people: MemoryPerson[], secret: string, person: { personId: string; role: TSessionRole }, now: Date, existing: string[],
): Promise<TMyRadar["suggestions"]["directions"]> {
  const period = companyPeriod(now);
  const month = Number(period.slice(5));
  const [{ work }, missions] = await Promise.all([
    readMemberWork(q, people, secret, person, now),
    q(
      `SELECT m.title, m.placeholder, c.name AS capability
         FROM missions m LEFT JOIN capability_config c ON c.id = m.capability_id
        WHERE m.period = $1 AND m.owner_id = $2 ORDER BY m.code, m.id`,
      [period, person.personId],
    ),
  ]);
  const rows = missions.rows as { title: string; placeholder: boolean; capability: string | null }[];
  const groups = [
    rows.map((row) => ({ text: row.title, from: row.placeholder ? `${month} 月讨论候选` : `${month} 月 Mission` })),
    work.battlefields.map((field) => ({ text: field.name, from: "参与的战场" })),
    rows.flatMap((row) => (row.capability ? [{ text: row.capability, from: "能力域" }] : [])),
  ];
  const seen = new Set(existing.map((text) => text.toLowerCase()));
  const cursors = groups.map(() => 0);
  const picked: TMyRadar["suggestions"]["directions"] = [];
  let progressed = true;
  while (progressed && picked.length < 3) {
    progressed = false;
    for (const [index, group] of groups.entries()) {
      while (picked.length < 3 && cursors[index] < group.length) {
        const candidate = group[cursors[index]++];
        const topic = shortTopic(candidate.text);
        if (!topic || seen.has(topic.toLowerCase())) continue;
        seen.add(topic.toLowerCase());
        picked.push({ text: topic, from: candidate.from });
        progressed = true;
        break;
      }
    }
  }
  return picked;
}

type PersonRadarRow = { enabled: boolean; directions: string[]; sources: string[]; updated_at: Date | null; last_run: TPersonalRadarRun | null };

/** 本人雷达：从没保存过时返回默认值（关着、updatedAt 为 null）。 */
export async function readMyRadar({ q, people, secret, person, now, webSearch }: {
  q: Query; people: MemoryPerson[]; secret: string; person: { personId: string; role: TSessionRole }; now: Date; webSearch: boolean;
}): Promise<TMyRadar> {
  const [row, unreadCount] = await Promise.all([
    q("SELECT enabled, directions, sources, updated_at, last_run FROM person_radar WHERE person_id = $1", [person.personId])
      .then((result) => result.rows[0] as PersonRadarRow | undefined),
    countUnreadPersonalSignals(q, person.personId),
  ]);
  const texts = row?.directions ?? [];
  return {
    enabled: row?.enabled ?? false,
    directions: texts.map((text) => ({ id: directionId(text, "person"), text })),
    sources: (row?.sources ?? []).map((value) => readStoredSource(value, webSearch).setting),
    updatedAt: row?.updated_at?.toISOString() ?? null,
    lastRun: row?.last_run ?? null,
    unreadCount,
    webSearch,
    suggestions: {
      directions: await directionSuggestions(q, people, secret, person, now, texts),
      sources: sourceSuggestions("person", webSearch),
    },
  };
}

type SettingsFailure = { ok: false; code: string; message: string; fieldErrors?: Record<string, string> };

/** 只写设置，不触发扫描；updated_at 记本人这次保存（引导据此判断做过这一步）。 */
export async function saveMyRadar(q: Query, personId: string, input: TPutMyRadarRequest, webSearch: boolean, now: Date): Promise<{ ok: true } | SettingsFailure> {
  const normalized = normalizeRadarSettings(input, "person", webSearch);
  if (!normalized.ok) return normalized;
  if (input.enabled && normalized.directions.length === 0) return { ok: false, code: "RADAR_DIRECTION_REQUIRED", message: "开启雷达至少要写一条方向" };
  await q(
    `INSERT INTO person_radar (person_id, enabled, directions, sources, updated_at) VALUES ($1, $2, $3::jsonb, $4::jsonb, $5)
     ON CONFLICT (person_id) DO UPDATE SET enabled = EXCLUDED.enabled, directions = EXCLUDED.directions,
       sources = EXCLUDED.sources, updated_at = EXCLUDED.updated_at`,
    [personId, input.enabled, JSON.stringify(normalized.directions.map((direction) => direction.text)),
      JSON.stringify(normalized.sources.map((source) => source.setting.value)), now],
  );
  return { ok: true };
}

type RadarConfigRow = { anchors: TRadarAnchor[]; sources: TRadarSources };

const enabledOutletIds = (sources: TRadarSources) =>
  [...new Set((sources.outlets ?? []).filter((entry) => entry.enabled).flatMap((entry) => entry.outlets))];

/** 公司雷达：manual anchor 是可改的方向，已启用发布方的并集是来源，其余 anchor 只读。 */
export async function readCompanyRadarSettings(q: Query, webProvider: boolean): Promise<TCompanyRadarSettings> {
  const row = (await q("SELECT anchors, sources FROM radar_config WHERE id = 'default'")).rows[0] as RadarConfigRow;
  return {
    directions: row.anchors.filter((anchor) => anchor.source === "manual").map((anchor) => ({ id: anchor.id, text: anchor.title })),
    sources: enabledOutletIds(row.sources).flatMap((outletId) => {
      const outlet = RADAR_OUTLETS.find((entry) => entry.outletId === outletId);
      return outlet ? [readStoredSource(outlet.articleDomains[0], webProvider).setting] : [];
    }),
    automatic: row.anchors.filter((anchor) => anchor.source !== "manual").map((anchor) => anchor.title).slice(0, 50),
    webSearch: webProvider && row.sources.sites.some((site) => site.enabled),
    suggestions: { sources: sourceSuggestions("company", webProvider) },
  };
}

/**
 * 替换公司雷达的手工方向与发布方（一个事务，与月度签发、会议复议同一把行锁）。
 * manual 放最前（扫描只取前 20 个），其余 anchor 原样保留；网站与公众号不动；一个发布方都没选时写 `outlets: []`，
 * 写一个空条目会让公司雷达整体停摆。写前 Value.Check，不过就回滚。不触发公司扫描。
 */
export async function saveCompanyRadarSettings(pool: Pool, input: TPutCompanyRadarRequest): Promise<{ ok: true } | (SettingsFailure & { status: number })> {
  const normalized = normalizeRadarSettings(input, "company", false);
  if (!normalized.ok) return { ...normalized, status: 400 };
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const current = (await client.query("SELECT anchors, sources FROM radar_config WHERE id = 'default' FOR UPDATE")).rows[0] as RadarConfigRow;
    const anchors: TRadarAnchor[] = [
      ...normalized.directions.map((direction): TRadarAnchor => ({
        id: direction.id, title: direction.text, query: direction.text, location: { type: "company" }, source: "manual",
      })),
      ...current.anchors.filter((anchor) => anchor.source !== "manual"),
    ];
    const outletIds = normalized.sources.flatMap((source) => (source.outletId ? [source.outletId] : []));
    const sources = { ...current.sources, outlets: outletIds.length ? [{ id: "settings", name: "雷达设置", enabled: true, outlets: outletIds }] : [] };
    if (!anchors.every((anchor) => Value.Check(RadarAnchor, anchor)) || !Value.Check(RadarSources, sources)) {
      await client.query("ROLLBACK");
      return { ok: false, status: 500, code: "RADAR_CONFIG_INVALID", message: "公司雷达配置写入前校验没通过，已回滚" };
    }
    await client.query(
      "UPDATE radar_config SET anchors = $1::jsonb, sources = $2::jsonb, version = version + 1, updated_at = now() WHERE id = 'default'",
      [JSON.stringify(anchors), JSON.stringify(sources)],
    );
    await client.query("COMMIT");
    return { ok: true };
  } catch (error) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

/** 引导第 3 步与结束摘要：成员看本人雷达；CEO 看公司雷达（不能关闭）的手工方向与媒体来源。 */
export async function readRadarSummary(q: Query, person: { personId: string; role: TSessionRole }): Promise<TOnboardingResponse["radar"]> {
  if (person.role === "ceo") {
    const row = (await q("SELECT anchors, sources FROM radar_config WHERE id = 'default'")).rows[0] as RadarConfigRow;
    const manual = row.anchors.filter((anchor) => anchor.source === "manual").length;
    return { configured: manual > 0 || enabledOutletIds(row.sources).length > 0, enabled: true, directions: manual };
  }
  const row = (await q("SELECT enabled, directions, updated_at FROM person_radar WHERE person_id = $1", [person.personId])).rows[0] as
    Pick<PersonRadarRow, "enabled" | "directions" | "updated_at"> | undefined;
  return { configured: Boolean(row?.updated_at), enabled: row?.enabled ?? false, directions: row?.directions.length ?? 0 };
}
