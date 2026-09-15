#!/usr/bin/env node
/**
 * 试听：把候选音色 × 语速全合一遍，落成能双击播放的 wav。
 *
 *   pnpm dev              # 另开一个终端
 *   pnpm tts:audition
 *
 * 候选表在 `demo/voice.json` 的 `audition` 那一节（3 个音色 × 1.0/1.1 两个语速 = 6 个文件）。
 * 念的是这场会真的要念的话（开场白 + 第一件口播），不是「你好，欢迎使用」—— 音色合不合适
 * 只有拿真台词才听得出来，尤其是数字和专有名词那几处。
 *
 * 听完把选中的那一组填回 `demo/voice.json` 的 `voice` 和 `speed`，然后 `pnpm tts:pregen`。
 * 参数 `--text "…"` 可以换一段来念。
 */

import { main } from "./pregen-tts.mjs";

const at = process.argv.indexOf("--text");
const text = at >= 0 ? process.argv[at + 1] : undefined;

await main("audition", text ? { text } : {});
