/**
 * 子会话用的是哪个来源的哪个模型（契约 LocalRun）：写成「来源 · 模型」，如「我的 Claude 订阅 · Opus 5.5」「TokenHub · qwen3.8-flash」。
 * 实际跑起来的（actual，执行方报的）优先；和请求的不一样时照实际的写，不另加说明。老版本本机不报来源时为 null，由调用方退回原来的写法。
 */
import type { TLocalAgentKind, TLocalModelProfile, TLocalRun } from "@warmap/contracts";

/** Chat 报的接入方 → 给人看的来源名（同子会话 sourceLabel 的叫法）；查不到原样写。 */
const PROVIDER_NAMES: Record<string, string> = { tokenhub: "TokenHub" };

const ALIAS = /^(opus|sonnet|haiku|fable)$/;
const FULL = /^claude-(opus|sonnet|haiku|fable)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/;
const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

/**
 * 给人看的模型名，照本机的 modelDisplayName（apps/local/src/models.ts，网页不打包本机源码，照抄一份）：
 * claude-opus-5-5 →「Opus 5.5」、claude-sonnet-4-20250514 →「Sonnet 4」，别名 opus →「Opus」；别的去掉「网关/」前缀原样，如 wangsu/qwen3.8-flash → qwen3.8-flash。
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

/** 走 Chat 的对话（项目主管线、伙伴台）这一轮用的：「来源 · 模型」，写法同子会话，如 tokenhub + wangsu/claude-opus-5-5 →「TokenHub · Opus 5.5」。 */
export const chatModelLabel = (model: { provider: string; model: string } | null | undefined): string | null =>
  (model ? `${PROVIDER_NAMES[model.provider.toLowerCase()] ?? model.provider} · ${modelDisplayName(model.model)}` : null);

/** 执行方（harness）给人看的名字（21 条：选模型时要看得出哪个模型配的哪个执行方）。 */
export const HARNESS_NAME: Record<TLocalAgentKind, string> = { "claude-code": "Claude Code", codex: "Codex" };

/** 一个模型配置的模型名：照本机的写法（claude-opus-5-5 →「Opus 5.5」，网关模型去掉「来源/」前缀）；没写模型的（订阅默认）用配置名。 */
export const profileModel = (profile: Pick<TLocalModelProfile, "model" | "label">) => (profile.model ? modelDisplayName(profile.model) : profile.label);
/** 一个模型配置的来源：本机认出的（D 契约 12541f55 的 origin.label，如「Codex 订阅 · 经 magpie」）；老版本本机不带时，订阅写「我的 Claude 订阅」，别的写配置名。 */
export const profileSource = (profile: Pick<TLocalModelProfile, "origin" | "source" | "label">) =>
  profile.origin?.label ?? (profile.source === "subscription" ? "我的 Claude 订阅" : profile.label);

/**
 * 子会话选中的、实际在跑的：「执行方 · 模型」，如「Claude Code · Opus 5.5」，来源（title）放在悬停里。
 * 执行方照本机报的 harness，老版本不带时用会话的 agent；来源照 origin.label，老版本退回 sourceLabel。都没有时为 null，调用方退回原来的写法。
 */
export function harnessLabel(run: Pick<TLocalRun, "harness" | "origin" | "sourceLabel" | "modelName" | "actual"> | null | undefined, agent?: TLocalAgentKind | null): { label: string; title: string | null } | null {
  const harness = run?.harness ?? agent ?? null;
  const name = run?.actual?.modelName ?? run?.modelName ?? null;
  if (!harness || !name) return null;
  return { label: `${HARNESS_NAME[harness]} · ${name}`, title: run?.origin?.label ?? run?.sourceLabel ?? null };
}

/** 订阅类读不到具体模型名时写的（派活单选模型那一处）。 */
const SUBSCRIPTION_NAME: Record<TLocalAgentKind, string> = { "claude-code": "Claude 订阅", codex: "Codex 订阅" };

/**
 * 派活单每一步右边的模型胶囊（17.2 第 21 条之后，用户定 A+B）：只写模型，如「Opus 5.5」；自动时「自动 · Opus 5.5」；
 * 订阅类读不到具体模型名时写「Claude 订阅」。执行方和来源放到悬停的全称里，如「自动 · Claude Code · Opus 5.5 · 我的 Claude 订阅」。
 */
export function pickLabel(pick: { harness: TLocalAgentKind; model: string | null; source: string | null; subscription: boolean }, auto: boolean): { label: string; title: string } {
  const name = pick.model ?? (pick.subscription ? SUBSCRIPTION_NAME[pick.harness] : pick.source ?? HARNESS_NAME[pick.harness]);
  const prefix = auto ? "自动 · " : "";
  const full = [HARNESS_NAME[pick.harness], pick.model, pick.source].filter((part, index, all): part is string => !!part && all.indexOf(part) === index);
  return { label: `${prefix}${name}`, title: `${prefix}${full.join(" · ")}` };
}

export function runLabel(run: Pick<TLocalRun, "sourceLabel" | "modelName" | "actual"> | null | undefined): string | null {
  if (!run?.sourceLabel) return null;
  const name = run.actual?.modelName ?? run.modelName;
  return name ? `${run.sourceLabel} · ${name}` : run.sourceLabel;
}
