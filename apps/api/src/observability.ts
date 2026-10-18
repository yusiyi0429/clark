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

/**
 * 正文里夹带的凭证（用户贴进对话、记忆里抄到的密钥）：按常见格式替换。记忆正文、对话正文本身不脱敏（R6），只去掉凭证。
 * LangSmith 个人/服务 key、OpenAI 式 sk- key、Bearer 头、JWT。
 */
const SECRET_TEXT = /\blsv2_[A-Za-z0-9_-]{8,}|\bsk-[A-Za-z0-9_-]{16,}|\bBearer\s+[A-Za-z0-9._~+/-]{16,}=*|\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g;
export function redactSecretText(text: string): string {
  return text.replace(SECRET_TEXT, REDACTED);
}

export function redactSecrets(value: unknown): unknown {
  if (typeof value === "string") return redactSecretText(value);
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
  errorCode?: string | null;
};

export function logEvent(fields: LogFields & Record<string, unknown>): void {
  const entry = redactSecrets({ ts: new Date().toISOString(), ...fields }) as Record<string, unknown>;
  // MCP 审计只保留令牌的 UUID 标识；明文令牌与 secret_hash 仍按通用规则脱敏。
  if (fields.event === "mcp.tool" && typeof fields.tokenId === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(fields.tokenId)) entry.tokenId = fields.tokenId;
  process.stdout.write(`${JSON.stringify(entry)}\n`);
}
