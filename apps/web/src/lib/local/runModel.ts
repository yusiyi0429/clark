/**
 * 模型给人看的叫法（主循环第 67 条）：全站一律「来源 · 模型 · 思考」，如「Claude 订阅 · Opus 5.5 · 高」「TokenHub · Opus 5.5」，都由 modelLine 拼。
 * 来源写给人看的名字（Claude 订阅 / Codex 订阅 / TokenHub / 加进来的来源名），不写「我的」（40 条）；模型写给人看的名字（claude-opus-5-5 →「Opus 5.5」）；
 * 思考是自动、或这个模型没有思考档时不写。子会话以执行方报的实际为准（actual），和请求的不一样时照实际的写，不另加说明。
 */
import type { TLocalAgentKind, TLocalEffort, TLocalModelProfile, TLocalRun, TLocalSessionSummary, TModelEffort } from "@warmap/contracts";

/** 思考程度给人看的字（36 条）：低 / 中 / 高 / 超高 / 最高，Codex 多一档「极限」，项目对话多一档「不思考」；没选（null）写「自动」。 */
export const EFFORT_LABEL: Record<TLocalEffort | TModelEffort, string> = { off: "不思考", low: "低", medium: "中", high: "高", xhigh: "超高", max: "最高", ultra: "极限" };
export const effortText = (effort: TLocalEffort | TModelEffort | null | undefined) => (effort ? EFFORT_LABEL[effort] : "自动");

/** 接入方的 id → 给人看的来源名（Chat 报的 provider、对话模型列表的 source；网宿是 TokenHub 后面的网关，写 TokenHub）；查不到原样写。 */
const PROVIDER_NAMES: Record<string, string> = { tokenhub: "TokenHub", wangsu: "TokenHub" };

const ALIAS = /^(opus|sonnet|haiku|fable)$/;
const FULL = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/**
 * 给人看的模型名，照本机的 modelDisplayName（apps/local/src/models.ts，网页不打包本机源码，照抄一份）：
 * claude-opus-5-5 →「Opus 5.5」、claude-sonnet-4-20250514 →「Sonnet 4」，别名 opus →「Opus」；别的去掉「网关/」前缀原样，如 wangsu/qwen3.8-flash → qwen3.8-flash。
 * 已经是给人看的名字（「Opus 5.5」）原样。
 */
export function modelDisplayName(model: string): string {
  const tail = model.slice(model.lastIndexOf("/") + 1);
  const bare = tail.replace(/\[1m\]$/i, "").toLowerCase();
  const full = FULL.exec(bare);
  if (full) return `${cap(full[1]!)} ${full[2]}${full[3] ? `.${full[3]}` : ""}`;
  const alias = ALIAS.exec(bare);
  if (alias) return cap(alias[1]!);
  return tail.slice(0, 60);
}

/** 来源的叫法不写「我的」（40 条）：本机报的「我的 Claude 订阅」写成「Claude 订阅」。 */
export const plainSource = (text: string) => text.replace(/^我的\s*/, "");

/**
 * 一行里写的来源名：不写「我的」，只取「·」前面那一段（「TokenHub · 网宿」「Codex 订阅 · 经 magpie」→「TokenHub」「Codex 订阅」），
 * 接入方的 id 换成给人看的名字（tokenhub →「TokenHub」）。空的为 null。
 */
export function sourceName(raw: string | null | undefined): string | null {
  const text = plainSource(raw ?? "").split(" · ")[0]!.trim();
  return text ? PROVIDER_NAMES[text.toLowerCase()] ?? text : null;
}

/**
 * 全站唯一的写法（67 条）：「来源 · 模型 · 思考」。model 可以是模型 id（wangsu/claude-opus-5-5）也可以是已经给人看的名字；
 * effort 为 null（自动）或模型没有思考档时不写；模型名和来源名一样的（订阅读不到模型名时）只写一次。都没有为 null。
 */
export function modelLine({ source, model, effort }: { source?: string | null; model?: string | null; effort?: TLocalEffort | TModelEffort | null }): string | null {
  const from = sourceName(source);
  const name = model ? modelDisplayName(model) : null;
  const parts = [from, name && name !== from ? name : null, effort ? EFFORT_LABEL[effort] : null].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/** 走 Chat 的对话（项目主管线、伙伴台）这一轮用的，如 tokenhub + wangsu/claude-opus-5-5 →「TokenHub · Opus 5.5」。 */
export const chatModelLabel = (model: { provider: string; model: string } | null | undefined): string | null =>
  (model ? modelLine({ source: model.provider, model: model.model }) : null);

/** 执行方（harness）给人看的名字（21 条：选模型时要看得出哪个模型配的哪个执行方）。 */
export const HARNESS_NAME: Record<TLocalAgentKind, string> = { "claude-code": "Claude Code", codex: "Codex" };

/**
 * 一个模型配置的模型名（40 条，D 契约 584eb5e9）：本机给了 modelName 就写它（内置的订阅那条是「自动」，模型目录里的是执行方给的显示名）。
 * 老版本本机不带时自己拼：模型目录里的用配置名；照 model 写（claude-opus-5-5 →「Opus 5.5」，网关模型去掉「来源/」前缀）；
 * 订阅没写模型的写「自动」（配置名就是来源名，再写一遍就重复了）；别的没写模型的用配置名。
 */
export const profileModel = (profile: Pick<TLocalModelProfile, "model" | "label" | "catalog"> & { source?: TLocalModelProfile["source"]; modelName?: string }) =>
  profile.modelName ?? (profile.catalog ? profile.label : profile.model ? modelDisplayName(profile.model) : profile.source === "subscription" ? "自动" : profile.label);
/**
 * 选来源那一层列的来源名（40 条）：「Claude 订阅」「Codex 订阅」，不写「我的」；网关的照本机认出的（origin.label，如「TokenHub」「Codex 订阅 · 经 magpie」，
 * 经不经 magpie 要分得开，所以这里不截「·」后面），老版本本机不带时取配置名「·」前面那一段。
 */
export function profileSourceName(profile: Pick<TLocalModelProfile, "source" | "agent" | "label"> & { origin?: TLocalModelProfile["origin"] }): string {
  if (profile.source === "subscription") return profile.agent === "codex" ? "Codex 订阅" : "Claude 订阅";
  return profile.origin?.label ? plainSource(profile.origin.label) : plainSource(profile.label).split(" · ")[0]!.trim() || profile.label;
}
/** 一个模型配置的来源（同 profileSourceName；派活单选模型的菜单）。 */
export const profileSource = profileSourceName;

/**
 * 子会话选中的、实际在跑的：「执行方 · 模型」，如「Claude Code · Opus 5.5」，来源（title）放在悬停里。
 * 执行方照本机报的 harness，老版本不带时用会话的 agent；来源照 origin.label，老版本退回 sourceLabel。都没有时为 null，调用方退回原来的写法。
 */
export function harnessLabel(run: Pick<TLocalRun, "harness" | "origin" | "sourceLabel" | "modelName" | "actual"> | null | undefined, agent?: TLocalAgentKind | null): { label: string; title: string | null } | null {
  const harness = run?.harness ?? agent ?? null;
  const name = run?.actual?.modelName ?? run?.modelName ?? null;
  if (!harness || !name) return null;
  return { label: `${HARNESS_NAME[harness]} · ${name}`, title: plainSource(run?.origin?.label ?? run?.sourceLabel ?? "") || null };
}

/** 换了模型、等这一轮做完才换（32 条，摘要的 pendingModel）时悬停写的。 */
export const PENDING_MODEL_TITLE = "这一轮做完后换";

/** 子会话输入框下面的模型：换了模型要等这一轮做完时写「当前模型 → 新模型」，悬停「这一轮做完后换」；换上了摘要不再带 pendingModel，回到只写新模型。 */
export function withPendingModel(model: { label: string; title: string | null } | null, pending: { modelLabel: string } | null | undefined): { label: string; title: string | null } | null {
  if (!model || !pending) return model;
  return { label: `${model.label} → ${pending.modelLabel}`, title: PENDING_MODEL_TITLE };
}

/** 子会话里实际在跑的来源：origin.label，老版本本机退回 sourceLabel。 */
const runSource = (run: Pick<TLocalRun, "sourceLabel"> & { origin?: TLocalRun["origin"] } | null | undefined) => run?.origin?.label ?? run?.sourceLabel ?? null;

/**
 * 子会话输入框下面的模型（36、40、67 条）：「Claude 订阅 · Opus 5.5 · 高」，默认来源也写出来；思考是自动、模型没有思考档时不写。悬停前面多写执行方。
 * 换了模型要等这一轮做完时是「当前 → 新」（同 withPendingModel）。没有模型名时为 null，调用方退回原来的写法。
 */
export function sessionModelText(session: Pick<TLocalSessionSummary, "run" | "agent" | "effort" | "pendingModel">, efforts: readonly TLocalEffort[] | undefined): { label: string; title: string | null } | null {
  const run = session.run;
  const name = run?.actual?.modelName ?? run?.modelName ?? null;
  if (!name) return null;
  const label = modelLine({ source: runSource(run), model: name, effort: efforts?.length ? session.effort : null })!;
  return withPendingModel({ label, title: `${HARNESS_NAME[run?.harness ?? session.agent]} · ${label}` }, session.pendingModel);
}

/** 订阅类读不到具体模型名时写的（派活单选模型那一处）。 */
const SUBSCRIPTION_NAME: Record<TLocalAgentKind, string> = { "claude-code": "Claude 订阅", codex: "Codex 订阅" };

/**
 * 派活单每一步右边的模型胶囊：「来源 · 模型」（思考在旁边单独一个胶囊），没单独选时前面加「自动 · 」；订阅读不到具体模型名时只写来源。
 * 悬停前面多写执行方，如「自动 · Claude Code · Claude 订阅 · Opus 5.5」。
 */
export function pickLabel(pick: { harness: TLocalAgentKind; model: string | null; source: string | null; subscription: boolean }, auto: boolean): { label: string; title: string } {
  const line = modelLine({ source: pick.source ?? (pick.subscription ? SUBSCRIPTION_NAME[pick.harness] : null), model: pick.model }) ?? HARNESS_NAME[pick.harness];
  const prefix = auto ? "自动 · " : "";
  return { label: `${prefix}${line}`, title: `${prefix}${[HARNESS_NAME[pick.harness], line].filter((part, index, all) => all.indexOf(part) === index).join(" · ")}` };
}

/** 子会话的「来源 · 模型 · 思考」（左栏名字的悬停、页头退回时）：实际跑的优先；只有来源时只写来源；老版本本机不报来源时为 null。 */
export function runLabel(run: Pick<TLocalRun, "sourceLabel" | "modelName" | "actual"> & Partial<Pick<TLocalRun, "origin" | "effort">> | null | undefined): string | null {
  const source = runSource(run);
  if (!source) return null;
  return modelLine({ source, model: run?.actual?.modelName ?? run?.modelName, effort: run?.effort });
}
