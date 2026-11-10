import { join } from "node:path";
import { LocalEffort, type TLocalEffort } from "@warmap/contracts";
import { QUOTA_TTL_MS } from "./quota.js";
import { readJson, writeJsonAtomic } from "./store.js";

type Json = Record<string, any>;

/** Claude 订阅能用的一个模型（Claude Code 握手回的 models 里的一条）：value 是拉起时传给 --model 的名字。 */
export interface ClaudeModel { model: string; label: string; efforts: TLocalEffort[] }

const KNOWN = new Set<string>(LocalEffort.anyOf.map((s: { const: string }) => s.const));

/** 模型配置 id：cc- 加 Claude Code 给的名字，不是字母、数字、_、- 的换成 _（契约 Id 只收这些）。 */
export const claudeProfileId = (model: string) => `cc-${model.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 80);
export const isClaudeProfileId = (id: string) => id.startsWith("cc-");

/** 实际是哪个系列的哪一版：claude-opus-5-5 → opus 5.5，claude-haiku-4-5-20251001 → haiku 4.5；认不出为 null。 */
function versionOf(resolved: string): { family: string; version: number } | null {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(resolved.toLowerCase());
  return m ? { family: m[1]!, version: Number(m[2]) * 100 + Number(m[3] ?? 0) } : null;
}

/**
 * 握手回的 models → 要列的模型（11/10 用户：从简，同 Claude Code 自己菜单的主列表）：每个系列只留最新的一个（按 resolvedModel 认，同一版有几条的留前面那条），
 * 系列和版本认不出来的照列；「default」不列（内置的订阅配置就是不指定模型）。思考程度只留契约里有的档，不支持选的为空。
 * 11/10 实测 2.1.318：每条有 value、resolvedModel、displayName、supportsEffort、supportedEffortLevels。
 */
export function claudeCatalogFrom(models: unknown): ClaudeModel[] {
  const all: (ClaudeModel & { v: ReturnType<typeof versionOf> })[] = [];
  for (const m of Array.isArray(models) ? models as Json[] : []) {
    const model = typeof m?.value === "string" ? m.value : "";
    if (!model || model === "default" || model.length > 120 || all.some((x) => x.model === model)) continue;
    const efforts = (Array.isArray(m.supportedEffortLevels) ? m.supportedEffortLevels : []).filter((e: unknown): e is TLocalEffort => typeof e === "string" && KNOWN.has(e));
    all.push({ model, label: String(m.displayName || model).slice(0, 40), efforts: [...new Set<TLocalEffort>(efforts)].slice(0, 8), v: versionOf(String(m.resolvedModel ?? model)) });
  }
  const top = new Map<string, number>();
  for (const x of all) if (x.v) top.set(x.v.family, Math.max(top.get(x.v.family) ?? 0, x.v.version));
  const kept = new Set<string>();
  return all.filter((x) => {
    if (!x.v) return true;
    if (x.v.version !== top.get(x.v.family) || kept.has(x.v.family)) return false;
    kept.add(x.v.family);
    return true;
  }).map(({ v: _v, ...m }) => m);
}

/**
 * 本人 Claude 订阅能用的模型（设计 17.2 第 40 条）：起一个不发提示的 Claude Code 握手就读得到（见 claudeCode.ts 的 readModels），不花 token。
 * 5 分钟读一次；读到的存进数据目录（本机程序重启后、一时读不到时，选了目录里模型的会话还认得自己的模型）。做法同 CodexCatalog。
 */
export class ClaudeCatalog {
  private readonly file: string;
  private models: ClaudeModel[];
  private reading: Promise<void> | null = null;
  private triedAt = 0;

  constructor(dataDir: string, private readonly read: () => Promise<unknown[] | null>, private readonly now = () => Date.now()) {
    this.file = join(dataDir, "claude-models.json");
    this.models = readJson<ClaudeModel[]>(this.file, []);
  }

  list(): ClaudeModel[] { return this.models; }

  /** 读一次（5 分钟内试过就不再读）。没装（read 回 null）就清空；握手没过、握手里没有模型列表（老版本）留着上次的。从不抛错。 */
  refresh(force = false): Promise<void> {
    if (!force && this.now() - this.triedAt < QUOTA_TTL_MS) return this.reading ?? Promise.resolve();
    if (this.reading) return this.reading;
    this.triedAt = this.now();
    this.reading = this.read()
      .then((models) => {
        const next = models === null ? [] : claudeCatalogFrom(models);
        if (models !== null && !next.length) return; // 没报模型（老版本、握手里没有这一项）：留着上次的
        if (models === null && !this.models.length) return;
        this.models = next;
        writeJsonAtomic(this.file, this.models);
      })
      .catch(() => { /* 读不到：留着上次的 */ })
      .finally(() => { this.reading = null; });
    return this.reading;
  }
}
