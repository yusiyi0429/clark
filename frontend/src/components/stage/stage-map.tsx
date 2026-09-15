"use client";

import { api } from "@/lib/data/client";
import type { MissionCard } from "@/lib/data/types";
import { useResource } from "@/lib/use-resource";
import { cn } from "@/lib/utils";

/**
 * 目标与产出那棵树，立在投影上。
 *
 * 两级：公司总 Outcome → 八个业务域 → 每个域下面的 Mission。这是这场会里唯一一张
 * 「全貌」—— 前面每一件事都在说「它影响哪条战略」，说到第三遍的时候客户会想看那张全图，
 * 而那一刻树必须已经在手上，不是现画。
 *
 * 数据走 `api.getOutcomes()`，和手动模式的「目标与产出」同一个来源 —— 这是双模式同源在
 * 这张卡上的落点。规格里说静态 JSON 也可接受，但同源比省事重要：投影上那棵树和他明天
 * 在桌面上翻的那棵树如果不一样，这套东西就不可信了。
 *
 * 四种状态色，四个意思，全都是已有的 token：
 *
 *   已确认  `confirmed`  —— Mission 已确认
 *   进行中  `factual`    —— Mission 在跑
 *   待定    `ink-faint`  —— Mission 还没定
 *   有判断在动摇 `counter` —— 域一级的警报，压过它底下所有 Mission
 */

const MISSION_TONE: Record<MissionCard["status"], { dot: string; label: string }> = {
  confirmed: { dot: "bg-confirmed", label: "已确认" },
  running: { dot: "bg-factual", label: "进行中" },
  pending: { dot: "bg-ink-faint", label: "待定" },
};

export function StageMap({ view }: { view?: string }) {
  const resource = useResource("outcomes", () => api.getOutcomes());
  const screen = resource.data;

  if (!screen) {
    return (
      <div className="mx-auto w-full max-w-[92ch] space-y-6" aria-live="polite">
        <span className="skeleton block h-8 w-[70%]" />
        <div className="grid grid-cols-4 gap-4">
          {Array.from({ length: 8 }, (_, i) => (
            <span key={i} className="skeleton block h-24" />
          ))}
        </div>
      </div>
    );
  }

  /*
   * `view` 是模型给的一个域编号或者域名。给了就只画那一个域，没给就画整棵树。
   *
   * 会上他说「只看产品域」的时候，八个域缩成一个 —— 一屋子人的注意力跟着屏幕走，而不是
   * 跟着他手指指的位置走。
   */
  const focus = view?.trim();
  const domains = focus
    ? screen.domains.filter((d) => d.code === focus || d.name.includes(focus))
    : screen.domains;
  const shown = domains.length > 0 ? domains : screen.domains;

  return (
    <div className="animate-fade mx-auto flex w-full max-w-[92ch] flex-col gap-9">
      <header className="flex flex-col gap-3">
        <p className="meta-stage text-ink-faint">
          {screen.period.label} · 还有 {screen.daysLeft} 天
        </p>
        {/* 总 Outcome 原文照录，serif —— 这是公司自己写下的那句话，不是产品在说话。 */}
        <h2 className="report text-stage-lead text-ink">{screen.company.statement}</h2>
      </header>

      <ul
        className={cn(
          "grid gap-x-8 gap-y-9",
          shown.length > 2 ? "grid-cols-2" : "grid-cols-1",
        )}
      >
        {shown.map((domain) => (
          <li key={domain.code} className="flex flex-col gap-3">
            <div className="flex items-baseline gap-3 border-b border-hairline pb-2">
              <span className="meta-stage shrink-0 text-ink-faint">{domain.code}</span>
              <span className="text-stage font-medium text-ink">{domain.name}</span>
              {domain.shaking && (
                <span className="meta-stage ml-auto shrink-0 text-counter">
                  判断在动摇
                </span>
              )}
            </div>
            <p className="text-stage-meta text-ink-muted">{domain.outcome}</p>
            {domain.missions.length > 0 && (
              <ul className="flex flex-col gap-2 pl-1">
                {domain.missions.map((m) => (
                  <li key={m.id} className="flex items-baseline gap-3">
                    <span
                      className={cn("mt-[0.6em] size-2.5 shrink-0 rounded-full", MISSION_TONE[m.status].dot)}
                      aria-hidden
                    />
                    <span className="text-stage-meta text-ink">{m.name}</span>
                    <span className="meta-stage ml-auto shrink-0 text-ink-faint">
                      {MISSION_TONE[m.status].label}
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
