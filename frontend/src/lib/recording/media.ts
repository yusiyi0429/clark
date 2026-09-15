/**
 * 把任意格式的音视频规整成识别那一侧能吃的一份 mp3，顺带探出时长。
 *
 * ## 为什么这一段必须落在本机，而不是丢给厂商
 *
 * 手机里录的是 m4a、腾讯会议导出来的是带视频轨的 mp4、浏览器录的是 webm —— 火山那条
 * 只认固定的几种。与其在上传那一侧写一串「这个格式行、那个不行」的判断（每加一种格式
 * 就要改一次，而且改错了要等真文件到手才知道），不如统统过一遍 ffmpeg 压成同一种东西。
 * 代价是这台机器上得有 ffmpeg —— 这是**部署前提**，不是运行时可以降级的东西，所以
 * `mediaToolsAvailable()` 存在的意义是让启动自检和 `/api/health` 能提前把这句话说出口，
 * 而不是等一号位传了一小时的会才在屏幕上看见一行红字。
 *
 * ## 为什么全程 `spawn` + 数组参数，一次 shell 都不起
 *
 * 这是个中文产品，文件名里**一定**会有中文和空格（「产品周会 2026-08-31.m4a」是默认长相）。
 * 拼 shell 字符串的话，引号规则在 cmd.exe / PowerShell / sh 三处各不相同，同一段代码在
 * 主力开发机上碎掉的方式和在服务器上碎掉的方式还不一样；更要命的是文件名来自上传，
 * 一个带 `&` 或反引号的名字就是一条注入。数组参数没有这一层，libuv 直接把它交给
 * CreateProcess/execve，中间没有任何人重新分词。
 *
 * ## 为什么不设总超时，只防空转
 *
 * 一小时的会转码就是要几分钟，一刀切的总超时要么砍掉正常的长会、要么形同虚设。真正
 * 要防的是**卡死**：ffmpeg 在啃一个坏文件时会挂在那里一声不吭。它平时会往 stderr 持续
 * 写进度行（正因如此这条命令里不加 `-nostats`），所以「多久没有任何输出」是一个比墙钟
 * 总时长准得多的活着与否的判据。
 *
 * ## 错误消息就是屏幕上那句话
 *
 * `Recording.error` 那一格写着照抄原话。ffmpeg 把真正的原因写在 stderr 的最后几行
 * （「Invalid data found when processing input」这种），前面几十行是编译参数横幅。所以
 * 失败时只带尾巴上来 —— 灌整份 banner 等于把那句话埋掉，而「转码失败」四个字对排查
 * 一点用都没有。
 */
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { dirname, extname, resolve } from "node:path";

/**
 * 本机没装 ffmpeg/ffprobe。**单独一个类，是因为调用方要据此决定不给重试按钮** ——
 * 这件事重试一万次是同一个结果（`RecordingFailStage` 顶上那段说的就是它）。
 */
export class MediaToolsMissing extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaToolsMissing";
  }
}

/** 空转多久算卡死。一小时的会转码要几分钟，但连着五分钟一个字都不吐一定是挂了。 */
const DEFAULT_IDLE_MS = 5 * 60_000;
/** 进程里留多少 stderr。ffmpeg 的进度行是一秒好几条，一小时的会能攒出几 MB。 */
const STDERR_KEEP = 4_000;
/** 往错误消息里带多少。再多就把真正那句话埋在 banner 里了。 */
const STDERR_SHOW = 1_000;

/**
 * 两个可执行文件的名字每次调用现读，不在模块顶上定死。
 *
 * `winget` 装完要重开终端 PATH 才刷新 —— 定死的话，一个跑了半天的 dev server 就算
 * 用户已经装好了也永远说没装，而屏幕上完全看不出这是「进程里那份 PATH 旧了」。
 * 顺带留出一条手动指路：PATH 实在修不好时可以直接给绝对路径。
 */
const ffmpegBin = () => process.env.TKOS_FFMPEG_PATH || "ffmpeg";
const ffprobeBin = () => process.env.TKOS_FFPROBE_PATH || "ffprobe";

/**
 * 没装时该说的话。**装法要写全**：说「没装 ffmpeg」而不说怎么装，等于把人推去搜索引擎，
 * 而搜到的第一条多半是让人手动解压再改系统环境变量。重开终端那句必须有 —— 它是这条路
 * 上最常见的「我明明装了」。
 */
function missingMessage(bin: string): string {
  return (
    `找不到 ${bin} —— 本机没装 ffmpeg，或者装了但不在这个进程的 PATH 上。\n` +
    `Windows 上装：winget install Gyan.FFmpeg\n` +
    `装完必须重开终端（PATH 只对新开的进程生效），再重启 dev server。\n` +
    `ffmpeg 和 ffprobe 在同一个包里，装一次两个都有。`
  );
}

/** 一次子进程跑完的结果。`code` 为 null 表示它是被信号带走的。 */
interface RunOutcome {
  code: number | null;
  stdout: string;
  stderr: string;
}

/**
 * 起一个子进程，等它跑完。**不给 shell，参数原样进数组。**
 *
 * spawn 的 ENOENT 在这里就被认成 `MediaToolsMissing`：再往上走它会长成一个普通的
 * Error，和「这个文件 ffmpeg 啃不动」混在一起，而这两件事该给的下一步动作是相反的
 * （一个是去装、一个是换文件）。
 */
function run(bin: string, args: string[], idleMs: number): Promise<RunOutcome> {
  return new Promise<RunOutcome>((done, fail) => {
    let child: ReturnType<typeof spawn>;
    try {
      // windowsHide：这台是主力开发机，否则每转一份都闪一个黑框。
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

    /* 每收到一点输出就把闹钟往后推。用可重置的 setTimeout 而不是轮询：一秒几次的重置
       比一个每秒醒一次的定时器便宜，而且「刚好在两次轮询之间吐了一口气」这种漏判没有。 */
    const arm = () => {
      if (settled) return;
      if (idle) clearTimeout(idle);
      idle = setTimeout(() => {
        finish(() => {
          fail(
            new Error(
              `${bin} 卡住了：连着 ${Math.round(idleMs / 1000)} 秒没有任何输出，已经把它掐掉。\n` +
                tail(stderr),
            ),
          );
        });
        try {
          child.kill();
        } catch {
          /* 它可能刚好自己退了。掐一个已经没了的进程不是错误。 */
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
    child.on("error", (err: unknown) => {
      finish(() => fail(asToolError(err, bin)));
    });
    child.on("close", (code: number | null) => {
      finish(() => done({ code, stdout, stderr }));
    });

    arm();
  });
}

/** 只留尾巴。前面那些是横幅和进度行，出事时没人看。 */
const clip = (text: string) => (text.length > STDERR_KEEP ? text.slice(-STDERR_KEEP) : text);

/** 拿 stderr 的最后几行拼一句能上屏的话。 */
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

/** ENOENT 是「没装」，别的照原样。 */
function asToolError(err: unknown, bin: string): Error {
  const code = (err as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") return new MediaToolsMissing(missingMessage(bin));
  if (err instanceof Error) return err;
  return new Error(String(err));
}

const firstLine = (text: string) => text.trim().split(/\r?\n/)[0]?.trim() ?? "";

/** 一个可执行文件在不在，以及一句给人看的话。 */
async function checkBinary(bin: string): Promise<{ present: boolean; note: string }> {
  try {
    // `-version` 是这两个工具里最便宜、且一定不碰文件系统的一条。
    const r = await run(bin, ["-version"], 30_000);
    if (r.code === 0) return { present: true, note: firstLine(r.stdout) || `${bin} 在` };
    return { present: false, note: `${bin} 找得到，但 -version 退出码是 ${r.code}` };
  } catch (err) {
    if (err instanceof MediaToolsMissing) return { present: false, note: `${bin} 不在 PATH 上` };
    return {
      present: false,
      note: `${bin} 起不来：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * ffmpeg / ffprobe 在不在。**这个函数不抛** —— 它的调用方是启动自检和 `/api/health`，
 * 那两处要的是一个答案，不是一个异常：健康检查自己挂掉，等于把「哪里不健康」这个
 * 问题也一起弄丢了。
 *
 * 两个分开报，是因为它们真的会分开缺（有人从别处拷了一个 ffmpeg.exe 进 PATH，没带
 * ffprobe），而那时候转码是好的、时长是空的 —— 只报一个总的 ok 的话，这种半残状态
 * 看起来和全好一模一样。
 */
export async function mediaToolsAvailable(): Promise<{
  ok: boolean;
  ffmpeg: boolean;
  ffprobe: boolean;
  detail: string;
}> {
  const [a, b] = await Promise.all([checkBinary(ffmpegBin()), checkBinary(ffprobeBin())]);
  const ok = a.present && b.present;
  const notes = [a.note, b.note].join("；");
  const detail = ok ? notes : `${notes}\n${missingMessage(a.present ? ffprobeBin() : ffmpegBin())}`;
  return { ok, ffmpeg: a.present, ffprobe: b.present, detail };
}

/**
 * 探时长，毫秒。
 *
 * **探不出来返回 `undefined`，不抛** —— 浏览器边录边发的 webm 压根没有 duration 头，
 * ffprobe 对它输出 `N/A`，这是这条链路上的常态而不是故障。时长是拿来在列表上显示
 * 「这场会 47 分钟」的，缺了那一格空着就是了，不该把整份录音判死。
 *
 * 唯一的例外是没装：那时候抛 `MediaToolsMissing`。把它也吞成 `undefined` 的话，一台
 * 没装 ffmpeg 的机器上每一份录音都会安安静静地没有时长，而真正的原因一个字都不出现
 * 在屏幕上。
 */
export async function probeDurationMs(
  inputPath: string,
  opts?: { idleMs?: number },
): Promise<number | undefined> {
  const args = [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    resolve(inputPath),
  ];
  let r: RunOutcome;
  try {
    r = await run(ffprobeBin(), args, opts?.idleMs ?? DEFAULT_IDLE_MS);
  } catch (err) {
    if (err instanceof MediaToolsMissing) throw err;
    return undefined;
  }
  if (r.code !== 0) return undefined;
  const seconds = Number.parseFloat(r.stdout.trim());
  // `N/A`、空、以及任何解不出数的东西都走这条。负数当垃圾：它只可能来自一个坏头。
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.round(seconds * 1000);
}

/**
 * 规整成 16 kHz 单声道 64 kbps mp3。
 *
 * 这几个数是识别那一侧定的：它只吃 16 k（`transcribePcm` 顶上那段），人声在 16 k 单声道
 * 64 kbps 下已经到顶，再高只是把上传时间和存储账单乘上去。`-vn` 把视频轨扔掉 —— 会议
 * 软件导出来的 mp4 里那一轨占了九成体积，而这条链路一帧都用不上。
 *
 * 时长探的是**产物不是原件**：原件如果是没有 duration 头的流式 webm，探它是空；转完
 * 这一遍之后 mp3 头上有了，正好白捡一个。
 */
export async function transcodeToMp3(
  inputPath: string,
  outputPath: string,
  opts?: { idleMs?: number },
): Promise<{ path: string; durationMs?: number }> {
  const input = resolve(inputPath);
  // 存绝对路径，理由和 `Recording.rawAudioPath` 那一格一样：相对路径要靠「当时 cwd 是
  // 什么」才解得开，而这条路径会被下游和日志一路带下去。
  const out = withMp3Ext(resolve(outputPath));
  // 输出目录多半是 `.data/recordings/` 下面按 id 分的一层，第一次跑一定不存在。
  mkdirSync(dirname(out), { recursive: true });

  const args = ["-y", "-i", input, "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", out];
  const r = await run(ffmpegBin(), args, opts?.idleMs ?? DEFAULT_IDLE_MS);
  if (r.code !== 0) {
    throw new Error(`ffmpeg 转码失败（退出码 ${r.code}）：\n${tail(r.stderr)}`);
  }

  return { path: out, durationMs: await probeDurationMs(out, opts) };
}

/**
 * 逼出 `.mp3` 后缀。ffmpeg 是**按输出文件的后缀挑封装格式**的，给个 `.tmp` 它会直接
 * 报「Unable to find a suitable output format」—— 而调用方那边通常正想给一个临时文件名。
 */
function withMp3Ext(path: string): string {
  return extname(path).toLowerCase() === ".mp3" ? path : `${path}.mp3`;
}
