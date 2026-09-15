#!/usr/bin/env node
/**
 * 批量预合成台词。会前跑一次。
 *
 *   pnpm dev            # 另开一个终端，这个脚本要它在
 *   pnpm tts:pregen
 *
 * 为什么它要先跑 `pnpm dev`：真正干活的是 `/api/tts/pregen`，这个文件只是个命令行外壳。
 * 这么分是故意的 —— 合成必须跑在 Next 那个进程里，才能保证用的是同一个 `demo/voice.json`、
 * 同一个环境变量里的 key、同一个厂商适配器。会前十一点最不需要的就是「脚本里合出来的声音
 * 和会上放出来的声音不是同一套参数」这种事。
 *
 * 参数：
 *   --only opening,item-04-J2   只重合这几条（改了一句口播的时候用，不用等十几条）
 *   --base http://…             服务不在 3000 的时候指过去
 */

import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

/** `.env.local` 里的 OPERATOR_TOKEN。手动 export 一遍很容易忘，所以这里自己读。 */
async function tokenFromEnvFile() {
  try {
    const text = await readFile(new URL("../.env.local", import.meta.url), "utf8");
    for (const raw of text.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const at = line.indexOf("=");
      if (at < 0) continue;
      if (line.slice(0, at).trim() !== "OPERATOR_TOKEN") continue;
      return line
        .slice(at + 1)
        .trim()
        .replace(/^["']|["']$/g, "");
    }
  } catch {
    /* 没有这个文件就算了。 */
  }
  return null;
}

function flag(name) {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : undefined;
}

export async function main(mode, extra = {}) {
  const base = flag("base") ?? process.env.TTS_BASE ?? "http://localhost:3000";
  const token = process.env.OPERATOR_TOKEN ?? (await tokenFromEnvFile());
  if (!token) {
    console.error("没找到 OPERATOR_TOKEN —— 写进 .env.local，或者 export 一个。");
    process.exit(1);
  }

  const only = flag("only");
  const body = { mode, ...extra };
  if (only) body.only = only.split(",").map((s) => s.trim()).filter(Boolean);

  const label = mode === "audition" ? "试听" : "预合成";
  console.log(`${label}：${base}\n`);

  let res;
  try {
    res = await fetch(`${base}/api/tts/pregen`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-operator-token": token },
      body: JSON.stringify(body),
    });
  } catch {
    console.error(`连不上 ${base} —— 先在另一个终端 pnpm dev。`);
    process.exit(1);
  }

  const data = await res.json().catch(() => null);
  if (!res.ok) {
    console.error(data?.error ?? `HTTP ${res.status}`);
    process.exit(1);
  }

  console.log(`${data.provider} · ${data.model} · ${data.voice} · ${data.speed}x · ${data.sampleRate}Hz\n`);
  for (const r of data.results ?? []) {
    // 失败的那几条把厂商原话整句印出来 —— 音色 id 打错是最常见的一种，原话里就写着。
    console.log(
      r.ok
        ? `  ok    ${r.id.padEnd(16)} ${String(r.seconds).padStart(5)}s  ${r.path}`
        : `  失败  ${r.id.padEnd(16)} ${r.error}`,
    );
  }
  console.log(`\n成功 ${data.ok} 条，失败 ${data.failed} 条。`);

  if (mode === "audition" && data.ok) {
    console.log("听一遍 demo/audio/audition/ 里的文件，把选中的音色和语速填回 demo/voice.json。");
  }
  process.exit(data.failed ? 1 : 0);
}

/*
 * 直接跑这个文件就是合台词；试听走 tts-audition.mjs（它 import 这里的 main）。
 *
 * 用 `pathToFileURL` 比，不用字符串拼 `file://` —— Windows 上盘符那一段拼出来是
 * `file://C:/…`（两个斜杠），跟 `import.meta.url` 的 `file:///C:/…` 永远对不上，
 * 于是这个脚本会静默地什么都不做。
 */
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main("lines");
}
