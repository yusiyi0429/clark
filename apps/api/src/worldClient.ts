import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Query } from "./meetingStore.js";
import { logEvent } from "./observability.js";

/**
 * world 实例配置：按 TKOS_WORLD_INSTANCE 选（缺省 mvp = config/world-instance.json，原配置不变；demo / formal / tk = config/world-instance.<名>.json）。
 * formal 是集团正式 scope；tk 是词元云集（TK）scope 的天枢专用读身份，写死只读（无论配置文件怎么写，writes 一律为 false，WorldClient.write 直接拒绝）。
 * people 是 Inception 人员 id → 本体主体 id；真实人名的对应不进仓库，放在 TKOS_WORLD_INSTANCE_LOCAL_FILE 指的本地文件（.data/ 下，git 忽略），启动时合并。
 * reads：读侧集成（战场目标、Agent 上下文）是否启用；writes：写回（会议事件等）是否启用。缺省都按 MVP 原行为（不读、写）。
 */
export type WorldInstance = {
  scope_id: string;
  /** 核对用：GET /v1/identity 返回的 tenant_id 应与它一致（只用于冒烟与范围核对）。 */
  tenant_id?: string;
  domains: { company: string; eo: string } & Record<string, string>;
  people: Record<string, string>;
  label?: string;
  principals?: Record<string, string>;
  anchors?: { company?: string; strategy?: string };
  reads?: boolean;
  writes?: boolean;
};
export const WORLD_INSTANCES = ["mvp", "demo", "formal", "tk"] as const;
/** 写死只读的实例：0.2 没有技术上的只读（读身份按规则仍能记外部事件），只读由我们这一侧保证。 */
export const WORLD_READ_ONLY_INSTANCES: readonly WorldInstanceName[] = ["tk"];
export type WorldInstanceName = (typeof WORLD_INSTANCES)[number];
export function worldInstanceName(value: string | undefined, fallback: WorldInstanceName = "mvp"): WorldInstanceName {
  const name = value?.trim() || fallback;
  if (!(WORLD_INSTANCES as readonly string[]).includes(name)) throw new Error(`TKOS_WORLD_INSTANCE 只能是 ${WORLD_INSTANCES.join(" / ")}`);
  return name as WorldInstanceName;
}
export function loadWorldInstance(name: WorldInstanceName = "mvp", localFile?: string): WorldInstance {
  const file = name === "mvp" ? "../config/world-instance.json" : `../config/world-instance.${name}.json`;
  const loaded = JSON.parse(readFileSync(new URL(file, import.meta.url), "utf8")) as WorldInstance;
  const base = WORLD_READ_ONLY_INSTANCES.includes(name) ? { ...loaded, writes: false } : loaded;
  if (!localFile) return base;
  // 本地补充只合并 people（人员对应）；scope、域、读写开关一律以仓库里的实例配置为准。
  const local = JSON.parse(readFileSync(localFile, "utf8")) as { people?: Record<string, string> };
  return { ...base, people: { ...base.people, ...(local.people ?? {}) } };
}
export type WorldEnv = {
  worldApiUrl?: string;
  /** 只在内存里；由 TKOS_WORLD_AGENT_TOKEN 或 TKOS_WORLD_AGENT_TOKEN_FILE（读文件、trim）给出，不写日志、不进响应。 */
  worldAgentToken?: string;
  worldInstance?: WorldInstanceName;
  worldInstanceLocalFile?: string;
  /** 凭证文件读取失败的错误码（不含文件内容）；健康接口如实报告。 */
  worldTokenError?: string;
};
export const worldConfigured = (env: WorldEnv): boolean => Boolean(env.worldApiUrl && env.worldAgentToken);
export const worldWritesEnabled = (config: WorldInstance): boolean => config.writes !== false;
export const worldReadsEnabled = (config: WorldInstance): boolean => config.reads === true;

/**
 * 从环境变量装配 world 配置：TKOS_WORLD_API_URL；凭证优先 TKOS_WORLD_AGENT_TOKEN，否则读 TKOS_WORLD_AGENT_TOKEN_FILE。
 * 读文件失败或文件为空时不抛错（不影响启动），worldAgentToken 留空、worldTokenError 给出错误码；错误里不带文件内容。
 */
export function resolveWorldEnv(source: NodeJS.ProcessEnv = process.env, defaults: { instance?: WorldInstanceName } = {}): WorldEnv {
  const env: WorldEnv = {
    worldApiUrl: source.TKOS_WORLD_API_URL?.trim() || undefined,
    worldInstance: worldInstanceName(source.TKOS_WORLD_INSTANCE, defaults.instance ?? "mvp"),
    worldInstanceLocalFile: source.TKOS_WORLD_INSTANCE_LOCAL_FILE?.trim() || undefined,
  };
  readWorldToken(env, source.TKOS_WORLD_AGENT_TOKEN?.trim(), source.TKOS_WORLD_AGENT_TOKEN_FILE?.trim());
  return env;
}
function readWorldToken(env: WorldEnv, direct: string | undefined, file: string | undefined): void {
  if (direct) env.worldAgentToken = direct;
  else if (file) {
    try {
      const token = readFileSync(file, "utf8").trim();
      if (token) env.worldAgentToken = token;
      else env.worldTokenError = "WORLD_TOKEN_FILE_EMPTY";
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      env.worldTokenError = `WORLD_TOKEN_FILE_UNREADABLE${code ? `:${code}` : ""}`;
    }
  }
}

/**
 * 第二个只读实例（词元云集 TK scope）：TKOS_WORLD_TK_INSTANCE 不设就关闭（返回 undefined）。
 * 只接受写死只读的实例名（目前只有 tk）；地址缺省沿用 TKOS_WORLD_API_URL，可用 TKOS_WORLD_TK_API_URL 单独给；
 * 凭证只从 TKOS_WORLD_TK_TOKEN_FILE 读（不接受直给的变量，也不回退主实例的凭证）。
 */
export function resolveWorldTkEnv(source: NodeJS.ProcessEnv = process.env): WorldEnv | undefined {
  const name = source.TKOS_WORLD_TK_INSTANCE?.trim();
  if (!name) return undefined;
  const instance = worldInstanceName(name);
  if (!WORLD_READ_ONLY_INSTANCES.includes(instance)) throw new Error(`TKOS_WORLD_TK_INSTANCE 只能是 ${WORLD_READ_ONLY_INSTANCES.join(" / ")}`);
  const env: WorldEnv = { worldApiUrl: (source.TKOS_WORLD_TK_API_URL ?? source.TKOS_WORLD_API_URL)?.trim() || undefined, worldInstance: instance };
  readWorldToken(env, undefined, source.TKOS_WORLD_TK_TOKEN_FILE?.trim());
  return env;
}
/** GET /v1/identity：凭证对应的主体、所在 scope 与角色指派（只读，不落读取记录）。 */
export type WorldIdentity = {
  scope_id: string; tenant_id: string; company_id: string; principal_id: string; principal_type: "human" | "agent";
  display_name: string; auth_epoch: number; assignments: Record<string, unknown>[];
};
export type WorldExternalRef = { system: string; id: string; url?: string | null };
/** scope 原地升级会改对象绑定的契约；写入信封按被写对象当前的契约声明，不写死。 */
export type WorldContractVersion = "tkos.world/0.2" | "tkos.world/0.3";
export type WorldHead = {
  object_id: string; object_type: string; title: string; revision_id: string;
  object_version: number; version: number; domain_id?: string;
  external_refs?: WorldExternalRef[]; lifecycle: unknown; contract_version: WorldContractVersion;
};
export type WorldObject = {
  business: Omit<WorldHead, "lifecycle" | "contract_version"> & { attributes: { responsible?: string; external_refs?: WorldExternalRef[] } };
  records: { lifecycle: unknown };
  protocol: { contract_version: WorldContractVersion };
};
/** 读回的引用：对象、块或组件，ref 是写入时用的字符串形式。 */
export type WorldReadRef = { ref: string } & Record<string, unknown>;
/** 读回的组件比写入多了 ref，refs、scope 是对象形式（写回时要换回字符串）。 */
export type WorldReadComponent = { id: string; type: string; text?: string; refs?: WorldReadRef[]; scope?: WorldReadRef | null;
  artifacts?: string[]; attributes?: Record<string, unknown>; ref?: string };
/** GET /v1/world/objects/{id}/state 的 snapshot：blocks 是列表，每项 value 为块值（null 表示空块）。 */
export type WorldStateSnapshot = {
  object_id: string; as_of: string; period?: string; payload_type: { id: string } | string;
  blocks: { id: string; value: { text?: string; refs?: WorldReadRef[]; artifacts?: string[]; components?: WorldReadComponent[] } | null }[];
};
export const worldRef = (head: Pick<WorldHead, "object_id" | "version">): string => `${head.object_id}@${head.version}`;
export const worldTarget = (head: WorldHead) => ({ object_id: head.object_id, revision_id: head.revision_id, expected_version: head.object_version });
export type WorldAction = {
  action_type: string;
  contract_version: WorldContractVersion;
  target: ReturnType<typeof worldTarget> | null;
  expected_versions: unknown[];
  idempotency_key: string;
  reason: string;
  params: Record<string, unknown> & {
    on_behalf_of?: { principal_id: string; external_record_id: string; external_confirmed_at: string };
  };
};
export type WorldReceipt = { receipt_id: string; status: string; result: { event_id?: string; [key: string]: unknown } };
export class WorldError extends Error {
  constructor(public status: number, public code: string, message: string) { super(message); }
}
export const worldErrorCode = (error: unknown): string => error instanceof WorldError ? error.code : "WORLD_SYNC_FAILED";
/** 服务端在记下任何东西之前就拒的错误：版本过期，以及 scope 原地升级后旧契约的信封。同键按当前对象重建请求不会撞幂等冲突。 */
const REBUILD_CODES = new Set(["VERSION_CONFLICT", "STALE_DEPENDENCY", "PROTOCOL_WRITE_DISABLED", "PROTOCOL_BINDING_CONFLICT"]);
/** JSONB 读回会重排对象键，摘要按键排序，数组顺序保持不变。 */
export const requestDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value, (_key, entry) =>
  entry && typeof entry === "object" && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)))
    : entry,
)).digest("hex");

export class WorldClient {
  readonly instance: string;
  readonly config: WorldInstance;
  /** 写死只读（tk 实例，或配置 writes:false 且实例在只读名单里）：write 一律拒绝，不发请求。 */
  readonly readOnly: boolean;
  private readonly apiUrl: string;
  private readonly token: string;
  private readonly timeoutMs: number;
  constructor(private readonly q: Query, env: WorldEnv, config = loadWorldInstance(env.worldInstance, env.worldInstanceLocalFile), options: { timeoutMs?: number } = {}) {
    if (!worldConfigured(env)) throw new WorldError(503, "WORLD_NOT_CONFIGURED", "world 未配置");
    this.apiUrl = env.worldApiUrl!.replace(/\/+$/, "");
    const url = new URL(this.apiUrl);
    if (url.username || url.password || url.search || url.hash) throw new Error("world API URL must not contain credentials, query or fragment");
    this.token = env.worldAgentToken!;
    this.config = config;
    this.readOnly = WORLD_READ_ONLY_INSTANCES.includes(env.worldInstance ?? "mvp");
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.instance = `${this.apiUrl}#${config.scope_id}`;
  }
  private async request<T>(path: string, body?: WorldAction): Promise<T> {
    const started = Date.now();
    let status: number | undefined;
    try {
      const response = await fetch(`${this.apiUrl}${path}`, {
        method: body ? "POST" : "GET",
        headers: { authorization: `Bearer ${this.token}`, ...(body ? { "content-type": "application/json" } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
      });
      status = response.status;
      const value = await response.json() as T & { error?: { code: string; message: string } };
      if (!response.ok) throw new WorldError(status, value.error?.code ?? `HTTP_${status}`, (value.error?.message ?? "world request failed").replaceAll(this.token, "[REDACTED]"));
      return value;
    } catch (error) {
      if (error instanceof WorldError) throw error;
      // fetch/代理的错误文本可能包含凭据或 URL；不传播底层异常。
      throw new WorldError(status ?? 0, "NETWORK_ERROR", "world 请求失败，可使用原幂等键重放");
    } finally {
      logEvent({ event: "world.http", actionType: body?.action_type, status: String(status ?? "network_error"), durationMs: Date.now() - started });
    }
  }
  async listObjects(filters: { external_system?: string; external_id?: string; domain_id?: string; type?: string; unit_id?: string; period?: string; limit?: number; cursor?: string } = {}): Promise<WorldHead[]> {
    const items: WorldHead[] = [];
    let cursor = filters.cursor;
    do {
      const query = new URLSearchParams();
      for (const [key, value] of Object.entries({ ...filters, cursor })) if (value !== undefined) query.set(key, String(value));
      const page = await this.request<{ items: WorldHead[]; next_cursor: string | null }>(`/v1/world/objects?${query}`);
      items.push(...page.items);
      cursor = page.next_cursor ?? undefined;
    } while (cursor);
    return items;
  }
  /**
   * 健康检查：GET /v1/health（不带凭证）。旧的 /healthz 是兼容接口，现在返回 503，不再使用。
   * 200 且正文 ok 不为 false 才算健康；非 200 抛 WORLD_UNHEALTHY（带 HTTP 状态），网络错误抛 NETWORK_ERROR。正文里不含版本号。
   */
  async health(): Promise<void> {
    let response: Response;
    try {
      response = await fetch(`${this.apiUrl}/v1/health`, { signal: AbortSignal.timeout(this.timeoutMs), redirect: "error" });
    } catch {
      throw new WorldError(0, "NETWORK_ERROR", "world 健康检查失败");
    }
    const body = await response.json().catch(() => null) as { ok?: unknown } | null;
    if (!response.ok || body?.ok === false) throw new WorldError(response.status, "WORLD_UNHEALTHY", "world 健康检查未通过");
  }
  /** 服务端版本：GET /openapi.json（不带凭证）里的 info.version；取不到时为 null，不影响读取。 */
  async serverVersion(): Promise<string | null> {
    try {
      const response = await fetch(`${this.apiUrl}/openapi.json`, { signal: AbortSignal.timeout(this.timeoutMs), redirect: "error" });
      if (!response.ok) return null;
      const body = await response.json().catch(() => null) as { info?: { version?: unknown } } | null;
      const value = body?.info?.version;
      return typeof value === "string" && value.trim() ? value.trim() : null;
    } catch {
      return null;
    }
  }
  /** 取事件（只读）：subject_refs 含该对象、occurred_at 不早于 since 的事件。 */
  async getEvents(id: string, since?: string): Promise<{ items?: Record<string, unknown>[]; events?: Record<string, unknown>[] } & Record<string, unknown>> {
    return this.request(`/v1/world/objects/${encodeURIComponent(id)}/events${since ? `?since=${encodeURIComponent(since)}` : ""}`);
  }
  /** 取状态（只读）：对象最新一条状态快照；没有快照时 snapshot 为 null。 */
  async getState(id: string): Promise<{ object_id: string; snapshot: WorldStateSnapshot | null }> {
    return this.request(`/v1/world/objects/${encodeURIComponent(id)}/state`);
  }
  async identity(): Promise<WorldIdentity> { return this.request("/v1/identity"); }
  async getObject(id: string): Promise<WorldObject> { return this.request(`/v1/world/objects/${encodeURIComponent(id)}`); }
  async getHead(id: string): Promise<WorldHead> {
    const object = await this.getObject(id);
    return { ...object.business, external_refs: object.business.attributes.external_refs, lifecycle: object.records.lifecycle, contract_version: object.protocol.contract_version };
  }
  async byExternalRef(id: string): Promise<WorldHead | null> {
    const items = await this.listObjects({ external_system: "tianshu", external_id: id });
    if (items.length > 1) throw new WorldError(409, "INVALID_STATE", `外部引用 ${id} 对应多个对象`);
    return items[0] ? this.getHead(items[0].object_id) : null;
  }
  async savedRequest(key: string): Promise<WorldAction | null> {
    const result = await this.q("SELECT request_body FROM world_sync_ledger WHERE instance = $1 AND idempotency_key = $2 ORDER BY id DESC LIMIT 1", [this.instance, key]);
    return result.rows[0]?.request_body ?? null;
  }
  /** build 每次重新读取当前头；网络重放优先使用台账中的完整请求。 */
  async write(key: string, build: () => Promise<WorldAction>): Promise<WorldReceipt> {
    if (this.readOnly) throw new WorldError(403, "WORLD_READ_ONLY", "该实例写死只读，不写本体");
    if (key.length < 16 || key.length > 128) throw new WorldError(422, "INVALID_REQUEST", "幂等键必须为 16–128 字符");
    const saved = await this.q("SELECT request_body, prepared, error_code FROM world_sync_ledger WHERE instance = $1 AND idempotency_key = $2 ORDER BY id DESC LIMIT 1", [this.instance, key]);
    const previous = saved.rows[0];
    const stale = REBUILD_CODES.has(previous?.error_code);
    let body: WorldAction = previous && !stale ? previous.request_body : await build();
    let preparedReplay = !stale && previous?.prepared === true;
    for (let attempt = 0; ; attempt++) {
      if (body.idempotency_key !== key) throw new WorldError(422, "INVALID_REQUEST", "请求幂等键不一致");
      const inserted = await this.q(
        `INSERT INTO world_sync_ledger (instance, action_type, idempotency_key, target_ref, status, request_digest, request_body)
         VALUES ($1, $2, $3, $4, 'pending', $5, $6::jsonb) RETURNING id`,
        [this.instance, body.action_type, key, body.target?.object_id ?? (body.params.declaration as { scene?: string } | undefined)?.scene ?? null, requestDigest(body), JSON.stringify(body)],
      );
      const id = inserted.rows[0].id;
      try {
        // commit 回包丢失或同键重放时，直接重放已 prepare 的原信封；不能刷新依赖导致幂等冲突。
        if (!preparedReplay) {
          const prepared = await this.request<{ expected_versions: unknown[] }>("/v1/actions/prepare", body);
          body = { ...body, expected_versions: prepared.expected_versions };
        }
        await this.q("UPDATE world_sync_ledger SET request_body = $2::jsonb, request_digest = $3, prepared = true WHERE id = $1", [id, JSON.stringify(body), requestDigest(body)]);
        const receipt = await this.request<WorldReceipt>("/v1/actions", body);
        await this.q("UPDATE world_sync_ledger SET status = 'committed', receipt_id = $2 WHERE id = $1", [id, receipt.receipt_id]);
        return receipt;
      } catch (error) {
        const code = worldErrorCode(error);
        await this.q("UPDATE world_sync_ledger SET status = $2, error_code = $3 WHERE id = $1", [id, code === "NETWORK_ERROR" ? "network_error" : "failed", code]);
        logEvent({ event: "world.write", actionType: body.action_type, status: "failed", errorCode: code });
        if (attempt === 0 && REBUILD_CODES.has(code)) { body = await build(); preparedReplay = false; continue; }
        throw error;
      }
    }
  }
}
