/**
 * 流水线那个圈的**开关时机**。这里不测转码、不测上传、不测转写 —— 那三段各有各的
 * 文件，而且都要么调外部程序要么调厂商。
 *
 * 测的只有一件事，因为它是这条链路上唯一一种**没有症状**的坏法：
 *
 *   圈在没活的时候会把自己停掉（常驻定时器会在整天没有录音的机器上每十秒空转）。
 *   于是「把一份录音的状态推回在途」这个动作，单独做是**不够**的 —— 做完还得有人
 *   叫一次 `kick()`。少了那一句，屏幕上什么都不会发生：不报错、不转圈、状态老老实实
 *   写着「排队中」，看起来完全像在排队。2026-08-31 就是这么撞上的：一份 failed 的录音
 *   按重试，接口返回 ok、状态翻回 `uploaded`，然后停在那儿两分钟一动不动，直到重启
 *   服务（`instrumentation.ts` 起跑时 `kick()`）才继续跑完。
 *
 * 所以下面第二条用例把那个洞整个走了一遍：跑完 → 圈自己停 → 只改状态（重试干的事）→
 * 等六轮扫描，断言它**确实一动不动** → 叫 `kick()`（路由补的那一句）→ 它真的重跑了。
 * 第一个断言看着像在测一个 bug 还在，其实是在钉那条规矩：谁把它推回在途，谁负责 kick。
 * 哪天有人把 `stopPipeline()` 从 `scan()` 里拿掉「顺手修好」，这一条会红 —— 而它该红，
 * 因为那样修等于换成一个永不停的空转定时器。
 *
 * 怎么做到不碰 ffmpeg 和网络：给一份 `rawAudioPath` 指着一个不存在的文件。流水线第一步
 * 就会说「这一份的原始音频不在了」并把它标成 `failed` —— 一条真实的、完全在进程内跑完
 * 的路径。**「跑到了」的证据就是状态从 `uploaded` 变成 `failed`。**
 */
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { Recording } from "./types";

/** 假的那张表。`vi.hoisted` 是因为下面 `vi.mock` 的工厂会被提到 import 之前求值。 */
const { table } = vi.hoisted(() => ({ table: [] as unknown[] }));

vi.mock("@/lib/data/store", () => ({
  recordingsTable: () => table,
  persistSoon: () => {},
}));

import { kick, stopPipeline } from "./pipeline";

const list = table as Recording[];

/** `pipeline.ts` 里的 `SCAN_MS`。它不导出，这里照抄一份 —— 改了那边这里会红。 */
const SCAN_MS = 10_000;

/** 一份等着被处理的录音，原始音频指着一个不存在的文件。 */
function pending(): Recording {
  const at = "2026-08-31T06:00:00.000Z";
  return {
    id: "REC-20260831-sd4vc2",
    title: "会议 2026-08-31 14:00",
    source: "upload",
    status: "uploaded",
    startedAt: at,
    rawAudioPath: join(tmpdir(), "tkos-这个文件不存在-9f3c1d.mp3"),
    participants: [],
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * 把挂着的微任务跑完。`run()` 整条都在微任务里（那份文件不在，第一句就抛），而
 * `running.delete` 挂在 `.finally` 上又晚一拍 —— 少 flush 一次，下一轮扫描会以为
 * 这一份还在跑。
 */
const flush = async (): Promise<void> => {
  await vi.advanceTimersByTimeAsync(0);
  await vi.advanceTimersByTimeAsync(0);
};

beforeEach(() => {
  vi.useFakeTimers();
  list.length = 0;
});

afterEach(() => {
  stopPipeline();
  vi.useRealTimers();
});

describe("kick", () => {
  it("叫一下就把在途的那份接上", async () => {
    list.push(pending());

    kick();
    await flush();

    expect(list[0].status).toBe("failed");
    expect(list[0].failStage).toBe("transcode");
    expect(list[0].error).toContain("原始音频不在了");
  });

  it("圈停掉之后光改状态没有人来接，必须再叫一次", async () => {
    list.push(pending());
    kick();
    await flush();
    expect(list[0].status).toBe("failed");

    /* 队列空了。这一次是**定时器**那一轮扫描，它会把圈停掉（kick 那一轮不会）。 */
    await vi.advanceTimersByTimeAsync(SCAN_MS);

    /* 「重试」干的全部事情：状态推回在途，上一次的失败原话抹掉。 */
    Object.assign(list[0], {
      status: "uploaded",
      failStage: undefined,
      error: undefined,
    } satisfies Partial<Recording>);

    await vi.advanceTimersByTimeAsync(SCAN_MS * 6);
    /* ★ 一动不动 —— 屏幕上写着「排队中」，而根本没有人在扫。 */
    expect(list[0].status).toBe("uploaded");

    /* 路由补上的那一句。 */
    kick();
    await flush();
    expect(list[0].status).toBe("failed");
  });
});
