/**
 * 子会话用的是哪个来源的哪个模型（契约 LocalRun）：写成「来源 · 模型」，如「我的 Claude 订阅 · Opus 5.5」「TokenHub · qwen3.8-flash」。
 * 实际跑起来的（actual，执行方报的）优先；和请求的不一样时照实际的写，不另加说明。老版本本机不报来源时为 null，由调用方退回原来的写法。
 */
import type { TLocalRun } from "@warmap/contracts";

export function runLabel(run: Pick<TLocalRun, "sourceLabel" | "modelName" | "actual"> | null | undefined): string | null {
  if (!run?.sourceLabel) return null;
  const name = run.actual?.modelName ?? run.modelName;
  return name ? `${run.sourceLabel} · ${name}` : run.sourceLabel;
}
