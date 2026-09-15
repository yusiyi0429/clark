import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

/**
 * 自定义的字号要告诉 tailwind-merge 一声。
 *
 * 它靠名字猜 `text-*` 是字号还是颜色：`text-sm`/`text-lg` 这些内置的它认得，我们自己在
 * `globals.css` 里加的（`text-stage-lead`、`text-meta`…）它一律当成颜色。于是
 * `cn("text-stage text-ink")` 在它眼里是两个颜色打架，后一个赢 —— **字号被静默删掉**，
 * 那一行掉回继承来的 14px。
 *
 * 这不是理论：语音条那行字幕本该 18px，投影上量出来是 16px；决议草案卡的字段值本该 28px，
 * 同样掉回 16px —— 一张标题 44px 的卡上挂着 16px 的正文，会议室后排看不见。
 *
 * 写死一份清单是有代价的（`globals.css` 里加字号要来这儿加一行），但另外两条路更差：让每个
 * 调用点把字号挪出 `cn()` 是要求所有人都记得这件事，而不用 `cn()` 就没有条件类名了。
 */
const SIZES = ["micro", "meta", "md", "stage", "stage-meta", "stage-lead", "stage-title"]

const twMerge = extendTailwindMerge({
  extend: { classGroups: { "font-size": [{ text: SIZES }] } },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
