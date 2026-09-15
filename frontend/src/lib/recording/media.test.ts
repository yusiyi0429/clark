/**
 * 规整音频那一段。
 *
 * **这里一次都不真的调 ffmpeg** —— CI 和主力开发机上都没装它，而「装了才能跑」的测试
 * 等于没有测试：它会在所有人那里绿着跳过，恰好在唯一一台真装了的机器上才开始有意义。
 * 所以 `node:child_process` 整个被替掉，跑的是**参数怎么拼、结果怎么解、失败怎么分类**
 * 这三件事 —— 它们全部是纯逻辑，而且全部错在没有症状的地方：
 *
 *   · argv 拼错（比如 `-ar 16000` 被拼成一个元素、或者带空格的中文路径被拆成两段）。
 *     ffmpeg 会拒掉，但屏幕上只显示「转码失败」，看不出是我们自己把命令拼碎了。
 *   · ENOENT 被当成普通转码失败。那样屏幕上会给一个重试按钮，而重试一万次是同一个
 *     结果 —— 真正该说的那句「去 winget 装一个」永远不出现。
 *   · stderr 尾巴没带上来。ffmpeg 把真原因写在最后一行，丢了它这条路就没法排查。
 *   · 时长解析。`N/A` 和 `3723.456` 走的是同一条 parse，前者必须落成空而不是 NaN ——
 *     一个 NaN 顺着流到列表上，显示的是「这场会 NaN 分钟」。
 */
import { EventEmitter } from "node:events";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const mkdirMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("node:fs", () => ({ mkdirSync: mkdirMock }));

import { MediaToolsMissing, mediaToolsAvailable, probeDurationMs, transcodeToMp3 } from "./media";

/** 假的子进程。只长出 `run()` 真正用到的那几个口子。 */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

/** 一次假运行该怎么表现。`silent` 是「起来了但一声不吭」，用来撞空转保护。 */
interface Fake {
  code?: number;
  stdout?: string;
  stderr?: string;
  error?: NodeJS.ErrnoException;
  silent?: boolean;
}

let calls: { bin: string; args: string[] }[] = [];
let children: FakeChild[] = [];

/** 按可执行文件的名字决定这一次假装成什么。 */
function stub(pick: (bin: string) => Fake) {
  spawnMock.mockImplementation((bin: string, args: string[]) => {
    calls.push({ bin, args });
    const child = new FakeChild();
    children.push(child);
    const f = pick(bin);
    // 隔一个 tick 再发：`run()` 是 spawn 返回之后才挂的监听。
    setTimeout(() => {
      if (f.error) {
        child.emit("error", f.error);
        return;
      }
      if (f.silent) return;
      if (f.stdout) child.stdout.emit("data", Buffer.from(f.stdout));
      if (f.stderr) child.stderr.emit("data", Buffer.from(f.stderr));
      child.emit("close", f.code ?? 0);
    }, 0);
    return child;
  });
}

const enoent = (): NodeJS.ErrnoException =>
  Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });

beforeEach(() => {
  calls = [];
  children = [];
  spawnMock.mockReset();
  mkdirMock.mockReset();
  // 这两个开关会把可执行文件的名字换掉，断言 argv 时必须是干净的。
  delete process.env.TKOS_FFMPEG_PATH;
  delete process.env.TKOS_FFPROBE_PATH;
});

describe("mediaToolsAvailable", () => {
  it("两个都在：ok，两格都真，detail 里带版本行", async () => {
    stub((bin) => ({ code: 0, stdout: `${bin} version 7.1 Copyright (c) 2000-2026\n配置一大串` }));

    const r = await mediaToolsAvailable();

    expect(r).toEqual({
      ok: true,
      ffmpeg: true,
      ffprobe: true,
      detail: expect.stringContaining("ffmpeg version 7.1"),
    });
    expect(r.detail).toContain("ffprobe version 7.1");
    // 自检不该拿文件去试，只问版本。
    expect(calls.map((c) => c.args)).toEqual([["-version"], ["-version"]]);
  });

  it("一个都不在：不抛，形状照样齐，detail 里写清怎么装", async () => {
    stub(() => ({ error: enoent() }));

    const r = await mediaToolsAvailable();

    expect(r.ok).toBe(false);
    expect(r.ffmpeg).toBe(false);
    expect(r.ffprobe).toBe(false);
    expect(typeof r.detail).toBe("string");
    expect(r.detail).toContain("winget install Gyan.FFmpeg");
    expect(r.detail).toContain("重开终端");
  });

  it("半残（有 ffmpeg 没 ffprobe）不能报成全好", async () => {
    stub((bin) =>
      bin === "ffmpeg" ? { code: 0, stdout: "ffmpeg version 7.1" } : { error: enoent() },
    );

    const r = await mediaToolsAvailable();

    expect(r).toMatchObject({ ok: false, ffmpeg: true, ffprobe: false });
    expect(r.detail).toContain("ffprobe");
  });
});

describe("transcodeToMp3 的命令拼装", () => {
  const input = join(tmpdir(), "产品 周会 2026-08-31.m4a");
  const output = join(tmpdir(), "会议 音频", "产品 周会.mp3");

  it("argv 逐个元素对得上，中文和空格的路径是完整的一个元素", async () => {
    stub((bin) => (bin === "ffprobe" ? { code: 0, stdout: "60\n" } : { code: 0 }));

    const r = await transcodeToMp3(input, output);

    expect(calls[0].bin).toBe("ffmpeg");
    expect(calls[0].args).toEqual([
      "-y",
      "-i",
      resolve(input),
      "-vn",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-b:a",
      "64k",
      resolve(output),
    ]);
    // 逐个点名那几个最容易被拼成一个元素的：`-ac 1`、`-ar 16000`、`-b:a 64k`。
    const args = calls[0].args;
    expect(args).toHaveLength(11);
    expect(args[3]).toBe("-vn");
    expect(args[4]).toBe("-ac");
    expect(args[5]).toBe("1");
    expect(args[6]).toBe("-ar");
    expect(args[7]).toBe("16000");
    expect(args[8]).toBe("-b:a");
    expect(args[9]).toBe("64k");
    // 带空格和中文的那两条路径各自只占一格 —— 被 shell 分过词的话这里会是两格以上。
    expect(args.filter((a) => a.includes("产品 周会"))).toEqual([resolve(input), resolve(output)]);

    expect(r.path).toBe(resolve(output));
    expect(r.durationMs).toBe(60_000);
    // 输出目录第一次跑一定不存在。
    expect(mkdirMock).toHaveBeenCalledWith(dirname(resolve(output)), { recursive: true });
  });

  it("输出名不是 .mp3 就补上 —— ffmpeg 按后缀挑封装格式", async () => {
    stub(() => ({ code: 0, stdout: "1\n" }));

    const out = join(tmpdir(), "会议 音频", "rec-tmp");
    const r = await transcodeToMp3(input, out);

    expect(calls[0].args.at(-1)).toBe(`${resolve(out)}.mp3`);
    expect(r.path).toBe(`${resolve(out)}.mp3`);
  });

  it("时长探的是产物不是原件（流式 webm 原件上没有 duration 头）", async () => {
    stub((bin) => (bin === "ffprobe" ? { code: 0, stdout: "12.5\n" } : { code: 0 }));

    await transcodeToMp3(input, output);

    expect(calls[1].bin).toBe("ffprobe");
    expect(calls[1].args.at(-1)).toBe(resolve(output));
  });
});

describe("transcodeToMp3 的失败分类", () => {
  const input = join(tmpdir(), "坏 文件.m4a");
  const output = join(tmpdir(), "out.mp3");

  it("ENOENT 是「没装」，不是「转码失败」，消息里有 winget", async () => {
    stub(() => ({ error: enoent() }));

    const err = await transcodeToMp3(input, output).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(MediaToolsMissing);
    expect((err as Error).message).toContain("winget install Gyan.FFmpeg");
    expect((err as Error).message).toContain("重开终端");
  });

  it("非零退出：消息里带 stderr 的尾巴，横幅不进来", async () => {
    const banner = "ffmpeg version 7.1 Copyright (c) 2000-2026\n" + "  configuration: --一堆开关\n".repeat(80);
    const real = "坏 文件.m4a: Invalid data found when processing input";
    stub(() => ({ code: 1, stderr: `${banner}${real}\n` }));

    const err = await transcodeToMp3(input, output).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(MediaToolsMissing);
    const msg = (err as Error).message;
    expect(msg).toContain(real);
    expect(msg).toContain("退出码 1");
    // 横幅第一行被截在外面 —— 否则真正那句话会被埋掉。
    expect(msg).not.toContain("ffmpeg version 7.1 Copyright");
    expect(msg.length).toBeLessThan(1_400);
  });

  it("一直不出声就掐掉，而且说清是空转不是转码失败", async () => {
    stub(() => ({ silent: true }));

    const err = await transcodeToMp3(input, output, { idleMs: 30 }).catch((e: unknown) => e);

    expect((err as Error).message).toContain("卡住");
    expect(children[0].killed).toBe(true);
  });
});

describe("probeDurationMs", () => {
  const input = join(tmpdir(), "一段 录音.webm");

  it("命令是固定那一条，秒解析成毫秒取整", async () => {
    stub(() => ({ code: 0, stdout: "3723.456\n" }));

    await expect(probeDurationMs(input)).resolves.toBe(3_723_456);
    expect(calls[0].bin).toBe("ffprobe");
    expect(calls[0].args).toEqual([
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      resolve(input),
    ]);
  });

  it.each([
    ["空", ""],
    ["只有换行", "\n"],
    ["N/A（流式 webm 没有 duration 头）", "N/A\n"],
    ["垃圾", "duration=不知道\n"],
    ["负数", "-3\n"],
  ])("解不出数就是空，不抛也不是 NaN：%s", async (_label, stdout) => {
    stub(() => ({ code: 0, stdout }));

    await expect(probeDurationMs(input)).resolves.toBeUndefined();
  });

  it("ffprobe 非零退出也只是「不知道」", async () => {
    stub(() => ({ code: 1, stderr: "moov atom not found" }));

    await expect(probeDurationMs(input)).resolves.toBeUndefined();
  });

  it("但「没装」要抛出来 —— 悄悄返回空的话没人知道时长为什么全是空的", async () => {
    stub(() => ({ error: enoent() }));

    await expect(probeDurationMs(input)).rejects.toBeInstanceOf(MediaToolsMissing);
  });
});
