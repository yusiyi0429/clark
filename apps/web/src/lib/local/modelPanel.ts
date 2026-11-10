/**
 * 选模型的三行（设计 17.2 第 40 条）：来源、模型、思考。这里只算每一行现在的值和能选的项，界面在 components/home/ModelPanel。
 * 来源按本机的模型配置归组：「Claude 订阅」「Codex 订阅」，网关的照本机认出的名字（如「TokenHub」）；不写「我的」。
 * 联动：换来源，模型落到那个来源的默认；换模型，原来的思考档它支持就留着，不支持回到自动（同 36 条，本机也这样算）。
 */
import type { TLocalAgentKind, TLocalAgentStatus, TLocalEffort, TLocalModelProfile } from "@warmap/contracts";
import type { UsageCell } from "@/lib/home/quota";
import { effortText, profileModel, profileSourceName } from "./runModel";

export type PanelOption = { id: string; label: string; /** 右边淡色的一小段：剩余用量，或置灰的原因（状态词）。 */ note?: string | null; disabled?: boolean };
export type PanelRowKey = "source" | "model" | "effort";
export type PanelRow = { key: PanelRowKey; name: string; /** 这一行现在选的，写在右边。 */ value: string; selected: string; options: PanelOption[] };

export const ROW_NAME: Record<PanelRowKey, string> = { source: "来源", model: "模型", effort: "思考" };
/** 思考那一行「自动」的键。 */
export const AUTO_EFFORT = "auto";
/** 这一行点不点得开：只列得出一项的不给「›」、不能点。 */
export const rowOpens = (row: Pick<PanelRow, "options">) => row.options.length > 1;

const SUBSCRIPTION_SOURCE: Record<TLocalAgentKind, string> = { "claude-code": "claude", codex: "codex" };
const SOURCE_AGENT: Record<string, TLocalAgentKind> = { claude: "claude-code", codex: "codex" };

/** 一个模型配置属于哪个来源：订阅按执行方（claude、codex，也是右栏用量那一格的 id），网关按名字。 */
export function sourceIdOf(profile: Pick<TLocalModelProfile, "source" | "agent" | "origin" | "label">): string {
  return profile.source === "subscription" ? SUBSCRIPTION_SOURCE[profile.agent] : `gateway:${profileSourceName(profile)}`;
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
  /** 只许这几个执行方的来源（开着的子会话在双向换合进来之前只许自己的；规划员、验收员只许 Claude Code）；别的置灰。不给都能选。 */
  agentsAllowed?: readonly TLocalAgentKind[];
};

/**
 * 三行：来源、模型、思考。没有模型配置时为空（不画）。
 * 来源那一页也列没登录、没装的订阅（置灰，后面写状态词），哪怕它现在一个模型都没有。
 */
export function localPanelRows({ models, modelId, effort, cells = [], agents = [], now = Date.now(), agentsAllowed }: LocalPanelInput): PanelRow[] {
  const current = models.find((model) => model.id === modelId) ?? null;
  if (!current) return [];
  const sourceId = sourceIdOf(current);
  const seen = new Map<string, { label: string; agent: TLocalAgentKind }>();
  for (const model of models) if (!seen.has(sourceIdOf(model))) seen.set(sourceIdOf(model), { label: profileSourceName(model), agent: model.agent });
  for (const agent of agents) {
    const id = SUBSCRIPTION_SOURCE[agent.kind];
    if (!seen.has(id) && agentBlock(agent, now)) seen.set(id, { label: profileSourceName({ source: "subscription", agent: agent.kind, label: "" }), agent: agent.kind });
  }
  const sources: PanelOption[] = [...seen].map(([id, source]) => {
    const subscription = id in SOURCE_AGENT;
    const blocked = subscription ? agentBlock(agents.find((agent) => agent.kind === SOURCE_AGENT[id]), now) : null;
    const locked = !!agentsAllowed && !agentsAllowed.includes(source.agent);
    const cell = cells.find((entry) => (subscription ? entry.id === id : entry.name === source.label));
    return { id, label: source.label, note: blocked ?? cell?.value ?? null, disabled: (!!blocked || locked) && id !== sourceId };
  });
  const own = models.filter((model) => sourceIdOf(model) === sourceId);
  const efforts = current.efforts ?? [];
  const level = keptEffort(current, effort);
  return [
    { key: "source", name: ROW_NAME.source, value: profileSourceName(current), selected: sourceId, options: sources },
    { key: "model", name: ROW_NAME.model, value: profileModel(current), selected: current.id, options: own.map((model) => ({ id: model.id, label: profileModel(model) })) },
    { key: "effort", name: ROW_NAME.effort, value: effortText(level), selected: level ?? AUTO_EFFORT,
      options: [{ id: AUTO_EFFORT, label: effortText(null) }, ...efforts.map((entry) => ({ id: entry, label: effortText(entry) }))] },
  ];
}

/** 在某一行选了一项以后的模型和思考档（联动见文件头）；选不出（那个来源没有模型）为 null。 */
export function pickLocal(models: readonly TLocalModelProfile[], current: { modelId: string | null; effort: TLocalEffort | null }, key: PanelRowKey, id: string): { modelId: string; effort: TLocalEffort | null } | null {
  if (key === "effort") return current.modelId ? { modelId: current.modelId, effort: id === AUTO_EFFORT ? null : id as TLocalEffort } : null;
  const model = key === "source" ? defaultModelOf(models, id) : models.find((entry) => entry.id === id) ?? null;
  return model ? { modelId: model.id, effort: keptEffort(model, current.effort) } : null;
}

/** 胶囊上写的：「模型名 · 思考档」；思考是自动时只写模型名。订阅没写模型的（默认那个）读不到模型名，写来源名（同派活单的写法）。 */
export function panelLabel(model: Pick<TLocalModelProfile, "model" | "label" | "catalog" | "source" | "agent" | "efforts">, effort: TLocalEffort | null): string {
  const name = !model.catalog && !model.model && model.source === "subscription" ? profileSourceName(model) : profileModel(model);
  const level = keptEffort(model, effort);
  return level ? `${name} · ${effortText(level)}` : name;
}
