import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { AGENDA } from "@/lib/demo/agenda";
import { auditionRelPath, audioRelPath, LINES } from "@/lib/tts/lines";
import { wav } from "@/lib/tts/wav";
import { TTSNotConfigured, auditionMatrix, ttsProvider, voiceConfig } from "@/lib/tts";

/**
 * 会前那道保险：把所有固定台词批量合成成文件。
 *
 * 为什么这件事是**必做**而不是优化：会上真正会出问题的三样东西 —— 会议室的网、供应商的额度、
 * 厂商的脾气 —— 没有一样是我能保证的。而这一批文件放在磁盘上，三样全灭的时候秘书按热键
 * 照样能把整场会走完。这是「拔网线也能演」那一条验收标准唯一的实现方式。
 *
 * 它做成一条路由而不是一个独立的 node 脚本，原因很实际：**它必须跑在 Next 这个进程里**，
 * 才能用同一个 `demo/voice.json`、同一个环境变量里的 key、同一个厂商适配器。会前十一点最
 * 不需要的就是「脚本里合出来的声音和会上放出来的声音不是同一套参数」。
 * `scripts/pregen-tts.mjs` 只是这条路由的一个命令行外壳；秘书控制台上那个按钮走的也是这里。
 *
 * 部署到 Vercel 之类只读文件系统上会写不进去。这是对的：它是会前工具，不是线上功能。
 */

interface Body {
  mode?: unknown;
  /** 试听念哪一段。不给就用开场白 + 第一件口播 —— 那是这场会上真的要念的话。 */
  text?: unknown;
  /** 只重做这几条。会前改了一句口播的时候用，不用把十几条全重合一遍。 */
  only?: unknown;
}

interface Result {
  id: string;
  ok: boolean;
  bytes?: number;
  seconds?: number;
  path?: string;
  error?: string;
}

/**
 * 现在有哪几条已经合成好了。
 *
 * 控制台会前要看得见这一行：「已预合成 17/17」。看不见的话，秘书会在会上按一个没有文件的
 * 编号，然后现场等一次厂商往返 —— 那正是预合成想避免的那一下。
 */
export async function GET(req: Request): Promise<Response> {
  const expected = process.env.OPERATOR_TOKEN;
  if (!expected) return Response.json({ error: "服务端没有配 OPERATOR_TOKEN。" }, { status: 503 });
  if (req.headers.get("x-operator-token") !== expected) {
    return Response.json({ error: "口令不对。" }, { status: 401 });
  }

  const cfg = voiceConfig();
  let manifest: { sampleRate?: number; voice?: string; lines?: Record<string, number> } = {};
  try {
    manifest = JSON.parse(
      await readFile(join(process.cwd(), "demo/audio/manifest.json"), "utf8"),
    ) as typeof manifest;
  } catch {
    /* 还没跑过 pregen。 */
  }
  const have = Object.keys(manifest.lines ?? {});

  /*
   * 现合成那条路通不通。
   *
   * 这一行必须在**会前**看得见。屏幕上那条字幕不能承担这件事：没配 key 的时候播放器会报一句
   * 错，但下一个流帧几十毫秒后就把它覆盖掉了 —— 那句话事实上没人看得到。而秘书控制台是会前
   * 真的会被盯着的地方，所以状态放在这儿。
   */
  let configured = true;
  let why: string | null = null;
  try {
    ttsProvider();
  } catch (e) {
    configured = false;
    why = e instanceof Error ? e.message : "语音合成起不来。";
  }

  return Response.json(
    {
      total: LINES.length,
      configured,
      why,
      ready: LINES.filter((l) => have.includes(l.id)).map((l) => l.id),
      /** manifest 里的音色和当前 config 不一致，说明改过配置但没重跑。 */
      stale: Boolean(manifest.voice && manifest.voice !== cfg.voice),
      voice: cfg.voice,
      speed: cfg.speed,
      manifestVoice: manifest.voice ?? null,
      sampleRate: manifest.sampleRate ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}

export async function POST(req: Request): Promise<Response> {
  const expected = process.env.OPERATOR_TOKEN;
  if (!expected) {
    return Response.json({ error: "服务端没有配 OPERATOR_TOKEN。" }, { status: 503 });
  }
  if (req.headers.get("x-operator-token") !== expected) {
    return Response.json({ error: "口令不对。" }, { status: 401 });
  }

  let body: Body = {};
  try {
    body = (await req.json()) as Body;
  } catch {
    /* 空 body 就按默认来。 */
  }

  const cfg = voiceConfig();
  let provider;
  try {
    provider = ttsProvider();
  } catch (e) {
    if (e instanceof TTSNotConfigured) {
      return Response.json({ error: e.message }, { status: 503 });
    }
    throw e;
  }

  const audition = body.mode === "audition";
  const results: Result[] = [];

  if (audition) {
    const text = str(body.text) ?? `${AGENDA.opening}${AGENDA.items[0]?.script ?? ""}`;
    /*
     * 串行，不并发。
     *
     * 六个请求一起发出去很可能撞上厂商的并发限流，回来一片 429 —— 而这个脚本的产出是「听
     * 一遍然后填两个值」，慢十秒没有任何代价，失败一次要重跑。
     */
    for (const { voice, speed } of auditionMatrix(cfg)) {
      const rel = auditionRelPath(voice, speed);
      results.push(await synthesize(provider, `${voice} · ${speed}x`, text, rel, cfg.sampleRate, { voice, speed }, true));
    }
  } else {
    const only = strList(body.only);
    const todo = only.length ? LINES.filter((l) => only.includes(l.id)) : LINES;
    for (const line of todo) {
      results.push(
        await synthesize(provider, line.id, line.text, audioRelPath(line.id), cfg.sampleRate, {}, false),
      );
    }
    await writeManifest(cfg, results);
  }

  const ok = results.filter((r) => r.ok).length;
  return Response.json({
    mode: audition ? "audition" : "lines",
    provider: provider.name,
    model: cfg.model,
    voice: cfg.voice,
    speed: cfg.speed,
    sampleRate: cfg.sampleRate,
    ok,
    failed: results.length - ok,
    results,
  });
}

async function synthesize(
  provider: ReturnType<typeof ttsProvider>,
  id: string,
  text: string,
  rel: string,
  sampleRate: number,
  opts: { voice?: string; speed?: number },
  asWav: boolean,
): Promise<Result> {
  // turbopackIgnore: 同 api/speak —— 运行时路径会让静态分析把整个项目
  // trace 进 server 产物。
  const filePath = join(/*turbopackIgnore: true*/ process.cwd(), rel);
  try {
    if (asWav) {
      // 先落一份裸 PCM（`synthesizeToFile` 就是这么定义的），再套头写成 WAV，然后把中间那份删掉。
      const tmp = `${filePath}.pcm`;
      await provider.synthesizeToFile(text, { ...opts, filePath: tmp });
      const pcm = new Uint8Array(await readFile(tmp));
      await mkdir(dirname(filePath), { recursive: true });
      await writeFile(filePath, wav(pcm, sampleRate));
      await rm(tmp, { force: true });
      return { id, ok: true, bytes: pcm.byteLength, seconds: seconds(pcm.byteLength, sampleRate), path: rel };
    }

    await provider.synthesizeToFile(text, { ...opts, filePath });
    const bytes = (await readFile(filePath)).byteLength;
    return { id, ok: true, bytes, seconds: seconds(bytes, sampleRate), path: rel };
  } catch (e) {
    return { id, ok: false, error: e instanceof Error ? e.message : "合成失败。" };
  }
}

/**
 * manifest 记的是**这批文件真正的参数**。
 *
 * `/api/speak` 放预合成音频的时候按它算采样率，不按当前 config 算 —— 试听完把 config 里的
 * sampleRate 改了却没重跑 pregen，那时候放出来是一段变调的声音，而这种错在会上没法当场解释。
 */
async function writeManifest(
  cfg: ReturnType<typeof voiceConfig>,
  results: Result[],
): Promise<void> {
  const path = join(process.cwd(), "demo/audio/manifest.json");
  const lines: Record<string, number> = {};
  for (const r of results) if (r.ok && r.bytes) lines[r.id] = r.bytes;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(
    path,
    `${JSON.stringify(
      {
        $comment:
          "pregen 写的，手改没有意义。/api/speak 按 sampleRate 这一项决定放预合成音频时的采样率。",
        provider: cfg.provider,
        model: cfg.model,
        voice: cfg.voice,
        speed: cfg.speed,
        sampleRate: cfg.sampleRate,
        lines,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

/** PCM16 单声道：两个字节一个采样。用来在回执里写「这一条几秒」。 */
const seconds = (bytes: number, sampleRate: number): number =>
  Math.round((bytes / 2 / sampleRate) * 10) / 10;

const str = (v: unknown): string | undefined => {
  if (typeof v !== "string") return undefined;
  const t = v.trim();
  return t ? t : undefined;
};

const strList = (v: unknown): string[] =>
  Array.isArray(v) ? v.map(str).filter((s): s is string => Boolean(s)) : [];
