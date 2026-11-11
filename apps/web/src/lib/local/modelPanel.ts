/**
 * 选模型的四行（设计 17.2 第 40、52 条）：执行方、来源、模型、思考。这里只算每一行现在的值和能选的项，界面在 components/home/ModelPanel。
 * 执行方放最前：先选谁干活，来源只有它能用的可选，配不上的灰掉；换执行方时来源能接着用就不动，不能用换成这个执行方能用的第一个。
 * 来源那一层最底下「+ 添加来源」（本机有添加来源的接口时，canAddSource），选了由 ModelPanel 开小弹窗。
 * 来源按本机认出的归组（origin.provider，经不经 magpie 分开算）：「Claude 订阅」「Codex 订阅」，网关的照本机认出的名字（如「TokenHub」）；不写「我的」。
 * 模型那一行在这个来源的几条配置里选，写本机给的 modelName（内置的订阅那条是「自动」，排最上面）；模型目录里不能选思考的（efforts 为空）思考那一行点不开。
 * 联动：换来源，模型落到那个来源的默认；换模型，原来的思考档它支持就留着，不支持回到自动（同 36 条，本机也这样算）。
 */
import type { TLocalAgentKind, TLocalAgentStatus, TLocalEffort, TLocalModelProfile } from "@warmap/contracts";
import type { UsageCell } from "@/lib/home/quota";
import { HARNESS_NAME, effortText, modelLine, profileModel, profileSourceName } from "./runModel";

export type PanelOption = { id: string; label: string; /** 右边淡色的一小段：剩余用量，或置灰的原因（状态词）。 */ note?: string | null; disabled?: boolean };
export type PanelRowKey = "agent" | "source" | "model" | "effort";
export type PanelRow = { key: PanelRowKey; name: string; /** 这一行现在选的，写在右边。 */ value: string; selected: string; options: PanelOption[] };

export const ROW_NAME: Record<PanelRowKey, string> = { agent: "执行方", source: "来源", model: "模型", effort: "思考" };
/** 来源那一层最底下那一项的键：选了开「添加来源」小弹窗（ModelPanel 接住，不交给调用方）。 */
export const ADD_SOURCE = "+add-source";
/** 思考那一行「自动」的键。 */
export const AUTO_EFFORT = "auto";
/** 这一行点不点得开：只列得出一项的不给「›」、不能点。 */
export const rowOpens = (row: Pick<PanelRow, "options">) => row.options.length > 1;

/** 两家订阅：来源的 id（同本机 origin.provider 的写法），和右栏用量那一格的 id。 */
const SUBSCRIPTION: Record<TLocalAgentKind, { source: string; quota: string }> = {
  "claude-code": { source: "claude-subscription", quota: "claude" },
  codex: { source: "codex", quota: "codex" },
};

/**
 * 一个模型配置属于哪个来源：添加来源建的（带 sourceId，第 52 条）按来源；订阅按执行方；网关按本机认出的 provider（经 magpie 的另算一个），
 * 老版本本机不带 origin 时按名字。本机的 ModelProfiles.forTier 用同一套分法。
 */
export function sourceIdOf(profile: Pick<TLocalModelProfile, "source" | "agent" | "origin" | "label"> & { sourceId?: string }): string {
  if (profile.sourceId) return `source:${profile.sourceId}`;
  if (profile.source === "subscription") return SUBSCRIPTION[profile.agent].source;
  return profile.origin ? `${profile.origin.provider}${profile.origin.via ? `:${profile.origin.via}` : ""}` : `gateway:${profileSourceName(profile)}`;
}

/** 这个来源的默认模型：标了默认的那个，没有就第一个。 */
export function defaultModelOf(models: readonly TLocalModelProfile[], sourceId: string): TLocalModelProfile | null {
  const own = models.filter((model) => sourceIdOf(model) === sourceId);
  return own.find((model) => model.isDefault) ?? own[0] ?? null;
}

/** 换了模型以后的思考档：原来的它支持就留着，不然自动（null）。 */
export const keptEffort = (model: Pick<TLocalModelProfile, "efforts"> | null | undefined, effort: TLocalEffort | null): TLocalEffort | null =>
  (effort && model?.efforts?.includes(effort) ? effort : null);

/** 执行方没装、没登录、登录过期时写的词（和右栏「这台电脑」同一套，BackgroundPanel 的 TOOL_STATE）；能用为 null。 */
export function agentBlock(agent: Pick<TLocalAgentStatus, "installed" | "loggedIn" | "loginExpiresAt"> | undefined, now: number): string | null {
  if (!agent) return null;
  if (!agent.installed) return "没装";
  if (!agent.loggedIn) return "没登录";
  if (agent.loginExpiresAt && Date.parse(agent.loginExpiresAt) <= now) return "登录过期";
  return null;
}

export type LocalPanelInput = {
  models: readonly TLocalModelProfile[];
  /** 现在选的模型配置和思考档（自动为 null）。 */
  modelId: string | null;
  effort: TLocalEffort | null;
  /** 右栏用量那一套数（usageCells）和执行方状态；没有就不写右边那一小段。 */
  cells?: readonly UsageCell[];
  agents?: readonly TLocalAgentStatus[];
  now?: number;
  /** 只许这几个执行方的来源（规划员、验收员只许 Claude Code）；别的置灰。不给都能选。 */
  agentsAllowed?: readonly TLocalAgentKind[];
  /** 本机有添加来源的接口：来源那一层最底下出「+ 添加来源」。 */
  canAddSource?: boolean;
};

/**
 * 四行：执行方、来源、模型、思考。没有模型配置时为空（不画）。
 * 来源那一页也列没登录、没装的订阅（置灰，后面写状态词），哪怕它现在一个模型都没有；别的执行方的来源也列，置灰。
 */
export function localPanelRows({ models, modelId, effort, cells = [], agents = [], now = Date.now(), agentsAllowed, canAddSource = false }: LocalPanelInput): PanelRow[] {
  const current = models.find((model) => model.id === modelId) ?? null;
  if (!current) return [];
  const sourceId = sourceIdOf(current);
  const seen = new Map<string, { label: string; agent: TLocalAgentKind; subscription: boolean }>();
  for (const model of models) {
    const id = sourceIdOf(model);
    if (!seen.has(id)) seen.set(id, { label: profileSourceName(model), agent: model.agent, subscription: model.source === "subscription" });
  }
  for (const agent of agents) {
    const id = SUBSCRIPTION[agent.kind].source;
    if (!seen.has(id) && agentBlock(agent, now)) seen.set(id, { label: profileSourceName({ source: "subscription", agent: agent.kind, label: "" }), agent: agent.kind, subscription: true });
  }
  const sources: PanelOption[] = [...seen].map(([id, source]) => {
    const blocked = source.subscription ? agentBlock(agents.find((agent) => agent.kind === source.agent), now) : null;
    // 配不上现在这个执行方的来源灰掉（先在执行方那一行换）。
    const other = source.agent !== current.agent;
    const cell = cells.find((entry) => (source.subscription ? entry.id === SUBSCRIPTION[source.agent].quota : entry.name === source.label));
    return { id, label: source.label, note: blocked ?? cell?.value ?? null, disabled: (!!blocked || other) && id !== sourceId };
  });
  // 执行方：模型配置里有的，加上没装、没登录的（置灰写状态词）；规划员、验收员只许 Claude Code。
  const harnesses = [...new Set<TLocalAgentKind>([...models.map((model) => model.agent), ...agents.map((agent) => agent.kind)])];
  const agentOptions: PanelOption[] = harnesses.map((kind) => {
    const blocked = models.some((model) => model.agent === kind) ? null : agentBlock(agents.find((agent) => agent.kind === kind), now) ?? "没装";
    const locked = !!agentsAllowed && !agentsAllowed.includes(kind);
    return { id: kind, label: HARNESS_NAME[kind], note: blocked, disabled: (!!blocked || locked) && kind !== current.agent };
  });
  const own = models.filter((model) => sourceIdOf(model) === sourceId);
  const efforts = current.efforts ?? [];
  const level = keptEffort(current, effort);
  return [
    { key: "agent", name: ROW_NAME.agent, value: HARNESS_NAME[current.agent], selected: current.agent, options: agentOptions },
    { key: "source", name: ROW_NAME.source, value: profileSourceName(current), selected: sourceId, options: canAddSource ? [...sources, { id: ADD_SOURCE, label: "+ 添加来源" }] : sources },
    { key: "model", name: ROW_NAME.model, value: profileModel(current), selected: current.id, options: own.map((model) => ({ id: model.id, label: profileModel(model) })) },
    { key: "effort", name: ROW_NAME.effort, value: effortText(level), selected: level ?? AUTO_EFFORT,
      options: [{ id: AUTO_EFFORT, label: effortText(null) }, ...efforts.map((entry) => ({ id: entry, label: effortText(entry) }))] },
  ];
}

/** 在某一行选了一项以后的模型和思考档（联动见文件头）；选不出（那个来源没有模型）为 null。 */
export function pickLocal(models: readonly TLocalModelProfile[], current: { modelId: string | null; effort: TLocalEffort | null }, key: PanelRowKey, id: string): { modelId: string; effort: TLocalEffort | null } | null {
  if (key === "effort") return current.modelId ? { modelId: current.modelId, effort: id === AUTO_EFFORT ? null : id as TLocalEffort } : null;
  if (id === ADD_SOURCE) return null;
  if (key === "agent") {
    // 换执行方：现在这个来源它也能用就留在这个来源（落到默认模型），不能用换成它能用的第一个来源。
    const now = models.find((model) => model.id === current.modelId);
    const own = models.filter((model) => model.agent === id);
    const same = now ? own.filter((model) => sourceIdOf(model) === sourceIdOf(now)) : [];
    if (!own.length) return null;
    const pool = same.length ? same : own.filter((model) => sourceIdOf(model) === sourceIdOf(own[0]!));
    const model = pool.find((entry) => entry.isDefault) ?? pool[0]!;
    return { modelId: model.id, effort: keptEffort(model, current.effort) };
  }
  const model = key === "source" ? defaultModelOf(models, id) : models.find((entry) => entry.id === id) ?? null;
  return model ? { modelId: model.id, effort: keptEffort(model, current.effort) } : null;
}

/**
 * 胶囊上写的（67 条）：「来源 · 模型 · 思考」，同 modelLine；思考是自动时不写。订阅没写模型的（内置那条，模型由本机按档位挑）只写来源名（同派活单的写法）。
 */
export function panelLabel(model: Pick<TLocalModelProfile, "model" | "label" | "catalog" | "source" | "agent" | "efforts" | "modelName" | "origin">, effort: TLocalEffort | null): string {
  const bare = !model.catalog && !model.model && model.source === "subscription";
  return modelLine({ source: profileSourceName(model), model: bare ? null : profileModel(model), effort: keptEffort(model, effort) }) ?? profileModel(model);
}
