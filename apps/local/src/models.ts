import { join } from "node:path";
import type { TLocalEffort, TLocalModelOrigin, TLocalModelProfile, TLocalModelProfileUpsert, TLocalModelTier } from "@warmap/contracts";
import { claudeProfileId, isClaudeProfileId, type ClaudeModel } from "./claudeCatalog.js";
import { codexProfileId, isCodexProfileId, type CodexModel } from "./codexCatalog.js";
import { isLoopback, isMagpie, modelOrigin } from "./modelOrigin.js";
import { readJson, writeJsonAtomic } from "./store.js";
import type { SecretStore } from "./secrets.js";
import { isTokenHubProfileId, tokenHubProfileId } from "./tokenHub.js";

export const SUBSCRIPTION_ID = "subscription";

/** 拉起执行方时用的完整模型配置（含钥匙），只在本机进程里流转。 */
export interface ResolvedModel {
  profileId: string;
  label: string;
  source: "subscription" | "gateway";
  baseUrl: string | null;
  model: string | null;
  smallModel: string | null;
  webSearch: boolean;
  apiKey: string | null;
  /** 认出的真正来源（经 magpie 的、厂商 API 的），给人看和按来源算用量。 */
  origin: TLocalModelOrigin;
}

/**
 * 能选的思考程度（契约 LocalEffort）：Claude Code 的订阅模型都是这五档（11/09 实测 2.1.318 握手报的 Opus 5.5、Fable 5.1、Sonnet 5.5、Haiku 5.5）；
 * 网关模型本机不传思考程度，不给选；Codex 的按它模型目录里这个模型的几档（见 CodexCatalog）。
 */
const CLAUDE_EFFORTS: TLocalEffort[] = ["low", "medium", "high", "xhigh", "max"];
const effortsOf = (p: Entry): TLocalEffort[] => p.efforts ?? (p.agent === "claude-code" && p.source === "subscription" ? [...CLAUDE_EFFORTS] : []);

/** magpie 不认钥匙：照它的约定传 magpie（本人没填时）。 */
const MAGPIE_KEY = "magpie";

type Stored = Omit<TLocalModelProfile, "hasKey" | "origin" | "efforts" | "defaultEffort" | "catalog" | "modelName">;
/** 本人配的，或执行方模型目录里现列的（带能选的几档和默认档）。 */
type Entry = Stored & { efforts?: TLocalEffort[]; defaultEffort?: TLocalEffort | null; catalog?: true };

/** Codex 模型目录里的一个模型 → 模型配置（只读）。 */
const fromCatalog = (m: CodexModel): Entry => ({
  id: codexProfileId(m.model), label: m.label, source: "subscription", agent: "codex", baseUrl: null, model: m.model, smallModel: null,
  webSearch: true, isDefault: false, efforts: m.efforts, defaultEffort: m.defaultEffort, catalog: true,
});

/** Claude 订阅模型目录里的一个模型 → 模型配置（只读）：model 原样传给 --model。 */
const fromClaudeCatalog = (m: ClaudeModel): Entry => ({
  id: claudeProfileId(m.model), label: m.label, source: "subscription", agent: "claude-code", baseUrl: null, model: m.model, smallModel: null,
  webSearch: true, isDefault: false, efforts: m.efforts, defaultEffort: null, catalog: true,
});

/** 内置的那条不指定模型（本机按档位和预算模式挑）：选模型时「模型」那一行叫「自动」。 */
const AUTO_MODEL_NAME = "自动";
const builtIn: Stored = {
  id: SUBSCRIPTION_ID, label: "Claude 订阅", source: "subscription", agent: "claude-code",
  baseUrl: null, model: null, smallModel: null, webSearch: true, isDefault: true,
};

/** 连接页连 TokenHub 建的那些（th- 开头）共用一把钥匙。 */
const TOKENHUB_KEY = "tokenhub";
const keyName = (id: string) => (isTokenHubProfileId(id) ? TOKENHUB_KEY : `model:${id}`);
/** 档位怎么认模型：和网页（apps/web 的 modelForTier）同一套。 */
const TIER_MATCH: Record<TLocalModelTier, RegExp> = { strong: /opus/i, normal: /sonnet/i, light: /haiku|flash|mini|lite/i };

/**
 * 经网关实测会真的执行 Claude Code 自带联网搜索的模型（11/06，TokenHub 的 Anthropic 入口）。不在这里的网关模型默认关掉自带搜索：
 * 不支持的会静默不搜、凭记忆编结果。本人实测过别的模型能搜，可以在模型配置里手动打开。
 */
export const VERIFIED_SEARCH_MODELS = ["wangsu/claude-opus-5-5", "wangsu/deepseek-v4.1-flash"];
const searchDefault = (source: string, model: string | null) => source !== "gateway" || VERIFIED_SEARCH_MODELS.includes(model ?? "");

/** 去掉「厂商/」前缀和 Claude Code 的 [1m] 后缀，小写：比较和认名字都用它。 */
const bare = (model: string) => model.slice(model.lastIndexOf("/") + 1).replace(/\[1m\]$/i, "").toLowerCase();
const ALIAS = /^(opus|sonnet|haiku|fable)$/;
const FULL = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/**
 * 给人看的模型名（契约 LocalRun.modelName）：claude-opus-5-5 →「Opus 5.5」、claude-sonnet-4-20250514 →「Sonnet 4」；
 * 别名 opus →「Opus」；别的（网关模型）去掉「厂商/」前缀原样，如 wangsu/qwen3.8-flash → qwen3.8-flash。
 */
export function modelDisplayName(model: string): string {
  const b = bare(model);
  const full = FULL.exec(b);
  if (full) return `${cap(full[1]!)} ${full[2]}${full[3] ? `.${full[3]}` : ""}`;
  const alias = ALIAS.exec(b);
  if (alias) return cap(alias[1]!);
  return model.slice(model.lastIndexOf("/") + 1).slice(0, 60);
}

/** 请求的和执行方实际报的是不是同一个：一样，或者请求的是别名、实际是这个系列的某一版（opus → claude-opus-5-5）。 */
export function sameModel(requested: string, actual: string): boolean {
  const r = bare(requested), a = bare(actual);
  if (r === a) return true;
  const alias = ALIAS.exec(r);
  return Boolean(alias && FULL.exec(a)?.[1] === alias[1]);
}

export class ModelProfiles {
  private readonly file: string;
  /** 别名在这台电脑上实际跑出来是哪一版（opus → claude-opus-5-5）：开工前写「Opus 5.5」用。 */
  private readonly aliasFile: string;
  constructor(
    dataDir: string, private readonly secrets: SecretStore, private readonly codex: { list(): CodexModel[] } | null = null,
    private readonly claude: { list(): ClaudeModel[] } | null = null,
  ) {
    this.file = join(dataDir, "models.json");
    this.aliasFile = join(dataDir, "model-aliases.json");
  }

  /** 给人看的名字：别名用上一次实际跑出来的那一版，没跑过就是「Opus」这种。 */
  displayName(model: string): string {
    const alias = ALIAS.exec(bare(model));
    const seen = alias ? readJson<Record<string, string>>(this.aliasFile, {})[alias[1]!] : undefined;
    return modelDisplayName(seen ?? model);
  }

  /** 执行方报了实际模型：请求的是别名、实际是这个系列的某一版时记下来。 */
  noteActual(requested: string, actual: string): void {
    const alias = ALIAS.exec(bare(requested));
    if (!alias || !sameModel(requested, actual)) return;
    const map = readJson<Record<string, string>>(this.aliasFile, {});
    const version = bare(actual);
    if (map[alias[1]!] === version) return;
    writeJsonAtomic(this.aliasFile, { ...map, [alias[1]!]: version });
  }

  private stored(): Stored[] {
    const list = readJson<Stored[]>(this.file, []).filter((p) => p.id !== SUBSCRIPTION_ID);
    const hasDefault = list.some((p) => p.isDefault);
    return [{ ...builtIn, isDefault: !hasDefault }, ...list];
  }

  /** 本人配的，加上 Claude 订阅、Codex 订阅模型目录里现列的。 */
  private all(): Entry[] {
    return [...this.stored(), ...(this.claude?.list() ?? []).map(fromClaudeCatalog), ...(this.codex?.list() ?? []).map(fromCatalog)];
  }

  /** 给人看的模型名（契约 LocalModelProfile.modelName）。 */
  private modelNameOf(p: Entry): string {
    if (p.catalog) return p.label;
    return p.model ? this.displayName(p.model) : p.id === SUBSCRIPTION_ID ? AUTO_MODEL_NAME : p.label;
  }

  async list(): Promise<TLocalModelProfile[]> {
    const out: TLocalModelProfile[] = [];
    for (const p of this.all()) {
      out.push({ ...p, origin: modelOrigin(p), modelName: this.modelNameOf(p), efforts: effortsOf(p), defaultEffort: p.defaultEffort ?? null, catalog: Boolean(p.catalog), webSearch: p.webSearch ?? searchDefault(p.source, p.model), hasKey: p.source === "gateway" ? Boolean(await this.secrets.get(keyName(p.id))) : false });
    }
    return out;
  }

  async upsert(id: string, body: TLocalModelProfileUpsert): Promise<TLocalModelProfile> {
    if (id === SUBSCRIPTION_ID) throw new Error("内置的订阅配置不能改");
    if (isCodexProfileId(id)) throw new Error("Codex 的模型从它自己的模型目录来，不能改");
    if (isClaudeProfileId(id)) throw new Error("Claude 订阅的模型从它自己的模型目录来，不能改（cc- 开头的 id 留给它）");
    if (body.agent === "codex") throw new Error("Codex 的模型从它自己的模型目录来，不用配");
    if (isTokenHubProfileId(id)) {
      // 连接页连 TokenHub 建的：名字、默认、联网搜索能改；地址和钥匙只经连接页换（钥匙几条共用）
      const own = this.stored().find((p) => p.id === id);
      if (!own) throw new Error("th- 开头的 id 留给连接页连 TokenHub");
      if (body.source !== "gateway" || (body.baseUrl ?? null) !== own.baseUrl || body.model !== own.model || body.apiKey !== undefined) throw new Error("TokenHub 的地址、模型和钥匙在连接页换");
    }
    const gateway = body.source === "gateway";
    if (gateway && !body.baseUrl) throw new Error("网关模型要填地址");
    // 钥匙会发到这个地址：别处的要 https，本机地址（magpie 等）可以 http
    if (gateway && body.baseUrl!.startsWith("http:") && !isLoopback(body.baseUrl!)) throw new Error("只有本机地址可以用 http，别的要 https");
    if (!gateway && (body.baseUrl || body.apiKey)) throw new Error("订阅模型不填地址和钥匙");
    let list = this.stored().slice(1);
    if (body.isDefault) list = list.map((p) => ({ ...p, isDefault: false }));
    const prev = list.find((p) => p.id === id);
    const next: Stored = {
      id, label: body.label, source: body.source, agent: body.agent ?? "claude-code",
      baseUrl: gateway ? body.baseUrl!.replace(/\/+$/, "") : null, model: body.model, smallModel: body.smallModel ?? null,
      webSearch: body.webSearch ?? searchDefault(body.source, body.model),
      isDefault: body.isDefault ?? prev?.isDefault ?? false,
    };
    list = prev ? list.map((p) => (p.id === id ? next : p)) : [...list, next];
    writeJsonAtomic(this.file, list);
    if (!gateway) await this.secrets.delete(keyName(id));
    else if (body.apiKey !== undefined) {
      if (body.apiKey === "") await this.secrets.delete(keyName(id));
      else await this.secrets.set(keyName(id), body.apiKey);
    } else if (prev && prev.baseUrl !== next.baseUrl) {
      // 地址变了却没给新钥匙：旧钥匙作废，免得被网页改个地址就把本人的钥匙发到别处。
      await this.secrets.delete(keyName(id));
    }
    return (await this.list()).find((p) => p.id === id)!;
  }

  async remove(id: string): Promise<boolean> {
    if (id === SUBSCRIPTION_ID) return false;
    const list = this.stored().slice(1);
    if (!list.some((p) => p.id === id)) return false;
    const rest = list.filter((p) => p.id !== id);
    writeJsonAtomic(this.file, rest);
    if (!isTokenHubProfileId(id) || !rest.some((p) => isTokenHubProfileId(p.id))) await this.secrets.delete(keyName(id));
    return true;
  }

  /**
   * 连上 TokenHub（契约 POST /v1/tokenhub）：钥匙存一份，每个模型一条 th- 开头的网关配置。上次建的、这次也有的留着本人改过的名字、默认和联网搜索；
   * 这次没有的删掉。先存钥匙，存不上就什么都不改。makeDefault：默认还是内置那条（本人没另设）时，把这个模型的那条设成默认。
   */
  async setTokenHub(baseUrl: string, apiKey: string, models: string[], makeDefault: string | null = null): Promise<void> {
    await this.secrets.set(TOKENHUB_KEY, apiKey);
    const list = this.stored().slice(1);
    const before = new Map(list.filter((p) => isTokenHubProfileId(p.id)).map((p) => [p.id, p]));
    const labels = new Set<string>();
    const added: Stored[] = [];
    for (const model of models) {
      const id = tokenHubProfileId(model);
      if (added.some((p) => p.id === id)) continue;
      const prev = before.get(id);
      // 名字用给人看的模型名；两个模型叫得一样时（不同厂商的同一个模型）用 TokenHub 的模型名
      const shown = modelDisplayName(model).slice(0, 40);
      const label = prev?.label ?? (labels.has(shown) ? model.slice(0, 40) : shown);
      labels.add(label);
      added.push({ ...(prev ?? { label, agent: "claude-code", smallModel: null, webSearch: searchDefault("gateway", model), isDefault: false }), id, source: "gateway", baseUrl: baseUrl.replace(/\/+$/, ""), model });
    }
    const next = [...list.filter((p) => !isTokenHubProfileId(p.id)), ...added];
    const target = makeDefault && !next.some((p) => p.isDefault) ? tokenHubProfileId(makeDefault) : null;
    writeJsonAtomic(this.file, next.map((p) => (p.id === target ? { ...p, isDefault: true } : p)));
  }

  /** 断开 TokenHub（契约 DELETE /v1/tokenhub）：删 th- 开头的配置和那把钥匙。 */
  async removeTokenHub(): Promise<void> {
    writeJsonAtomic(this.file, this.stored().slice(1).filter((p) => !isTokenHubProfileId(p.id)));
    await this.secrets.delete(TOKENHUB_KEY);
  }

  /**
   * 这个配置现在叫什么（没有这个配置为 null）：label 配置的名字；sourceLabel 来源的名字——本人配的写配置的名字，
   * 模型目录里的一条配置的名字就是模型名，来源写认出的那个（「Claude 订阅」「Codex 订阅」）；origin 认出的来源。
   */
  naming(id: string): { label: string; sourceLabel: string; origin: TLocalModelOrigin } | null {
    const p = this.all().find((x) => x.id === id);
    if (!p) return null;
    const origin = modelOrigin(p);
    return { label: p.label, sourceLabel: p.catalog ? origin.label.slice(0, 40) : p.label, origin };
  }

  /** 这个配置能选的思考程度（没有这个配置为空）。 */
  efforts(id: string): TLocalEffort[] {
    const p = this.all().find((x) => x.id === id);
    return p ? effortsOf(p) : [];
  }

  /** 不选思考程度时用哪档（Codex 模型目录里的默认档；别的为 null，按档位和预算模式定）。 */
  defaultEffort(id: string): TLocalEffort | null {
    return this.all().find((x) => x.id === id)?.defaultEffort ?? null;
  }

  /** 这个配置给哪个执行方用（没有这个配置为 null）。 */
  agentOf(id: string): "claude-code" | "codex" | null {
    return this.all().find((p) => p.id === id)?.agent ?? null;
  }

  /** 这个配置是订阅还是网关（没有这个配置为 null）：额度用完时只停订阅的卡。 */
  sourceOf(id: string): "subscription" | "gateway" | null {
    return this.all().find((p) => p.id === id)?.source ?? null;
  }

  /**
   * 按档位挑模型（验收员由本机自己起时用）：和网页的 modelForTier 一样，只在默认模型（标了默认的，没有就第一条）那个来源里按模型名和名字认，
   * 认不出用默认的（11/11 本人定 A：连了 TokenHub、默认是订阅时不悄悄改用 TokenHub）。来源的分法同网页模型面板的 sourceIdOf：
   * 有 sourceId（添加来源建的）先认它，订阅一组，网关按认出的来源（经 magpie 的另算）。
   */
  forTier(tier: TLocalModelTier): string {
    const all = this.stored();
    const fallback = all.find((p) => p.isDefault) ?? all[0]!;
    const source = this.sourceGroup(fallback);
    return (all.find((p) => this.sourceGroup(p) === source && TIER_MATCH[tier].test(`${p.model ?? ""} ${p.label}`)) ?? fallback).id;
  }

  private sourceGroup(p: Stored): string {
    const sourceId = (p as { sourceId?: string }).sourceId;
    if (sourceId) return `source:${sourceId}`;
    if (p.source === "subscription") return p.agent === "codex" ? "codex" : "claude-subscription";
    const o = modelOrigin(p);
    return `${o.provider}${o.via ? `:${o.via}` : ""}`;
  }

  async resolve(id?: string): Promise<ResolvedModel | null> {
    const all = this.all();
    const p = id ? all.find((x) => x.id === id) : all.find((x) => x.isDefault) ?? all[0];
    if (!p) return null;
    return {
      profileId: p.id, label: p.label, source: p.source,
      baseUrl: p.baseUrl, model: p.model, smallModel: p.smallModel, webSearch: p.webSearch ?? searchDefault(p.source, p.model),
      apiKey: p.source === "gateway" ? (await this.secrets.get(keyName(p.id))) ?? (isMagpie(p.baseUrl) ? MAGPIE_KEY : null) : null,
      origin: modelOrigin(p),
    };
  }
}
