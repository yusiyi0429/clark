"use client";

import { Check, Copy, ThumbsDown, ThumbsUp } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * 一轮底下那一排小动作：复制、赞、踩。
 *
 * ## 两侧用同一个
 *
 * 参谋说的那一段和他自己发出去的那一句都挂它。语义不一样（一个是「这一答有没有用」，
 * 一个是「这一问值不值得再问」），但**动作、位置、图标、手感必须是同一套** —— 同一排
 * 东西在同一栏里长成两副样子，读的人会以为它们做的是两件事。
 *
 * ## 为什么常驻，不是 hover 才出来
 *
 * hover 才出来的那一版更干净，代价是**他得先猜到那儿有东西**。这一栏里这三个动作都是
 * 低频但关键的（复制一段拿去用、给一轮定性），而低频动作藏在 hover 后面等于不存在。
 * 所以常驻，但压到最淡的那一档（`--ink-faint`，12px），指过去才变实。
 *
 * ## 复制失败要说话
 *
 * 剪贴板被浏览器挡住（非安全上下文、没给权限）是一个**真实结果**，不是我们这一侧的错。
 * 静默失败的样子是：他点了「复制」，图标变成对勾，粘出来是上一次的东西。所以挡住时
 * 那一枚旁边写一句，和 `recording/transcript.tsx` 那一处同一个口径。
 */
export function TurnActions({
  text,
  verdict,
  onVerdict,
  className,
}: {
  /** 复制到剪贴板的原文。参谋那一段是 Markdown 原文 —— 他粘到别处多半还要它的结构。 */
  text: string;
  /** 他此刻的态度。`undefined` = 没表过态，和「点了又收回」是同一个显示，也该是。 */
  verdict?: "up" | "down";
  /**
   * 点了赞或踩。**再点一次同一枚是收回**，那件事由库那一侧判（`rateInThread`）——
   * 这里只把按下的那一枚报上去，不在两处各写一遍三态怎么转。
   *
   * 不给这个回调时两枚拇指整个不出现：不落库的那一档（`ephemeral`）点了也留不住，
   * 而一枚点了不留的拇指比没有更糟。
   */
  onVerdict?: (v: "up" | "down") => void;
  className?: string;
}) {
  const [copied, setCopied] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const timer = useRef<number | undefined>(undefined);

  // 组件在两秒内被卸掉（换了一栏对话）时别再去 setState。
  useEffect(() => () => window.clearTimeout(timer.current), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setBlocked(false);
      setCopied(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(false), 1600);
    } catch {
      setBlocked(true);
    }
  };

  return (
    <div className={cn("flex items-center gap-0.5", className)}>
      <IconButton
        label={copied ? "已复制" : "复制"}
        onClick={() => void copy()}
        active={copied}
      >
        {copied ? <Check className="size-3.5" aria-hidden /> : <Copy className="size-3.5" aria-hidden />}
      </IconButton>

      {onVerdict ? (
        <>
          <IconButton
            label="有用"
            pressed={verdict === "up"}
            active={verdict === "up"}
            onClick={() => onVerdict("up")}
          >
            <ThumbsUp
              className={cn("size-3.5", verdict === "up" && "fill-current")}
              aria-hidden
            />
          </IconButton>
          <IconButton
            label="没用"
            pressed={verdict === "down"}
            active={verdict === "down"}
            onClick={() => onVerdict("down")}
          >
            <ThumbsDown
              className={cn("size-3.5", verdict === "down" && "fill-current")}
              aria-hidden
            />
          </IconButton>
        </>
      ) : null}

      {blocked ? (
        <span className="meta ml-1.5 text-ink-faint" role="alert">
          这台浏览器没让复制
        </span>
      ) : null}
    </div>
  );
}

/**
 * 一枚。方形的点击区（28px）比图标大一圈 —— 14px 的图标本身点起来太小，而这一排
 * 常驻在每一轮底下，点不准的代价是他每次都要瞄。
 *
 * `aria-pressed` 只给两枚拇指（它们是开关）。复制不是开关，给了它读屏会念成
 * 「未按下的复制」，而复制没有「按下」这个状态。
 */
function IconButton({
  label,
  onClick,
  pressed,
  active,
  children,
}: {
  label: string;
  onClick: () => void;
  pressed?: boolean;
  active?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      {...(pressed === undefined ? {} : { "aria-pressed": pressed })}
      className={cn(
        "flex size-7 items-center justify-center rounded-md transition-colors duration-fast ease-swift",
        active ? "text-ink" : "text-ink-faint hover:bg-neutral-wash hover:text-ink-muted",
      )}
    >
      {children}
    </button>
  );
}
