/**
 * 最小结构化日志与脱敏（.tech/07 §6）。
 * 单进程 MVP 直接写 stdout JSON 行，不引入日志平台；字段名是外部可观察契约。
 */
const REDACTED = "[REDACTED]";
// camelCase 先拆成 kebab-case，避免 `totalTokens` 被当作 token 误删。
const SECRET_KEY = /(^|[-_])(password|passwd|passcode|secret|cookie|token|authorization|credential|api-key)($|[-_])/;
/** 完整 CompanyMemory passage 与完整 Transcript 不进入日志/trace。 */
const BULK_KEY = /(^|[-_])(passage|passages|transcript)($|[-_])/;

function isSensitive(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/g, "$1-$2").toLowerCase();
  return SECRET_KEY.test(normalized) || BULK_KEY.test(normalized);
}

export function redactSecrets(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactSecrets);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value)) {
      out[key] = isSensitive(key) ? REDACTED : redactSecrets(inner);
    }
    return out;
  }
  return value;
}

export type LogFields = {
  event: string;
  requestId?: string;
  runId?: string;
  scope?: string;
  objectRef?: string;
  actionType?: string;
  agentKind?: string;
  provider?: string;
  model?: string;
  durationMs?: number;
  status?: string;
  errorCode?: string;
};

export function logEvent(fields: LogFields & Record<string, unknown>): void {
  const entry = redactSecrets({ ts: new Date().toISOString(), ...fields }) as Record<string, unknown>;
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}
