/**
 * ffmpeg 规整那一段（移植自概念版 media.test.ts）。**这里一次都不真的调 ffmpeg**：`node:child_process`
 * 被替掉，测的是参数怎么拼、失败怎么分类 —— 它们全部错在没有症状的地方：
 * argv 拼碎（中文空格路径被拆成两段）、ENOENT 被当成普通转码失败、stderr 尾巴没带上来。
 */
import { EventEmitter } from "node:events";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const mkdirMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));
vi.mock("node:fs", () => ({ mkdirSync: mkdirMock }));

import { MediaToolsMissing, toVoiceprintPcm, transcodeToMp3 } from "../src/recordingMedia.js";

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

type Fake = { code?: number; stdout?: string; stderr?: string; error?: NodeJS.ErrnoException; silent?: boolean };

let calls: { bin: string; args: string[] }[] = [];
let children: FakeChild[] = [];

function stub(pick: (bin: string) => Fake) {
  spawnMock.mockImplementation((bin: string, args: string[]) => {
    calls.push({ bin, args });
    const child = new FakeChild();
    children.push(child);
    const f = pick(bin);
    // 隔一个 tick 再发：run() 是 spawn 返回之后才挂的监听
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

const enoent = (): NodeJS.ErrnoException => Object.assign(new Error("spawn ffmpeg ENOENT"), { code: "ENOENT" });

beforeEach(() => {
  calls = [];
  children = [];
  spawnMock.mockReset();
  mkdirMock.mockReset();
  delete process.env.FFMPEG_PATH;
});

describe("transcodeToMp3 的命令拼装", () => {
  const input = join(tmpdir(), "产品 周会 2026-08-31.webm");
  const output = join(tmpdir(), "会议 音频", "产品 周会.mp3");

  it("argv 逐个元素对得上，中文和空格的路径是完整的一个元素", async () => {
    stub(() => ({ code: 0 }));

    const out = await transcodeToMp3(input, output);

    expect(calls).toHaveLength(1);
    expect(calls[0].bin).toBe("ffmpeg");
    expect(calls[0].args).toEqual(["-y", "-i", resolve(input), "-vn", "-ac", "1", "-ar", "16000", "-b:a", "64k", resolve(output)]);
    expect(calls[0].args.filter((a) => a.includes("产品 周会"))).toEqual([resolve(input), resolve(output)]);
    expect(out).toBe(resolve(output));
    // 输出目录第一次跑一定不存在
    expect(mkdirMock).toHaveBeenCalledWith(dirname(resolve(output)), { recursive: true });
  });

  it("输出名不是 .mp3 就补上 —— ffmpeg 按后缀挑封装格式", async () => {
    stub(() => ({ code: 0 }));
    const out = join(tmpdir(), "会议 音频", "rec-tmp");
    expect(await transcodeToMp3(input, out)).toBe(`${resolve(out)}.mp3`);
    expect(calls[0].args.at(-1)).toBe(`${resolve(out)}.mp3`);
  });

  it("FFMPEG_PATH 可以指定可执行文件（PATH 修不好时的出口）", async () => {
    process.env.FFMPEG_PATH = "C:\\tools\\ffmpeg.exe";
    stub(() => ({ code: 0 }));
    await transcodeToMp3(input, output);
    expect(calls[0].bin).toBe("C:\\tools\\ffmpeg.exe");
  });
});

describe("toVoiceprintPcm 的命令拼装", () => {
  const input = join(tmpdir(), "会议 音频", "recording.mp3");
  const output = join(tmpdir(), "声纹 临时", "clip.pcm");

  it("整段转 16 kHz 单声道 s16le 裸 PCM，-t 截到上限", async () => {
    stub(() => ({ code: 0 }));
    await toVoiceprintPcm(join(tmpdir(), "upload"), output, { maxSeconds: 30 });
    expect(calls[0].args).toEqual(["-y", "-i", resolve(join(tmpdir(), "upload")), "-vn", "-ac", "1", "-ar", "16000", "-t", "30", "-f", "s16le", "-acodec", "pcm_s16le", resolve(output)]);
    expect(mkdirMock).toHaveBeenCalledWith(dirname(resolve(output)), { recursive: true });
  });

  it("按时间段截：aselect 取这几段再 asetpts 接成连续的一段", async () => {
    stub(() => ({ code: 0 }));
    await toVoiceprintPcm(input, output, { maxSeconds: 15, segments: [{ startMs: 1200, endMs: 3400 }, { startMs: 10000, endMs: 22500 }] });
    expect(calls[0].args).toEqual([
      "-y", "-i", resolve(input), "-vn",
      "-af", "aselect='between(t,1.200,3.400)+between(t,10.000,22.500)',asetpts=N/SR/TB",
      "-ac", "1", "-ar", "16000", "-t", "15", "-f", "s16le", "-acodec", "pcm_s16le", resolve(output),
    ]);
  });

  it("非零退出带 stderr 尾巴", async () => {
    stub(() => ({ code: 1, stderr: "upload: Invalid data found when processing input\n" }));
    const err = await toVoiceprintPcm(input, output, { maxSeconds: 30 }).catch((e: unknown) => e);
    expect((err as Error).message).toContain("Invalid data found");
  });
});

describe("transcodeToMp3 的失败分类", () => {
  const input = join(tmpdir(), "坏 文件.webm");
  const output = join(tmpdir(), "out.mp3");

  it("ENOENT 是「没装」，不是「转码失败」，消息里写清怎么装", async () => {
    stub(() => ({ error: enoent() }));
    const err = await transcodeToMp3(input, output).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MediaToolsMissing);
    expect((err as Error).message).toContain("winget install Gyan.FFmpeg");
    expect((err as Error).message).toContain("重开终端");
    expect((err as Error).message).toContain("apk add --no-cache ffmpeg");
  });

  it("非零退出：消息里带 stderr 的尾巴，横幅不进来", async () => {
    const banner = "ffmpeg version 7.1 Copyright (c) 2000-2026\n" + "  configuration: --一堆开关\n".repeat(80);
    const real = "坏 文件.webm: Invalid data found when processing input";
    stub(() => ({ code: 1, stderr: `${banner}${real}\n` }));

    const err = await transcodeToMp3(input, output).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(MediaToolsMissing);
    const msg = (err as Error).message;
    expect(msg).toContain(real);
    expect(msg).toContain("退出码 1");
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
