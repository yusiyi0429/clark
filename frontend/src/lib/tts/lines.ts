/**
 * 台词表 —— 会前预合成的那一批，和它们的编号。
 *
 * 编号就是文件名（`demo/audio/<id>.pcm`）。一处定义，三处读：
 *
 *   - `scripts/pregen-tts` 按这张表批量合成；
 *   - `/api/speak?line=<id>` 命中就直接吐文件，不走厂商；
 *   - 秘书控制台按这张表列按钮和热键。
 *
 * 三处如果各写一份编号，会出现「秘书按的那个 id 没有对应文件」这种错 —— 而它只会在会上
 * 那一下才暴露出来。
 *
 * 这张表里的每一句都是**固定台词**：开场、每件事的口播、收尾、十来句过渡语。模型现说的话
 * 不在这里（它每次说的都不一样，预合成不了），它走现合成那条路。
 */

import { AGENDA } from "@/lib/demo/agenda";

import rawPhrases from "../../../demo/phrases.json";

export interface Line {
  id: string;
  text: string;
  /** 控制台按钮上写什么。 */
  label: string;
  group: "opening" | "item" | "closing" | "phrase";
}

const PHRASES = (rawPhrases as { phrases?: { id?: unknown; text?: unknown }[] }).phrases ?? [];

export const LINES: Line[] = [
  { id: "opening", text: AGENDA.opening, label: "开场白", group: "opening" },
  ...AGENDA.items.map((item, at) => ({
    id: `item-${item.id}`,
    text: item.script,
    label: `第 ${at + 1} 件口播`,
    group: "item" as const,
  })),
  { id: "closing", text: AGENDA.closing, label: "收尾", group: "closing" as const },
  ...PHRASES.flatMap((p) => {
    const id = typeof p.id === "string" ? p.id.trim() : "";
    const text = typeof p.text === "string" ? p.text.trim() : "";
    if (!id || !text) return [];
    return [{ id, text, label: text, group: "phrase" as const }];
  }),
];

export const findLine = (id: string): Line | undefined => LINES.find((l) => l.id === id);

/**
 * 音频文件在哪儿。
 *
 * 格式一律是原始 PCM16：前端只有一条解码路径。mp3 更小，但 `decodeAudioData` 要拿到完整
 * 文件才解得开，边下边播就做不了 —— 现合成那条路必须边下边播，而两条路共用一个播放器。
 * 一场会的音频加起来几兆，本地文件，不值得为体积换一条第二解码路径。
 */
export const audioRelPath = (id: string): string => `demo/audio/${id}.pcm`;

/**
 * 试听文件：`demo/audio/audition/<voice>-<speed>.wav`。
 *
 * 这一批是 WAV 不是 PCM —— 它们是给人双击听的，不是给播放器解码的。
 */
export const auditionRelPath = (voice: string, speed: number): string =>
  `demo/audio/audition/${voice}-${String(speed).replace(".", "_")}.wav`;
