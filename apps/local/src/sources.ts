import { createHash } from "node:crypto";
import { join } from "node:path";
import type {
  TLocalAgentKind, TLocalModelProfile, TLocalSource, TLocalSourceAddRequest, TLocalSourceCheckRequest, TLocalSourceCheckResponse,
  TLocalSourceFormat, TLocalSourceModel, TLocalSourcePlan, TLocalSourcePreset, TLocalSourceRegion,
} from "@warmap/contracts";
import { modelDisplayName, type ModelProfiles } from "./models.js";
import { isLoopback } from "./modelOrigin.js";
import type { SecretStore } from "./secrets.js";
import { readJson, writeJsonAtomic } from "./store.js";
import { TokenHub, TokenHubError, TOKENHUB_MODELS, listTokenHubModels } from "./tokenHub.js";

/**
 * 添加来源（设计 17.2 第 52 条，契约 /v1/sources）：预设厂商表、按 Key 开头认厂商、按量 API 用一次不花钱的请求验 Key 并列模型、Key 存本机钥匙。
 * 预设里的地址、Key 开头、验 Key 的接口按各家官方文档核过（11/11）；标「未核实」的是官方页面上没写明的，按最常见的写法放。
 */
type Url = string | Record<TLocalSourceRegion, string>;
interface PlanSpec {
  name: string;
  /** 给 Claude Code 的 Anthropic 格式地址。 */
  baseUrl: Url;
  formats: TLocalSourceFormat[];
  /** 不花钱的验法：读模型列表（auth 是 Key 放哪个头）；keyCheck 是先查 Key 的接口（OpenRouter 的模型列表不认 Key）。没有的不发请求，用 models。 */
  list?: { url: Url; auth: "bearer" | "x-api-key"; keyCheck?: Url; keep?: (id: string) => boolean };
  /** 建议先勾的（有列表时排在前面）；没有列表时就是能选的全部。 */
  models: string[];
}
interface Preset { id: string; name: string; regions: TLocalSourceRegion[]; plans: Partial<Record<TLocalSourcePlan, PlanSpec>> }

const ALL: TLocalSourceFormat[] = ["anthropic", "openai_responses", "openai_chat"];
const PRESETS: Preset[] = [
  {
    // https://platform.claude.com/docs/en/api/models/list；sk-ant- 开头是 Anthropic 的惯例（官方页面没写，未核实）
    id: "anthropic", name: "Anthropic 官方 API", regions: [],
    plans: { api: { name: "Anthropic 官方 API", baseUrl: "https://api.anthropic.com", formats: ["anthropic", "openai_chat"],
      list: { url: "https://api.anthropic.com/v1/models", auth: "x-api-key" }, models: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"] } },
  },
  // TokenHub 走第 51 条那条路（POST /v1/tokenhub），这里只为列在预设里
  { id: "tokenhub", name: "TokenHub", regions: [], plans: { api: { name: "TokenHub", baseUrl: "", formats: ["anthropic", "openai_chat"], models: TOKENHUB_MODELS } } },
  {
    // platform.kimi.com/docs（API）、kimi.com/code/docs（Kimi Code 套餐，Key 和开放平台的不通用）；国际的 API 地址未核实
    id: "kimi", name: "Kimi", regions: ["cn", "intl"],
    plans: {
      api: { name: "Kimi API", baseUrl: { cn: "https://api.moonshot.cn/anthropic", intl: "https://api.moonshot.ai/anthropic" }, formats: ALL,
        list: { url: { cn: "https://api.moonshot.cn/v1/models", intl: "https://api.moonshot.ai/v1/models" }, auth: "bearer" }, models: ["kimi-k3.1-pro", "kimi-k3"] },
      coding_plan: { name: "Kimi 编程套餐", baseUrl: { cn: "https://api.kimi.com/coding/", intl: "https://api.kimi.ai/coding/" }, formats: ["anthropic", "openai_responses"],
        models: ["k3.1-pro", "kimi-for-coding"] },
    },
  },
  {
    // docs.bigmodel.cn、docs.z.ai：按量和套餐同一个 Anthropic 地址，走哪份额度看 Key；没有不花钱的验法，按量也不发请求
    id: "glm", name: "GLM", regions: ["cn", "intl"],
    plans: {
      api: { name: "GLM API", baseUrl: { cn: "https://open.bigmodel.cn/api/anthropic", intl: "https://api.z.ai/api/anthropic" }, formats: ALL, models: ["glm-5.3", "glm-5.3-flash"] },
      coding_plan: { name: "GLM 编程套餐", baseUrl: { cn: "https://open.bigmodel.cn/api/anthropic", intl: "https://api.z.ai/api/anthropic" }, formats: ALL, models: ["glm-5.3", "glm-5.3-flash"] },
    },
  },
  {
    // api-docs.deepseek.com：坏 Key 回什么官方没写（按惯例 401，未核实）
    id: "deepseek", name: "DeepSeek", regions: [],
    plans: { api: { name: "DeepSeek API", baseUrl: "https://api.deepseek.com/anthropic", formats: ALL,
      list: { url: "https://api.deepseek.com/models", auth: "bearer" }, models: ["deepseek-v4-pro", "deepseek-flash"] } },
  },
  {
    // help.aliyun.com/zh/model-studio：按量的模型列表要 WorkspaceId、套餐官方明说不能用接口查，都不发请求；套餐 Key 是 sk-sp- 开头
    id: "qwen", name: "通义千问", regions: ["cn", "intl"],
    plans: {
      api: { name: "通义千问 API", baseUrl: { cn: "https://dashscope.aliyuncs.com/apps/anthropic", intl: "https://dashscope-intl.aliyuncs.com/apps/anthropic" }, formats: ALL,
        models: ["qwen3.7-max", "qwen3.6-flash"] },
      coding_plan: { name: "通义千问编程套餐", baseUrl: { cn: "https://coding.dashscope.aliyuncs.com/apps/anthropic", intl: "https://coding-intl.dashscope.aliyuncs.com/apps/anthropic" },
        formats: ["anthropic", "openai_chat"], models: ["qwen3.7-plus"] },
    },
  },
  {
    // platform.minimax.cn、platform.minimax.io：套餐（M Plan）和按量同一个地址、Key 不通用；坏 Key 回什么官方没写
    id: "minimax", name: "MiniMax", regions: ["cn", "intl"],
    plans: {
      api: { name: "MiniMax API", baseUrl: { cn: "https://api.minimax.cn/anthropic", intl: "https://api.minimax.io/anthropic" }, formats: ALL,
        list: { url: { cn: "https://api.minimax.cn/v1/models", intl: "https://api.minimax.io/v1/models" }, auth: "bearer" }, models: ["MiniMax-M3.1-Flash"] },
      coding_plan: { name: "MiniMax 编程套餐", baseUrl: { cn: "https://api.minimax.cn/anthropic", intl: "https://api.minimax.io/anthropic" }, formats: ALL, models: ["MiniMax-M3.1-Flash"] },
    },
  },
  {
    // ark.volcengine.com/docs：套餐用 /api/v3 不扣套餐额度、另计费，所以套餐只给 /api/coding
    id: "volcengine", name: "火山方舟", regions: [],
    plans: {
      api: { name: "火山方舟 API", baseUrl: "https://ark.cn-beijing.volces.com/api/compatible", formats: ALL,
        list: { url: "https://ark.cn-beijing.volces.com/api/v3/models", auth: "bearer" }, models: ["doubao-seed-2.1-pro"] },
      coding_plan: { name: "火山方舟编程套餐", baseUrl: "https://ark.cn-beijing.volces.com/api/coding", formats: ["anthropic", "openai_chat"],
        models: ["ark-code-latest", "doubao-seed-2.1-pro", "glm-5.3", "kimi-k3", "deepseek-v4-pro"] },
    },
  },
  {
    // openrouter.ai/docs：Claude Code 只保证 Anthropic 自家模型，只列 anthropic/ 开头的；验 Key 用 /key（模型列表过去不认 Key）
    id: "openrouter", name: "OpenRouter", regions: [],
    plans: { api: { name: "OpenRouter", baseUrl: "https://openrouter.ai/api", formats: ["anthropic", "openai_chat"],
      list: { url: "https://openrouter.ai/api/v1/models", auth: "bearer", keyCheck: "https://openrouter.ai/api/v1/key", keep: (id) => id.startsWith("anthropic/") }, models: [] } },
  },
];

/** 按 Key 的开头、样子认厂商（有官方依据的放前面；sk-kimi- 是 Kimi Code 示例里的写法，未核实）。 */
const KEY_SHAPES: { re: RegExp; presetId: string; plan: TLocalSourcePlan }[] = [
  { re: /^sk-ant-/, presetId: "anthropic", plan: "api" },
  { re: /^sk-or-/, presetId: "openrouter", plan: "api" },
  { re: /^tkv-/, presetId: "tokenhub", plan: "api" },
  { re: /^sk-sp-/, presetId: "qwen", plan: "coding_plan" },
  { re: /^sk-kimi-/, presetId: "kimi", plan: "coding_plan" },
  { re: /^[0-9a-f]{32}\.[A-Za-z0-9]{16}$/, presetId: "glm", plan: "api" },
  { re: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, presetId: "volcengine", plan: "api" },
];
/** 认不出时可能的几家：sk- 开头的几家都用；JWT 样子的是 MiniMax 的老 Key。 */
const guess = (key: string): string[] => (key.startsWith("sk-") ? ["deepseek", "kimi", "qwen", "minimax"] : key.startsWith("eyJ") ? ["minimax"] : []);

/** 这一版只接 Claude Code：说 Anthropic 格式的才配得上（Codex 接 Key 类来源以后，openai_responses 的配 Codex）。 */
const agentsFor = (formats: TLocalSourceFormat[]): TLocalAgentKind[] => (formats.includes("anthropic") ? ["claude-code"] : []);
const pick = (u: Url, region: TLocalSourceRegion | null) => (typeof u === "string" ? u : u[region ?? "cn"]);
const keyName = (id: string) => `source:${id}`;
export const TOKENHUB_SOURCE_ID = "tokenhub";

type SourceCode = "source_key_rejected" | "source_unreachable" | "source_no_models" | "validation" | "not_found";
export class SourceError extends Error {
  constructor(readonly code: SourceCode, message: string) { super(message); }
}

type Stored = Omit<TLocalSource, "agents">;

/** 用这把 Key 读一次模型列表（不花 token）。Key 只放在请求头里，不进日志、不进错误。 */
async function listModels(spec: PlanSpec, region: TLocalSourceRegion | null, apiKey: string, fetchImpl: typeof fetch): Promise<TLocalSourceModel[]> {
  const list = spec.list!;
  const headers: Record<string, string> = list.auth === "x-api-key" ? { "x-api-key": apiKey, "anthropic-version": "2023-06-01" } : { authorization: `Bearer ${apiKey}` };
  const get = async (url: string): Promise<unknown> => {
    let res: Response;
    try { res = await fetchImpl(url, { headers, signal: AbortSignal.timeout(10_000) }); } catch { throw new SourceError("source_unreachable", "连不上这家的服务"); }
    if (res.status === 401 || res.status === 403) throw new SourceError("source_key_rejected", "Key 不对");
    if (!res.ok) throw new SourceError("source_unreachable", "连不上这家的服务");
    const body = await res.json().catch(() => null);
    if (body === null) throw new SourceError("source_unreachable", "连不上这家的服务");
    return body;
  };
  if (list.keyCheck) await get(pick(list.keyCheck, region));
  const body = (await get(pick(list.url, region))) as { data?: { id?: unknown; display_name?: unknown; name?: unknown }[] };
  if (!Array.isArray(body?.data)) throw new SourceError("source_unreachable", "连不上这家的服务");
  const seen = new Map<string, TLocalSourceModel>();
  for (const m of body.data) {
    const id = typeof m?.id === "string" ? m.id.trim() : "";
    if (!id || id.length > 120 || seen.has(id) || (list.keep && !list.keep(id))) continue;
    // 认得出的 Claude 模型写成「Opus 5.5」（和别处一样），别的用厂商给的显示名
    const nice = modelDisplayName(id);
    const shown = nice !== id.slice(id.lastIndexOf("/") + 1) || typeof m.display_name !== "string" || !m.display_name.trim() ? nice : m.display_name.trim();
    seen.set(id, { id, name: shown.slice(0, 60) });
  }
  // 建议先勾的排前面
  const order = (id: string) => { const i = spec.models.indexOf(id); return i < 0 ? spec.models.length : i; };
  const out = [...seen.values()].sort((a, b) => order(a.id) - order(b.id)).slice(0, 300);
  if (!out.length) throw new SourceError("source_no_models", "这个 Key 列不出能用的模型");
  return out;
}

const tableModels = (spec: PlanSpec): TLocalSourceModel[] => spec.models.map((id) => ({ id, name: modelDisplayName(id) }));

export class Sources {
  private readonly file: string;
  constructor(
    dataDir: string, private readonly secrets: SecretStore, private readonly models: ModelProfiles,
    private readonly tokenHub: TokenHub, private readonly tokenHubUrl: string, private readonly fetchImpl: typeof fetch,
  ) {
    this.file = join(dataDir, "sources.json");
    models.sourceOrigin = (id) => {
      const s = this.stored().find((x) => x.id === id);
      return s ? { provider: s.presetId ?? "custom", label: s.name } : null;
    };
  }

  presets(): TLocalSourcePreset[] {
    return PRESETS.map((p) => ({
      id: p.id, name: p.name, regions: [...p.regions], plans: Object.keys(p.plans) as TLocalSourcePlan[],
      agents: [...new Set(Object.values(p.plans).flatMap((s) => agentsFor(s!.formats)))],
    }));
  }

  private stored(): Stored[] { return readJson<Stored[]>(this.file, []); }

  async list(): Promise<TLocalSource[]> {
    const profiles = await this.models.list();
    // 模型按现在的模型配置列（本人单删了一条，这里跟着少）
    const modelsOf = (id: string) => profiles.filter((p) => p.sourceId === id).map((p) => ({ id: p.model ?? p.id, name: (p.modelName ?? p.label).slice(0, 60) }));
    const out: TLocalSource[] = this.stored().filter((s) => s.id !== TOKENHUB_SOURCE_ID).map((s) => ({ ...s, models: modelsOf(s.id), agents: agentsFor(s.formats) }));
    // TokenHub（第 51 条连的）：有 th- 的模型配置就是连着
    const th = profiles.filter((p) => p.id.startsWith("th-"));
    if (th.length) {
      const meta = this.stored().find((s) => s.id === TOKENHUB_SOURCE_ID);
      const formats = PRESETS.find((p) => p.id === TOKENHUB_SOURCE_ID)!.plans.api!.formats;
      out.unshift({ id: TOKENHUB_SOURCE_ID, presetId: "tokenhub", name: "TokenHub", plan: "api", region: null, baseUrl: th[0]!.baseUrl ?? this.tokenHubUrl, formats, agents: agentsFor(formats),
        models: th.map((p) => ({ id: p.model ?? p.id, name: (p.modelName ?? p.label).slice(0, 60) })), verified: true, addedAt: meta?.addedAt ?? new Date(0).toISOString() });
    }
    return out;
  }

  /** 连上 TokenHub 的那一刻（经 /v1/tokenhub 或这里）：记下时间，来源列表里写。 */
  markTokenHub(): void {
    const rest = this.stored().filter((s) => s.id !== TOKENHUB_SOURCE_ID);
    writeJsonAtomic(this.file, [...rest, { id: TOKENHUB_SOURCE_ID, presetId: "tokenhub", name: "TokenHub", plan: "api", region: null, baseUrl: this.tokenHubUrl, formats: [], models: [], verified: true, addedAt: new Date().toISOString() } satisfies Stored]);
  }

  private resolvePreset(presetId: string, plan?: TLocalSourcePlan, region?: TLocalSourceRegion) {
    const preset = PRESETS.find((p) => p.id === presetId);
    if (!preset) throw new SourceError("validation", "没有这家");
    const chosen = plan ?? (Object.keys(preset.plans)[0] as TLocalSourcePlan);
    const spec = preset.plans[chosen];
    if (!spec) throw new SourceError("validation", `${preset.name} 没有${chosen === "coding_plan" ? "编程套餐" : "按量 API"}`);
    const reg = preset.regions.length ? region ?? "cn" : null;
    return { preset, plan: chosen, spec, region: reg };
  }

  /** 认、验（契约 POST /v1/sources/check），什么都不存。 */
  async check(req: TLocalSourceCheckRequest): Promise<TLocalSourceCheckResponse> {
    if (req.presetId === null) return { recognized: null, candidates: [], models: [], verified: false }; // 自定义：不验
    let presetId = req.presetId;
    let plan = req.plan;
    if (presetId === undefined) {
      const shape = KEY_SHAPES.find((s) => s.re.test(req.apiKey));
      if (!shape) return { recognized: null, candidates: guess(req.apiKey), models: [], verified: false };
      presetId = shape.presetId;
      plan ??= shape.plan;
    }
    const r = this.resolvePreset(presetId, plan, req.region);
    const recognized = { presetId, plan: r.plan, region: r.region };
    if (presetId === TOKENHUB_SOURCE_ID) return { recognized, candidates: [], models: await this.tokenHubModels(req.apiKey), verified: true };
    if (!r.spec.list) return { recognized, candidates: [], models: tableModels(r.spec), verified: false };
    return { recognized, candidates: [], models: await listModels(r.spec, r.region, req.apiKey, this.fetchImpl), verified: true };
  }

  private async tokenHubModels(apiKey: string): Promise<TLocalSourceModel[]> {
    let listed: string[];
    try { listed = await listTokenHubModels(this.tokenHubUrl, apiKey, this.fetchImpl); } catch (e) { throw fromTokenHub(e); }
    const usable = TOKENHUB_MODELS.filter((m) => listed.includes(m));
    if (!usable.length) throw new SourceError("source_no_models", "这个 Key 没有能用的模型");
    return usable.map((id) => ({ id, name: modelDisplayName(id) }));
  }

  /** 加来源（契约 POST /v1/sources）：先验，过了再存 Key、建模型配置。 */
  async add(req: TLocalSourceAddRequest): Promise<{ source: TLocalSource; profiles: TLocalModelProfile[] }> {
    if (req.presetId === TOKENHUB_SOURCE_ID) {
      try { await this.tokenHub.connect(req.apiKey); } catch (e) { throw fromTokenHub(e); }
      this.markTokenHub();
      const source = (await this.list()).find((s) => s.id === TOKENHUB_SOURCE_ID)!;
      return { source, profiles: await this.models.list() };
    }
    const wanted = [...new Set(req.models)];
    let s: Stored;
    if (req.presetId === null) {
      if (!req.name || !req.baseUrl) throw new SourceError("validation", "自定义来源要填名字和地址");
      if ((req.format ?? "anthropic") !== "anthropic") throw new SourceError("validation", "这一版自定义来源只收 Anthropic 格式");
      if (req.baseUrl.startsWith("http:") && !isLoopback(req.baseUrl)) throw new SourceError("validation", "只有本机地址可以用 http，别的要 https");
      const slug = req.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 30) || createHash("sha256").update(req.name).digest("hex").slice(0, 8);
      s = { id: `custom-${slug}`, presetId: null, name: req.name, plan: "api", region: null, baseUrl: req.baseUrl.replace(/\/+$/, ""), formats: ["anthropic"],
        models: wanted.map((id) => ({ id, name: modelDisplayName(id) })), verified: false, addedAt: new Date().toISOString() };
    } else {
      const r = this.resolvePreset(req.presetId, req.plan, req.region);
      const available = r.spec.list ? await listModels(r.spec, r.region, req.apiKey, this.fetchImpl) : tableModels(r.spec);
      const missing = wanted.filter((m) => !available.some((a) => a.id === m));
      if (missing.length) throw new SourceError("validation", `${r.spec.list ? "这把 Key 列不出" : "预设里没有"}：${missing.join("、").slice(0, 200)}`);
      s = { id: `${r.preset.id}-${r.plan}${r.region ? `-${r.region}` : ""}`, presetId: r.preset.id, name: r.spec.name, plan: r.plan, region: r.region,
        baseUrl: pick(r.spec.baseUrl, r.region), formats: [...r.spec.formats], models: available.filter((a) => wanted.includes(a.id)), verified: Boolean(r.spec.list),
        addedAt: new Date().toISOString() };
    }
    // 先存 Key，存不上就什么都不改
    await this.secrets.set(keyName(s.id), req.apiKey);
    const prev = this.stored().find((x) => x.id === s.id);
    if (prev) s.addedAt = prev.addedAt;
    writeJsonAtomic(this.file, [...this.stored().filter((x) => x.id !== s.id), s]);
    await this.models.setSource(s.id, s.baseUrl, s.models, s.presetId === "anthropic");
    return { source: { ...s, agents: agentsFor(s.formats) }, profiles: await this.models.list() };
  }

  /** 删来源（契约 DELETE /v1/sources/:id）：Key 和它的模型配置一起删。没有这个来源返回 false。 */
  async remove(id: string): Promise<boolean> {
    if (id === TOKENHUB_SOURCE_ID) {
      const had = (await this.models.list()).some((p) => p.id.startsWith("th-"));
      await this.tokenHub.disconnect();
      writeJsonAtomic(this.file, this.stored().filter((s) => s.id !== id));
      return had;
    }
    if (!this.stored().some((s) => s.id === id)) return false;
    await this.models.removeSource(id);
    await this.secrets.delete(keyName(id));
    writeJsonAtomic(this.file, this.stored().filter((s) => s.id !== id));
    return true;
  }
}

function fromTokenHub(e: unknown): unknown {
  if (!(e instanceof TokenHubError)) return e;
  const code = e.code === "tokenhub_key_rejected" ? "source_key_rejected" : e.code === "tokenhub_unreachable" ? "source_unreachable" : "source_no_models";
  return new SourceError(code, e.message);
}
