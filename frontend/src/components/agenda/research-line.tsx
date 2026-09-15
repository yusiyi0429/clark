"use client";

import { Check } from "lucide-react";
import { useId } from "react";

import { ResearchStepLine } from "@/components/research-step-line";
import type { IssueSummary } from "@/lib/data/types";
import { formatDuration } from "@/lib/format";
import { cn } from "@/lib/utils";

/**
 * 「这一份研究查到哪了」——**议题栏里那一行会动的小字，以及它旁边那个环。**
 *
 * 从 `home-view.tsx` 搬出来的（2026-08-30 首页改版）。搬的理由不是文件太长：这一段是
 * 议题栏自己的东西，而议题栏已经是一个独立的组件了。留在页面文件里，改议题栏的人就得
 * 先读一遍整页。
 *
 * 三样一起搬，因为它们是同一件事的三个部分：一行状态（`ResearchStatusLine`）、有预估
 * 时才出现的那个环（`ProgressRing`）、以及人那一份的一行（`HandoffStatusLine`）。
 */

/** 一颗轻呼吸的点。「还在跑」那一档用它。 */
export function BreathingDot({ className }: { className: string }) {
  return (
    <span aria-hidden className="relative flex size-1.5 shrink-0">
      <span
        className={cn(
          "absolute inline-flex h-full w-full animate-ping rounded-full opacity-60",
          className,
        )}
      />
      <span className={cn("relative inline-flex size-1.5 rounded-full", className)} />
    </span>
  );
}

/**
 * 机器那份。有预估就给进度环和倒计时；没有预估就报**步骤** —— 不编百分比。
 *
 * 两套东西并存，而且分工是清楚的：
 *
 * - 进度环 + 「约还需 N」只有种子那一档给得出（`issueJobs` 里有预估），那是编排好的
 *   演示数据，百分比是真的有出处的。
 * - 真跑的那一档没有百分比（模型不回传进度），只有「走到第几步、已经跑了多久」。
 *   它不折成百分比去喂那个环 —— 理由写在 `IssueResearchStatus` 上：第 3 步可能占掉
 *   整轮七成时间，填成 75% 就是在说「快好了」。
 */
export function ResearchStatusLine({
  research,
}: {
  research: IssueSummary["research"];
}) {
  if (research.state === "done") {
    return (
      <p className="meta flex items-center gap-1.5 text-confirmed">
        <Check className="size-3 shrink-0" aria-hidden />
        深度研究 · 已完成
      </p>
    );
  }

  if (research.state === "idle") {
    return (
      <p className="meta flex items-center gap-1.5 text-ink-faint">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-hairline-strong" />
        深度研究 · 未开始
      </p>
    );
  }

  /*
   * 排着队的那一档。**点不呼吸**：呼吸的点在这一屏上说的是「此刻有东西在动」，而这一轮
   * 一次调用都还没发 —— 前面那一轮的点在自己那一行上呼吸着，这里再跳一个是两件事说成一件。
   */
  if (research.state === "queued") {
    return (
      <p className="meta flex items-center gap-1.5 text-ink-faint">
        <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-hairline-strong" />
        <ResearchStepLine
          className="min-w-0"
          queuePosition={research.queuePosition}
          fallback="排队中"
        />
      </p>
    );
  }

  const pct = research.progress === undefined ? null : Math.round(research.progress * 100);

  if (pct !== null) {
    /*
     * 有预估的那一档：环 + 一行字，横着排在一起。
     *
     * 环本身就是那个百分比的图形，所以前面不再挂状态点 —— 两个都在说「在跑」。
     * 这一格从右边那条窄栏搬到标题底下之后有整行宽度，环和字不用再上下摞。
     */
    return (
      <div className="flex items-center gap-2.5">
        <ProgressRing pct={pct} />
        <span className="meta tabular-nums text-ink-faint">
          深度研究 · 进行中 {pct}% · 约还需 {formatDuration(research.remainingSeconds ?? 0)}
        </span>
      </div>
    );
  }

  /*
   * 真跑的那一档。
   *
   * 步骤上报上来了（或者至少知道这一轮什么时候起的）就**只写那一步**：
   * `● 正在分层成稿 · 按出口校验返修 9 块 · 第 6/7 步 · 已 29 分 09 秒`。
   * 前面不再挂「深度研究 · 进行中」—— 一颗跳着的点加一行正在走的步骤，说的就是
   * 「深度研究在跑」，那五个字再写一遍是同一句话说两遍，而它占掉的是标题底下第一眼
   * 的那一行。
   *
   * 两样都没有（刚开任务、进程重启之后接管的那一轮）才退回那句「进行中」：那时候此刻
   * 知道的全部就是这一句，编一个「第 1 步」出来是个会被当真的假事实。
   */
  const stepped = research.step !== undefined || research.startedAt !== undefined;

  return (
    <p className={cn("meta flex gap-1.5 text-factual", stepped ? "items-start" : "items-center")}>
      <span
        aria-hidden
        className={cn("relative flex size-1.5 shrink-0", stepped && "mt-[5px]")}
      >
        <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-factual opacity-60" />
        <span className="relative inline-flex size-1.5 rounded-full bg-factual" />
      </span>
      {stepped ? (
        <ResearchStepLine
          className="min-w-0 leading-relaxed"
          step={research.step}
          startedAt={research.startedAt}
          fallback="正在跑"
        />
      ) : (
        "深度研究 · 进行中"
      )}
    </p>
  );
}

/**
 * 深研进度环 —— **整屏唯一一处真正的内部深度**。
 *
 * ## 为什么是环，不是那条进度条
 *
 * 上一版是一条 4px 高的胶囊条。它没有错，只是它什么也没说：一条平的色块，
 * 除了「有个百分比」之外不携带任何别的信息，而百分比旁边已经写着数字了。
 *
 * 这一处是这个产品里**唯一**一个「一个连续量、要被一瞥、而且真的在动」的东西。
 * 精致感需要一个落点 —— 屏幕上到处都精致等于哪儿都不精致。所以整套光影结构
 * 全部收敛到这一个 22px 的环上，别处一处都不给。
 *
 * ## 抄的是 Apple 体能训练圆环，而且抄的是它最关键的那一点
 *
 * 那三个环是 Apple 全套 widget 里**唯一**带阴影的东西（时钟指针没有、天气没有、
 * 卡片本身也没有）。而它成立的原因不是「它有阴影」，是**那个阴影被裁在环带里**：
 *
 *   偏移  w/10，切向 —— 跟着端点转，永远指向前进方向
 *   模糊  w/3
 *   裁剪  裁到描边路径本身  ← 省掉这一步，它立刻变成一个廉价的浮层
 *
 * 裁剪之后，阴影只可能落在环自己身上，落不到卡片上。于是它读起来是
 * 「这一圈绕回来盖住了自己的起点」—— 一个物体和它自己的空间关系，
 * 而不是「有个东西浮在界面上面」。这就是你说的那种「内容自己的立体」。
 *
 * ## MKRingProgressLayer 那组比例不能照抄到 22px
 *
 * 原始那组参数（偏移 w/10、模糊 w/3）来自表盘上的环，那里 w≈20px：偏移 2px、
 * 模糊 6.7px，看得见。比例是无量纲的，渲染结果不是 —— 抗锯齿有一个绝对下限。
 * 这里 w=3，照抄下来偏移 0.3px、模糊 1.0px：**模糊半径是偏移量的 3.3 倍**，
 * 0.3px 的位移被摊进 1px 的糊里，等于白付一个 filter 的代价，屏幕上什么都没有。
 *
 * 所以偏移不再按 w/10 取，而是给一个物理下限：`max(w/10, 0.6px)` —— 0.6px 在 2x 屏
 * 上是一个多物理像素，是「能被采样到」的最小位移。模糊同时收到 w/4，把模糊/偏移
 * 比压到 1.25 以内；糊得比位移还宽，位移就被自己的模糊吃掉了。
 *
 * ## 轨道不是灰的
 *
 * 是这一圈自己的色相压到 16% 透明度。灰轨道读起来是「一个进度控件」，
 * 同色低亮轨道读起来是「一个有材质的环」。两个独立的复刻项目都独立得出这一条。
 *
 * ## 只在真的绕过起点时才画阴影
 *
 * 剩余弧长还大于一个描边宽度时，端点离起点远着呢，那时画阴影是在假装一个
 * 不存在的遮挡。判据是几何的（`r * 剩余角 <= w`），不是拍一个 95%。
 */
export function ProgressRing({ pct }: { pct: number }) {
  const W = 3; /* 描边宽度 w，下面所有值都由它导出 */
  const R = 8.5;
  const SIZE = 22;
  const C = 2 * Math.PI * R;
  const frac = Math.min(1, Math.max(0, pct / 100));

  /* 端点此刻的角度。SVG 从 3 点钟起算，环从 12 点钟起画，所以减 90°。 */
  const angle = frac * 2 * Math.PI - Math.PI / 2;

  /* 切向偏移：沿「前进方向」放。前进方向是端点处的切线，也就是半径方向再转 90°
     —— 于是 (cos, sin) 里的 angle 直接加上 π/2。
     长度取 max(w/10, 0.6)：见上面那段，w/10 在 w=3 时是 0.3px，糊完就没了。 */
  const k = Math.max(W / 10, 0.6);
  const dx = k * Math.cos(angle + Math.PI / 2);
  const dy = k * Math.sin(angle + Math.PI / 2);
  const blur = W / 4; /* 压到偏移量的 1.25 倍以内，否则位移被自己的模糊吃掉 */

  /* 只有绕回来快盖住起点时才有遮挡可言。 */
  const overlaps = R * (2 * Math.PI * (1 - frac)) <= W;

  /* SVG 的 id 是**整篇文档**共享的命名空间，不是组件私有的。原来这里用
     `pr${pct}` 拼 —— 首页一屏好几个议题，两个 0% 的环就会拼出同一个 `pr0`，
     按规范后出现的同名 id 被忽略，于是第二个环引用的是第一个环的 clipPath。
     `useId()` 是 React 给这件事的正解，服务端和客户端拿到同一个值。 */
  const uid = useId().replace(/:/g, "");

  return (
    <svg
      width={SIZE}
      height={SIZE}
      viewBox={`0 0 ${SIZE} ${SIZE}`}
      className="shrink-0"
      role="img"
      aria-label={`深度研究进度 ${pct}%`}
    >
      <defs>
        {/* 角向渐变在 SVG 里没有原生支持，用一道线性的当近似 —— 环只有 22px，
            两端的明度差读得出来，渐变的走向读不出来。深的一端在尾，亮的一端在首，
            这是 Apple 三个环的方向。 */}
        <linearGradient id={`${uid}g`} x1="0" y1="1" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--factual)" />
          <stop
            offset="100%"
            stopColor="color-mix(in oklab, var(--factual) 62%, white)"
          />
        </linearGradient>

        {/*
         * 阴影被裁在环带里。
         *
         * `clipPath` 用的是**同一个圆、同一个描边宽度**画出来的一条带子 ——
         * 于是阴影无论怎么偏移、怎么扩散，都只可能落在环自己身上。
         * 这一句就是整个效果的全部：去掉它，它就是一个浮在卡片上的圆。
         */}
        <clipPath id={`${uid}c`}>
          <circle cx={SIZE / 2} cy={SIZE / 2} r={R} fill="none" stroke="#000" strokeWidth={W} />
        </clipPath>

        <filter id={`${uid}s`} x="-50%" y="-50%" width="200%" height="200%">
          <feDropShadow
            dx={dx}
            dy={dy}
            stdDeviation={blur}
            floodColor="#000"
            floodOpacity="0.55"
          />
        </filter>
      </defs>

      <circle
        className="gauge-track"
        cx={SIZE / 2}
        cy={SIZE / 2}
        r={R}
        strokeWidth={W}
      />

      <g clipPath={`url(#${uid}c)`}>
        <circle
          className="gauge-fill"
          cx={SIZE / 2}
          cy={SIZE / 2}
          r={R}
          strokeWidth={W}
          stroke={`url(#${uid}g)`}
          strokeDasharray={C}
          strokeDashoffset={C * (1 - frac)}
          transform={`rotate(-90 ${SIZE / 2} ${SIZE / 2})`}
          filter={overlaps ? `url(#${uid}s)` : undefined}
        />
      </g>
    </svg>
  );
}

/**
 * 人那份 —— **只在它真有话说的时候出现一行。**
 *
 * 两句留下来了：等谁回传、已回传。它们各自带一个新事实（人是谁、东西到了），
 * 那是这一句唯一能说而别处说不了的东西。
 *
 * 「未指派」这一句 2026-08-27 删了。它和卡片最后那行的「未指派DRI」说的是同一件事
 * （这件事此刻没有主人），来源不同不构成在一块 100px 高的东西上写两遍的理由 ——
 * 而两句挨在一起的后果比啰嗦更糟：他会去找这两句的差别，然后发现没有。
 *
 * 删掉一句不等于这件事没状态了：没人承接仍然是一种状态，它由那一行的「未指派DRI」
 * 说出来（见 `IssueRow`）。这里返回 `null` 是**不重复**，不是留白。
 */
export function HandoffStatusLine({ handoff }: { handoff: IssueSummary["handoff"] }) {
  if (handoff.state === "done") {
    return (
      <p className="meta flex items-center gap-1.5 text-confirmed">
        <Check className="size-3 shrink-0" aria-hidden />
        承接研究 · 已回传
      </p>
    );
  }
  if (handoff.state === "waiting") {
    return (
      <p className="meta flex items-start gap-1.5 text-ink-muted">
        <span aria-hidden className="mt-[5px] size-1.5 shrink-0 rounded-full bg-hairline-strong" />
        <span className="min-w-0">承接研究 · 等 {handoff.driName} 回传</span>
      </p>
    );
  }
  return null;
}
