/**
 * 把浏览器录的 webm 规整成识别那一侧能吃的一份 mp3。（移植自概念版 `lib/recording/media.ts`）
 *
 * 全程 `spawn` + 数组参数，一次 shell 都不起：文件路径里一定有中文和空格，拼 shell 字符串时
 * cmd.exe / PowerShell / sh 三处引号规则各不相同；数组参数由 libuv 直接交给 CreateProcess/execve。
 *
 * 不设总超时，只防空转：一小时的会转码就要几分钟，真正要防的是 ffmpeg 啃坏文件时一声不吭地挂住。
 * 它平时持续往 stderr 写进度行，所以「多久没有任何输出」比墙钟总时长准得多。
 *
 * 失败时只带 stderr 的尾巴：真正原因在最后几行，前面几十行是编译参数横幅。
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

/** 本机没装 ffmpeg。单独一类：这件事重试一万次是同一个结果，屏幕上该说的是「去装」。 */
export class MediaToolsMissing extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaToolsMissing";
  }
}

/** 空转多久算卡死：连着五分钟一个字都不吐一定是挂了。 */
const DEFAULT_IDLE_MS = 5 * 60_000;
/** 进程里留多少 stderr（进度行一秒好几条）。 */
const STDERR_KEEP = 4_000;
/** 往错误消息里带多少，再多就把真正那句话埋在横幅里了。 */
const STDERR_SHOW = 1_000;

/** 每次调用现读：winget 装完 PATH 只对新进程生效，PATH 修不好时可直接给绝对路径。 */
const ffmpegBin = () => process.env.FFMPEG_PATH || "ffmpeg";

function missingMessage(bin: string): string {
  return (
    `找不到 ${bin} —— 本机没装 ffmpeg，或者装了但不在这个进程的 PATH 上。\n` +
    `Windows 上装：winget install Gyan.FFmpeg，装完必须重开终端（PATH 只对新开的进程生效），再重启 API。\n` +
    `Docker 镜像里装：apk add --no-cache ffmpeg。也可以用 FFMPEG_PATH 指定 ffmpeg 的绝对路径。`
  );
}

type RunOutcome = { code: number | null; stdout: string; stderr: string };

/** 起一个子进程等它跑完；spawn 的 ENOENT 在这里就认成 MediaToolsMissing。 */
function run(bin: string, args: string[], idleMs: number): Promise<RunOutcome> {
  return new Promise<RunOutcome>((done, fail) => {
    let child: ReturnType<typeof spawn>;
    try {
      // windowsHide：主力开发机上每转一份不闪黑框
      child = spawn(bin, args, { windowsHide: true });
    } catch (err) {
      fail(asToolError(err, bin));
      return;
    }
    let stdout = "";
    let stderr = "";
    let settled = false;
    let idle: ReturnType<typeof setTimeout> | undefined;
    const finish = (act: () => void) => {
      if (settled) return;
      settled = true;
      if (idle) clearTimeout(idle);
      act();
    };
    // 每收到一点输出就把闹钟往后推
    const arm = () => {
      if (settled) return;
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        finish(() => fail(new Error(`${bin} 卡住了：连着 ${Math.round(idleMs / 1000)} 秒没有任何输出，已经把它掐掉。\n${tail(stderr)}`)));
        try {
          child.kill();
        } catch {
          // 它可能刚好自己退了
        }
      }, idleMs);
      idle.unref?.();
    };
    child.stdout?.on("data", (chunk: unknown) => {
      stdout = clip(stdout + String(chunk));
      arm();
    });
    child.stderr?.on("data", (chunk: unknown) => {
      stderr = clip(stderr + String(chunk));
      arm();
    });
    child.on("error", (err: unknown) => finish(() => fail(asToolError(err, bin))));
    child.on("close", (code: number | null) => finish(() => done({ code, stdout, stderr })));
    arm();
  });
}

const clip = (text: string) => (text.length > STDERR_KEEP ? text.slice(-STDERR_KEEP) : text);

/** stderr 的最后几行拼一句能上屏的话。 */
function tail(stderr: string): string {
  const text = stderr.trim();
  if (!text) return "（它一个字都没往 stderr 写。）";
  const cut = text.length > STDERR_SHOW;
  const lines = (cut ? text.slice(-STDERR_SHOW) : text)
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.trim().length > 0)
    .slice(-8);
  return (cut ? "…\n" : "") + lines.join("\n");
}

function asToolError(err: unknown, bin: string): Error {
  if ((err as NodeJS.ErrnoException | null)?.code === "ENOENT") return new MediaToolsMissing(missingMessage(bin));
  return err instanceof Error ? err : new Error(String(err));
}

/**
 * 规整成 16 kHz 单声道 64 kbps mp3（人声在这组参数下已到顶，再高只是乘上传时间）；`-vn` 丢掉视频轨。
 * 输出名不是 .mp3 就补上：ffmpeg 按输出后缀挑封装格式。返回产物的绝对路径。
 */
export async function transcodeToMp3(inputPath: string, outputPath: string, opts?: { idleMs?: number }): Promise<string> {
  const input = resolve(inputPath);
  const resolved = resolve(outputPath);
  const out = extname(resolved).toLowerCase() === ".mp3" ? resolved : `${resolved}.mp3`;
  mkdirSync(dirname(out), { recursive: true });
  const args = ["-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", out];
  const r = await run(ffmpegBin(), args, opts?.idleMs ?? DEFAULT_IDLE_MS);
  if (r.code !== 0) throw new Error(`ffmpeg 转码失败（退出码 ${r.code}）：\n${tail(r.stderr)}`);
  return out;
}

/** 声纹音频的字节率：16 kHz × 16 bit × 单声道。 */
export const PCM_BYTES_PER_SECOND = 16000 * 2;

/** 一段时间区间，毫秒，相对音频开头。 */
export type PcmSegment = { startMs: number; endMs: number };

/**
 * 转成腾讯云声纹接口要的裸 PCM（s16le、16 kHz、单声道），最多 maxSeconds 秒（那边单段不超过 30 秒）。
 * 给了 segments 时只取这几段、首尾相接拼成一段（会后按说话人截音频用）；aselect 用的是输入时间轴，
 * asetpts 把时间戳重排成连续的，否则 -t 会按原时间轴截。
 */
export async function toVoiceprintPcm(
  inputPath: string,
  outputPath: string,
  opts: { maxSeconds: number; segments?: PcmSegment[]; idleMs?: number },
): Promise<void> {
  const out = resolve(outputPath);
  mkdirSync(dirname(out), { recursive: true });
  const sec = (ms: number) => (Math.max(0, ms) / 1000).toFixed(3);
  const select = opts.segments?.length
    ? ["-af", `aselect='${opts.segments.map((s) => `between(t,${sec(s.startMs)},${sec(s.endMs)})`).join("+")}',asetpts=N/SR/TB`]
    : [];
  const args = ["-y", "-i", resolve(inputPath), "-vn", ...select, "-ac", "1", "-ar", "16000", "-t", String(opts.maxSeconds), "-f", "s16le", "-acodec", "pcm_s16le", out];
  const r = await run(ffmpegBin(), args, opts.idleMs ?? DEFAULT_IDLE_MS);
  if (r.code !== 0) throw new Error(`ffmpeg 转声纹音频失败（退出码 ${r.code}）：\n${tail(r.stderr)}`);
}
