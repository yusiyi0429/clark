import { join } from "node:path";
import { LocalEffort, type TLocalEffort } from "@warmap/contracts";
import { QUOTA_TTL_MS } from "./quota.js";
import { readJson, writeJsonAtomic } from "./store.js";

type Json = Record<string, any>;

/** Codex 订阅能用的一个模型（model/list 里的一条）。 */
export interface CodexModel { model: string; label: string; efforts: TLocalEffort[]; defaultEffort: TLocalEffort | null }

const KNOWN = new Set<string>(LocalEffort.anyOf.map((s: { const: string }) => s.const));
const effortOf = (v: unknown): TLocalEffort | null => (typeof v === "string" && KNOWN.has(v) ? v as TLocalEffort : null);

/** 模型配置 id：codex- 加模型名，不是字母、数字、_、- 的换成 _（契约 Id 只收这些）。 */
export const codexProfileId = (model: string) => `codex-${model.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 80);
export const isCodexProfileId = (id: string) => id.startsWith("codex-");

/** model/list 的回执 → 模型：不列 hidden 的；思考程度只留契约里有的档（Codex 报的 none、minimal 之类不列）。 */
export function catalogFrom(res: Json): CodexModel[] {
  const out: CodexModel[] = [];
  for (const m of Array.isArray(res.data) ? res.data : []) {
    const model = typeof m?.model === "string" ? m.model : typeof m?.id === "string" ? m.id : "";
    if (!model || m.hidden || model.length > 120) continue;
    const efforts: TLocalEffort[] = (Array.isArray(m.supportedReasoningEfforts) ? m.supportedReasoningEfforts : []).map((e: Json) => effortOf(e?.reasoningEffort)).filter((e: TLocalEffort | null): e is TLocalEffort => e !== null);
    const def = effortOf(m.defaultReasoningEffort);
    out.push({ model, label: String(m.displayName || model).slice(0, 40), efforts: [...new Set(efforts)].slice(0, 8), defaultEffort: def && efforts.includes(def) ? def : null });
  }
  return out;
}

/**
 * 本人 Codex 订阅能用的模型（设计 17.2 第 38 条）：codex app-server 的 model/list，登录着才读得到（没登录、没装为空）。
 * 5 分钟读一次；读到的存进数据目录（本机程序重启后、Codex 一时读不到时，已开的 Codex 会话还认得自己的模型）。
 */
export class CodexCatalog {
  private readonly file: string;
  private models: CodexModel[];
  private reading: Promise<void> | null = null;
  private triedAt = 0;

  constructor(dataDir: string, private readonly read: () => Promise<Json | null>, private readonly now = () => Date.now()) {
    this.file = join(dataDir, "codex-models.json");
    this.models = readJson<CodexModel[]>(this.file, []);
  }

  list(): CodexModel[] { return this.models; }

  /** 读一次（5 分钟内试过就不再读）。没登录、没装（read 回 null）就清空；读不到留着上次的。从不抛错。 */
  refresh(force = false): Promise<void> {
    if (!force && this.now() - this.triedAt < QUOTA_TTL_MS) return this.reading ?? Promise.resolve();
    if (this.reading) return this.reading;
    this.triedAt = this.now();
    this.reading = this.read()
      .then((res) => {
        this.models = res ? catalogFrom(res) : [];
        writeJsonAtomic(this.file, this.models);
      })
      .catch(() => { /* 读不到：留着上次的 */ })
      .finally(() => { this.reading = null; });
    return this.reading;
  }
}
