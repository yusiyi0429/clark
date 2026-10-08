import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { Query } from "./meetingStore.js";
import { logEvent } from "./observability.js";

export type WorldInstance = { scope_id: string; domains: { company: string; eo: string }; people: Record<string, string> };
export function loadWorldInstance(): WorldInstance {
  return JSON.parse(readFileSync(new URL("../config/world-instance.json", import.meta.url), "utf8"));
}
export type WorldEnv = { worldApiUrl?: string; worldAgentToken?: string };
export const worldConfigured = (env: WorldEnv): boolean => Boolean(env.worldApiUrl && env.worldAgentToken);
export type WorldExternalRef = { system: string; id: string; url?: string | null };
export type WorldHead = {
  object_id: string; object_type: string; title: string; revision_id: string;
  object_version: number; version: number; domain_id?: string;
  external_refs?: WorldExternalRef[]; lifecycle: unknown;
};
export type WorldObject = {
  business: Omit<WorldHead, "lifecycle"> & { attributes: { responsible?: string; external_refs?: WorldExternalRef[] } };
  records: { lifecycle: unknown };
};
export const worldRef = (head: WorldHead): string => `${head.object_id}@${head.version}`;
export const worldTarget = (head: WorldHead) => ({ object_id: head.object_id, revision_id: head.revision_id, expected_version: head.object_version });
export type WorldAction = {
  action_type: string;
  contract_version: "tkos.world/0.2";
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
/** JSONB 读回会重排对象键，摘要按键排序，数组顺序保持不变。 */
export const requestDigest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value, (_key, entry) =>
  entry && typeof entry === "object" && !Array.isArray(entry)
    ? Object.fromEntries(Object.entries(entry).sort(([left], [right]) => left.localeCompare(right)))
    : entry,
)).digest("hex");

export class WorldClient {
  readonly instance: string;
  readonly config: WorldInstance;
  private readonly apiUrl: string;
  private readonly token: string;
  constructor(private readonly q: Query, env: WorldEnv, config = loadWorldInstance()) {
    if (!worldConfigured(env)) throw new WorldError(503, "WORLD_NOT_CONFIGURED", "world 未配置");
    this.apiUrl = env.worldApiUrl!.replace(/\/+$/, "");
    const url = new URL(this.apiUrl);
    if (url.username || url.password || url.search || url.hash) throw new Error("world API URL must not contain credentials, query or fragment");
    this.token = env.worldAgentToken!;
    this.config = config;
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
        signal: AbortSignal.timeout(15_000),
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
  async getObject(id: string): Promise<WorldObject> { return this.request(`/v1/world/objects/${encodeURIComponent(id)}`); }
  async getHead(id: string): Promise<WorldHead> {
    const object = await this.getObject(id);
    return { ...object.business, external_refs: object.business.attributes.external_refs, lifecycle: object.records.lifecycle };
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
    if (key.length < 16 || key.length > 128) throw new WorldError(422, "INVALID_REQUEST", "幂等键必须为 16–128 字符");
    const saved = await this.q("SELECT request_body, prepared, error_code FROM world_sync_ledger WHERE instance = $1 AND idempotency_key = $2 ORDER BY id DESC LIMIT 1", [this.instance, key]);
    const previous = saved.rows[0];
    const stale = previous?.error_code === "VERSION_CONFLICT" || previous?.error_code === "STALE_DEPENDENCY";
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
        if (attempt === 0 && (code === "VERSION_CONFLICT" || code === "STALE_DEPENDENCY")) { body = await build(); preparedReplay = false; continue; }
        throw error;
      }
    }
  }
}
