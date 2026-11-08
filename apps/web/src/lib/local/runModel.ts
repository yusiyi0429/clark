/**
 * 子会话用的是哪个来源的哪个模型（契约 LocalRun）：写成「来源 · 模型」，如「我的 Claude 订阅 · Opus 5.5」「TokenHub · qwen3.8-flash」。
 * 实际跑起来的（actual，执行方报的）优先；和请求的不一样时照实际的写，不另加说明。老版本本机不报来源时为 null，由调用方退回原来的写法。
 */
import type { TLocalRun } from "@warmap/contracts";

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

export function runLabel(run: Pick<TLocalRun, "sourceLabel" | "modelName" | "actual"> | null | undefined): string | null {
  if (!run?.sourceLabel) return null;
  const name = run.actual?.modelName ?? run.modelName;
  return name ? `${run.sourceLabel} · ${name}` : run.sourceLabel;
}
