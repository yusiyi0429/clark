import type { Query } from "./meetingStore.js";
import { logEvent } from "./observability.js";
import { companyPeriod } from "./monthlyPlans.js";
import { WorldClient, WorldError, worldErrorCode, worldReadsEnabled, worldWritesEnabled, type WorldEnv, type WorldHead, type WorldInstance, type WorldInstanceName } from "./worldClient.js";

/**
 * 本体（tkos.world/0.2，world-02）只读集成（第 1 期）：
 * - 启动时用 world_list_objects / world_get_object 等只读调用验证连通，结果进健康接口（不含凭证）；
 * - 战场（责任单元）的长期目标与本期目标读自本体：单元按外部引用 tianshu / battlefield:<战场 id> 对上本地战场，
 *   有本体版本时以本体为准并标注来源「本体」，读不到时回退本地资料，界面不报错；
 * - Company / Strategy 摘要进对话上下文包（globalContext.ontology）。
 * 每次请求 8 秒超时，结果缓存 5 分钟，失败 1 分钟内不重试（沿用上一份成功结果，没有就回退本地）。
 * 请求全部串行（本体每次请求都会短暂锁 scope）；健康检查用 GET /v1/health，版本取 GET /openapi.json 的 info.version（都不带凭证）；
 * 不调用 POST /context（它每次都会落一条读取记录），需要的内容用「列对象 + 逐个 GET 对象」组装。
 * 只读：本模块不调用任何写动作。
 */

export const WORLD_READ_TIMEOUT_MS = 8_000;
export const WORLD_CACHE_TTL_MS = 5 * 60_000;
export const WORLD_ERROR_TTL_MS = 60_000;
export const WORLD_VERSION_TTL_MS = 60 * 60_000;

export type WorldTextComponent = { block: string; type: string; text: string };
export type WorldDoc = { objectId: string; ref: string; title: string; version: number; lifecycle: string | null; components: WorldTextComponent[] };
export type WorldGoal = {
  objectId: string; ref: string; title: string; version: number; lifecycle: string | null;
  period: string | null; horizon: string | null;
  outcome: string | null; successCriteria: string | null; acceptance: string | null; timeBoundary: string | null; realizationLogic: string | null;
};
export type WorldUnitGoals = {
  battlefieldId: string;
  unit: { objectId: string; ref: string; title: string; domainId: string | null };
  lto: WorldGoal | null;
  periodGoals: WorldGoal[];
};
/** Mission、Task 只取对象头（标题、ref、状态、所属单元），不逐个读正文；正文由 query_company 按问题去读。 */
export type WorldItem = { objectId: string; ref: string; type: "Mission" | "Task"; title: string; lifecycle: string | null; unit: string | null };
export type WorldSnapshot = { fetchedAt: string; company: WorldDoc | null; strategy: WorldDoc | null; units: WorldUnitGoals[]; items?: WorldItem[] };

export type WorldStatus = {
  configured: boolean;
  instance: WorldInstanceName;
  scopeId: string | null;
  reads: boolean;
  writes: boolean;
  state: "not_configured" | "checking" | "connected" | "error";
  checkedAt: string | null;
  contractVersion: string | null;
  serverVersion: string | null;
  objects: { company: number; strategy: number; units: number; longTermGoals: number; periodGoals: number } | null;
  errorCode: string | null;
  httpStatus: number | null;
};

export type WorldReader = {
  readonly enabled: boolean;
  /** 健康检查（启动时调用一次；也可手动重跑）：只读，失败不抛错。 */
  check(): Promise<WorldStatus>;
  status(): WorldStatus;
  /** 当前快照：缓存新鲜直接给；否则最多等 budgetMs，超时或失败给上一份成功结果（没有就 null，调用方回退本地）。 */
  snapshot(budgetMs?: number): Promise<WorldSnapshot | null>;
};

type ObjectView = {
  object_id?: string;
  business: {
    object_id: string; object_type: string; title: string; version: number; domain_id?: string | null;
    attributes?: Record<string, unknown>;
    blocks?: { id: string; display_name?: string; components?: { id?: string; type?: string; text?: unknown }[] }[];
  };
  records?: { lifecycle?: { status?: string; display_name?: string } | null };
  protocol?: { contract_version?: string };
};

const BATTLEFIELD_REF = /^battlefield:(.+)$/;
/** 界面与 Agent 可见文字：内部代号换成公司名（与资料包 build-pack 同一规则；TKOS、TokenOps 等产品名不动）。 */
export function worldDisplayText(text: string): string {
  return text.replace(/(?<![A-Za-z])FDD(?![A-Za-z])/g, "房懂懂").replace(/(?<![A-Za-z])TK(?![A-Za-z])/g, "词元云集")
    // 「词元云集（TK）」换完成了「词元云集（词元云集）」：去掉重复的括注。
    .replace(/(词元云集|房懂懂)（\1）/g, "$1");
}
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const str = (value: unknown): string | null => (typeof value === "string" && value.trim() ? value.trim() : null);

function components(view: ObjectView, blockId?: string): WorldTextComponent[] {
  return (view.business.blocks ?? [])
    .filter((block) => !blockId || block.id === blockId)
    .flatMap((block) => (block.components ?? []).flatMap((item) => {
      const text = str(item.text);
      return text && item.type ? [{ block: block.display_name ?? block.id, type: item.type, text: worldDisplayText(text) }] : [];
    }));
}
const joined = (items: WorldTextComponent[], type: string): string | null => {
  const texts = items.filter((item) => item.type === type).map((item) => item.text);
  return texts.length ? texts.join("\n") : null;
};
const lifecycleOf = (view: ObjectView): string | null => view.records?.lifecycle?.display_name ?? view.records?.lifecycle?.status ?? null;
const refOf = (view: ObjectView) => `${view.business.object_id}@${view.business.version}`;

export function worldGoalOf(view: ObjectView): WorldGoal {
  const target = components(view, "target");
  const attributes = view.business.attributes ?? {};
  return {
    objectId: view.business.object_id, ref: refOf(view), title: worldDisplayText(view.business.title), version: view.business.version, lifecycle: lifecycleOf(view),
    period: str(attributes.period), horizon: str(attributes.horizon) && worldDisplayText(str(attributes.horizon)!),
    outcome: joined(target, "outcome"), successCriteria: joined(target, "success_criterion"), acceptance: joined(target, "acceptance_criterion"),
    timeBoundary: joined(target, "time_boundary"), realizationLogic: joined(target, "realization_logic"),
  };
}
function worldDocOf(view: ObjectView): WorldDoc {
  return {
    objectId: view.business.object_id, ref: refOf(view), title: worldDisplayText(view.business.title), version: view.business.version, lifecycle: lifecycleOf(view),
    components: components(view).slice(0, 24).map((item) => ({ ...item, text: clip(item.text, 600) })),
  };
}
const battlefieldIdOf = (head: WorldHead): string | null => {
  for (const ref of head.external_refs ?? []) {
    const match = ref.system === "tianshu" ? BATTLEFIELD_REF.exec(ref.id) : null;
    if (match) return match[1];
  }
  return null;
};
/** 同一单元有多个时：生效的（已确认）优先，其次草稿；撤销 / 作废的不用。 */
export const usableWorldHead = (head: Pick<WorldHead, "lifecycle">) => !/withdrawn|cancel|archiv|superseded|void/i.test(String((head.lifecycle as { status?: string } | null)?.status ?? ""));

/** 本期目标：优先当前公司月，没有当前月的就用最近一个周期的全部。 */
export function choosePeriodGoals(goals: WorldGoal[], period: string): WorldGoal[] {
  const current = goals.filter((goal) => goal.period === period);
  if (current.length) return current;
  const periods = goals.map((goal) => goal.period).filter((value): value is string => Boolean(value)).sort();
  const latest = periods.at(-1);
  return latest ? goals.filter((goal) => goal.period === latest) : goals;
}

/**
 * 全程串行：本体每次请求都会短暂锁 scope，列对象、取对象一个接一个发，不用 Promise.all。
 * 同一对象在一次读取里只取一次（几个单元共用同一域时不重复请求）。
 */
export async function loadWorldSnapshot(client: WorldClient, at: Date): Promise<{ snapshot: WorldSnapshot; contractVersion: string | null; counts: NonNullable<WorldStatus["objects"]> }> {
  const companies = await client.listObjects({ type: "Company" });
  const strategies = await client.listObjects({ type: "Strategy" });
  const units = await client.listObjects({ type: "ResponsibilityUnit" });
  const ltos = await client.listObjects({ type: "LongTermGoal" });
  const pos = await client.listObjects({ type: "PeriodGoal" });
  // Mission、Task：先按当前公司月让本体筛，筛空（这个月还没建）就不按周期；只列头，不多读对象。
  const period = companyPeriod(at);
  const current = async (type: WorldItem["type"]) => {
    const inPeriod = await client.listObjects({ type, period });
    return inPeriod.length ? inPeriod : client.listObjects({ type });
  };
  const missions = await current("Mission");
  const tasks = await current("Task");
  const contractVersion = [companies, strategies, units, ltos, pos].flat().map((head) => (head as WorldHead & { contract_version?: string }).contract_version).find(Boolean) ?? null;
  const views = new Map<string, ObjectView>();
  const read = async (id: string): Promise<ObjectView> => {
    const cached = views.get(id);
    if (cached) return cached;
    const view = await client.getObject(id) as unknown as ObjectView;
    views.set(id, view);
    return view;
  };
  const readAll = async (heads: WorldHead[]): Promise<ObjectView[]> => {
    const out: ObjectView[] = [];
    for (const item of heads) out.push(await read(item.object_id));
    return out;
  };
  const battlefieldUnits = units.flatMap((head) => {
    const battlefieldId = battlefieldIdOf(head);
    return battlefieldId ? [{ head, battlefieldId }] : [];
  });
  const inDomain = (heads: WorldHead[], domainId: string | undefined) => heads.filter((head) => usableWorldHead(head) && domainId && head.domain_id === domainId);
  const company = companies[0] ? worldDocOf(await read(companies[0].object_id)) : null;
  const strategy = strategies[0] ? worldDocOf(await read(strategies[0].object_id)) : null;
  const unitGoals: WorldUnitGoals[] = [];
  for (const { head, battlefieldId } of battlefieldUnits) {
    const ltoGoals = (await readAll(inDomain(ltos, head.domain_id))).map(worldGoalOf);
    const poGoals = (await readAll(inDomain(pos, head.domain_id))).map(worldGoalOf);
    const lto = ltoGoals.find((goal) => goal.lifecycle && !/草稿|draft/i.test(goal.lifecycle)) ?? ltoGoals[0] ?? null;
    unitGoals.push({
      battlefieldId,
      unit: { objectId: head.object_id, ref: `${head.object_id}@${head.version}`, title: worldDisplayText(head.title), domainId: head.domain_id ?? null },
      lto,
      periodGoals: poGoals,
    });
  }
  const unitTitles = new Map(units.flatMap((head) => (head.domain_id ? [[head.domain_id, worldDisplayText(head.title)] as const] : [])));
  const items = [...missions, ...tasks].filter(usableWorldHead).map((head): WorldItem => ({
    objectId: head.object_id, ref: `${head.object_id}@${head.version}`, type: head.object_type as WorldItem["type"], title: worldDisplayText(head.title),
    lifecycle: (head.lifecycle as { display_name?: string; status?: string } | null)?.display_name ?? (head.lifecycle as { status?: string } | null)?.status ?? null,
    unit: (head.domain_id && unitTitles.get(head.domain_id)) || null,
  }));
  return {
    snapshot: { fetchedAt: at.toISOString(), company, strategy, units: unitGoals, items },
    contractVersion,
    counts: { company: companies.length, strategy: strategies.length, units: units.length, longTermGoals: ltos.length, periodGoals: pos.length },
  };
}

/**
 * 同一 world 实例（地址 + scope）在一个进程里共用一份缓存：演示网关同进程起多个场次 app，不各自重复读本体。
 * 测试用 clearWorldReadCache() 清空。
 */
type CacheEntry = {
  value: WorldSnapshot | null; freshUntil: number; retryAfter: number; versionAt: number;
  inFlight: Promise<WorldSnapshot | null> | null; status: WorldStatus;
};
const shared = new Map<string, CacheEntry>();
export function clearWorldReadCache(): void { shared.clear(); }

function baseStatus(env: WorldEnv, config: WorldInstance | null): WorldStatus {
  return {
    configured: false, instance: env.worldInstance ?? "mvp", scopeId: config?.scope_id ?? null,
    reads: config ? worldReadsEnabled(config) : false, writes: config ? worldWritesEnabled(config) : false,
    state: "not_configured", checkedAt: null, contractVersion: null, serverVersion: null, objects: null,
    errorCode: env.worldTokenError ?? null, httpStatus: null,
  };
}

/** 未配置（缺地址或凭证）时返回一个不发请求的 reader：status 如实报告，snapshot 恒为 null。 */
export function createWorldReader(options: {
  q: Query; env: WorldEnv; config?: WorldInstance; now?: () => Date; ttlMs?: number; errorTtlMs?: number; timeoutMs?: number; clock?: () => number;
}): WorldReader {
  const { env } = options;
  const clock = options.clock ?? Date.now;
  const now = options.now ?? (() => new Date());
  let config: WorldInstance | null = options.config ?? null;
  let client: WorldClient | null = null;
  let setupError: string | null = null;
  if (env.worldApiUrl && env.worldAgentToken) {
    try {
      client = new WorldClient(options.q, env, options.config, { timeoutMs: options.timeoutMs ?? WORLD_READ_TIMEOUT_MS });
      config = client.config;
    } catch (error) {
      setupError = error instanceof WorldError ? error.code : "WORLD_CONFIG_INVALID";
    }
  }
  if (!client) {
    const status: WorldStatus = { ...baseStatus(env, config), errorCode: setupError ?? env.worldTokenError ?? null, state: setupError ? "error" : "not_configured", configured: Boolean(setupError) };
    return { enabled: false, check: async () => status, status: () => status, snapshot: async () => null };
  }
  const worldClient = client;
  const instanceConfig = worldClient.config;
  const reads = worldReadsEnabled(instanceConfig);
  const key = worldClient.instance;
  const entry: CacheEntry = shared.get(key) ?? {
    value: null, freshUntil: 0, retryAfter: 0, versionAt: 0, inFlight: null,
    status: { ...baseStatus(env, instanceConfig), configured: true, state: "checking" },
  };
  shared.set(key, entry);
  const ttl = options.ttlMs ?? WORLD_CACHE_TTL_MS;
  const errorTtl = options.errorTtlMs ?? WORLD_ERROR_TTL_MS;

  async function refresh(): Promise<WorldSnapshot | null> {
    const started = clock();
    try {
      // 串行：先 /v1/health（不带凭证），再读对象，最后才取版本；本体每次请求都会短暂锁 scope，不并发。
      // /openapi.json 有 300KB 左右、要 2 秒上下，版本号很少变：取到后缓存 1 小时，期内不再请求（没取到就每次刷新再试）。
      await worldClient.health();
      const loaded = await loadWorldSnapshot(worldClient, now());
      let serverVersion = entry.status.serverVersion;
      if (!serverVersion || clock() - entry.versionAt >= WORLD_VERSION_TTL_MS) {
        serverVersion = await worldClient.serverVersion().catch(() => null);
        entry.versionAt = clock();
      }
      const anchor = instanceConfig.anchors?.company;
      // 范围核对：实例配置写了 Company 的 id 时，读回的 Company 必须是它；对不上说明凭证指向别的 scope，不用这份数据。
      if (anchor && loaded.snapshot.company && loaded.snapshot.company.objectId !== anchor) throw new WorldError(409, "SCOPE_MISMATCH", "读回的 Company 与实例配置不一致");
      entry.value = loaded.snapshot;
      entry.freshUntil = clock() + ttl;
      entry.retryAfter = 0;
      entry.status = { ...entry.status, state: "connected", checkedAt: new Date(clock()).toISOString(), contractVersion: loaded.contractVersion,
        serverVersion, objects: loaded.counts, errorCode: null, httpStatus: 200 };
      logEvent({ event: "world.read", status: "ok", durationMs: clock() - started });
      return entry.value;
    } catch (error) {
      const code = worldErrorCode(error);
      entry.retryAfter = clock() + errorTtl;
      if (code === "SCOPE_MISMATCH") { entry.value = null; entry.freshUntil = 0; }
      entry.status = { ...entry.status, state: "error", checkedAt: new Date(clock()).toISOString(), errorCode: code,
        httpStatus: error instanceof WorldError ? error.status || null : null };
      logEvent({ event: "world.read", status: "failed", errorCode: code, durationMs: clock() - started });
      return entry.value;
    }
  }
  function load(): Promise<WorldSnapshot | null> {
    if (!entry.inFlight) entry.inFlight = refresh().finally(() => { entry.inFlight = null; });
    return entry.inFlight;
  }
  return {
    enabled: reads,
    async check() { await load(); return entry.status; },
    status: () => entry.status,
    async snapshot(budgetMs = WORLD_READ_TIMEOUT_MS) {
      if (!reads) return null;
      const t = clock();
      if (entry.value && entry.freshUntil > t) return entry.value;
      if (entry.retryAfter > t && !entry.inFlight) return entry.value;
      const pending = load();
      let timer: NodeJS.Timeout | undefined;
      const fallback = new Promise<WorldSnapshot | null>((resolve) => { timer = setTimeout(() => resolve(entry.value), budgetMs); });
      try { return await Promise.race([pending, fallback]); } finally { clearTimeout(timer); }
    },
  };
}

// ---------------------------------------------------------------- 对话：按需工具 read_ontology（不进每轮上下文包）

export const WORLD_CONTEXT_NOTE = "这是本体（tkos.world 业务世界）里登记的记录，引用时可说「本体里登记的」。"
  + "长期目标、本月目标与本地资料不一致时以本体为准，一号位在这里明确改过的以改过的为准。"
  + "lifecycle 为草稿的是尚未确认的草稿，不能说成已批准的承诺；本体里没有的内容不要据此推断。";
/** 工具结果的上限（字符）：超过时逐条截短组件正文。 */
export const WORLD_TOOL_MAX_CHARS = 12_000;

export type OntologyQuery = { part?: "company" | "strategy" | "battlefields" | "missions"; battlefieldId?: string };
/** read_ontology 里 Mission、Task 各最多列几个。 */
export const WORLD_ITEMS_MAX = 40;

/**
 * read_ontology 的结果：Company / Strategy 的组件（每条最多 400 字，各最多 24 条）与各战场的长期目标、本期目标。
 * 对话质量诊断（.superpowers/sdd/chat-quality-diagnosis.md §4-G）：上下文包每轮整包进历史，本体内容只经这个按需工具给，不放进 globalContext。
 */
export function worldContextSection(snapshot: WorldSnapshot, period: string, query: OntologyQuery = {}, componentMax = 400): Record<string, unknown> {
  const doc = (value: WorldDoc | null) => value && {
    title: value.title, ref: value.ref, lifecycle: value.lifecycle,
    content: value.components.map((item) => `${item.block} · ${item.type}：${clip(item.text, componentMax)}`),
  };
  const optional = (name: string, value: string | null) => (value ? { [name]: clip(value, componentMax) } : {});
  const goal = (value: WorldGoal) => ({
    title: value.title, ref: value.ref, lifecycle: value.lifecycle,
    ...optional("period", value.timeBoundary ?? value.period), ...optional("horizon", value.horizon),
    ...optional("outcome", value.outcome), ...optional("successCriteria", value.successCriteria),
    ...optional("acceptance", value.acceptance), ...optional("realizationLogic", value.realizationLogic),
  });
  const want = (part: NonNullable<OntologyQuery["part"]>) => !query.part || query.part === part;
  return {
    source: "本体",
    note: WORLD_CONTEXT_NOTE,
    asOf: snapshot.fetchedAt,
    ...(want("company") ? { company: doc(snapshot.company) } : {}),
    ...(want("strategy") ? { strategy: doc(snapshot.strategy) } : {}),
    ...(want("battlefields") ? {
      battlefields: snapshot.units.filter((unit) => !query.battlefieldId || unit.battlefieldId === query.battlefieldId).map((unit) => ({
        battlefieldId: unit.battlefieldId, unit: unit.unit.title, unitRef: unit.unit.ref,
        longTermGoal: unit.lto ? goal(unit.lto) : null,
        periodGoals: choosePeriodGoals(unit.periodGoals, period).map(goal),
      })),
    } : {}),
    ...(want("missions") && snapshot.items ? {
      missions: (["Mission", "Task"] as const).flatMap((type) => snapshot.items!.filter((item) => item.type === type).slice(0, WORLD_ITEMS_MAX))
        .map(({ type, title, ref, lifecycle, unit }) => ({ type, title, ref, lifecycle, unit })),
    } : {}),
  };
}

/** 工具结果：按 query 取，超过上限时把组件正文逐级截短（400 → 200 → 100 字）。 */
export function ontologyToolResult(snapshot: WorldSnapshot, period: string, query: OntologyQuery = {}): Record<string, unknown> {
  for (const max of [400, 200, 100]) {
    const result = worldContextSection(snapshot, period, query, max);
    if (JSON.stringify(result).length <= WORLD_TOOL_MAX_CHARS || max === 100) return { ...result, ...(max < 400 ? { truncated: true } : {}) };
  }
  return worldContextSection(snapshot, period, query, 100);
}

/** globalContext 不加本体一节；只把 battlefields[].sixMonthOutcome 换成本体的长期目标（字数不增加），标 goalSource。 */
export function mergeWorldGoalsIntoContext(context: Record<string, unknown>, snapshot: WorldSnapshot): Record<string, unknown> {
  if (!Array.isArray(context.battlefields)) return context;
  return {
    ...context,
    battlefields: (context.battlefields as Record<string, unknown>[]).map((item) => {
      const id = String(item.id ?? "");
      const lto = snapshot.units.find((unit) => unit.battlefieldId === id)?.lto;
      return lto?.outcome ? { ...item, sixMonthOutcome: lto.outcome, goalSource: "本体" } : item;
    }),
  };
}
