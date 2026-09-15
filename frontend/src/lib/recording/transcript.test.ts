/**
 * 逐字稿落盘的单测。**盯的是三件没有症状的事**：
 *
 * 1. 路径穿越。`deleteTranscript("../../store")` 删掉的是整个对象库，而屏幕上只会显示
 *    「已删除」——它成功了。所以断言不止「抛了」，还要断言那个目标文件**真的还在**。
 * 2. 「说话人 N」里的 N。厂商从 0 起编号时直接拼会得到「说话人 0」，这不会报错、不会
 *    崩，只是每一份逐字稿都少数一个人。
 * 3. 纯文本的格式。逐字符对，包括 `] ` 后面那个空格和全角冒号——这两个错了没人会发现，
 *    直到有人拿这份文本去做 diff 或者喂给别的工具。
 *
 * 时间格式化跨一小时也在这里，理由同类：`Math.floor(total / 60)` 忘了取模的话，一小时
 * 以内全对，一小时零三分显示成 `01:63:00`。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  deleteTranscript,
  readTranscript,
  renameSpeaker,
  speakerLabel,
  toPlainText,
  transcriptPath,
  writeTranscript,
} from "./transcript";
import type { RecordingTranscript } from "./types";

let dir: string;
const prevDataDir = process.env.TKOS_DATA_DIR;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "tkos-transcript-"));
  process.env.TKOS_DATA_DIR = dir;
});

afterEach(() => {
  if (prevDataDir === undefined) delete process.env.TKOS_DATA_DIR;
  else process.env.TKOS_DATA_DIR = prevDataDir;
  rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

/** 厂商从 0 起编号，而且只在句子上带 speaker、不给说话人列表——这是真会遇到的那一档。 */
const sample = (over: Partial<RecordingTranscript> = {}): RecordingTranscript => ({
  recordingId: "REC-20260831-a1b2c3",
  utterances: [
    { idx: 0, speakerId: "0", startMs: 192_000, endMs: 195_000, text: "这一版先不改。" },
    { idx: 1, speakerId: "1", startMs: 220_000, endMs: 224_000, text: "那预算这条呢。" },
    { idx: 2, speakerId: "0", startMs: 224_500, endMs: 226_000, text: "下周说。" },
  ],
  speakers: [{ speakerId: "0", displayName: "王总" }],
  raw: { vendor: "volc", segments: [{ speaker: 0, nested: { deep: [1, 2, 3] } }], nil: null },
  ...over,
});

describe("落盘位置", () => {
  it("落在 .data/recordings/<id>.json，根目录跟对象库同一个", () => {
    expect(transcriptPath("REC-1")).toBe(join(dir, "recordings", "REC-1.json"));
  });
});

describe("写与读", () => {
  it("写了能原样读回来，含 raw 那个 unknown 字段", () => {
    const t = sample();
    writeTranscript(t);
    expect(readTranscript(t.recordingId)).toEqual(t);
  });

  it("原子写不留下 .tmp", () => {
    const t = sample();
    writeTranscript(t);
    expect(existsSync(`${transcriptPath(t.recordingId)}.tmp`)).toBe(false);
  });

  it("重写覆盖已有文件（Windows 上 renameSync 覆盖也要成）", () => {
    writeTranscript(sample());
    writeTranscript(sample({ utterances: [] }));
    expect(readTranscript("REC-20260831-a1b2c3")?.utterances).toEqual([]);
  });

  it("读一个不存在的返回 null，不抛", () => {
    expect(readTranscript("REC-never-written")).toBeNull();
  });

  it("文件内容是垃圾时返回 null、不抛，但要喊一声", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    mkdirSync(join(dir, "recordings"), { recursive: true });
    writeFileSync(transcriptPath("REC-broken"), "{\"utterances\": [ 半个", "utf8");

    expect(readTranscript("REC-broken")).toBeNull();
    expect(err).toHaveBeenCalled();
  });
});

describe("renameSpeaker", () => {
  it("改完能读到新名字", () => {
    writeTranscript(sample());
    expect(renameSpeaker("REC-20260831-a1b2c3", "0", "李总")).toBe(true);
    expect(readTranscript("REC-20260831-a1b2c3")?.speakers).toEqual([
      { speakerId: "0", displayName: "李总" },
    ]);
  });

  /*
   * 定的行为：句子里出现过、但 speakers[] 里没有 —— 补一条。厂商常常只在句子上带
   * speaker，屏幕上那个「说话人 2」是从句子里数出来的，改它必须能成。
   */
  it("speakerId 在句子里出现过但不在 speakers[] 里：补一条，返回 true", () => {
    writeTranscript(sample());
    expect(renameSpeaker("REC-20260831-a1b2c3", "1", "张工")).toBe(true);
    expect(readTranscript("REC-20260831-a1b2c3")?.speakers).toEqual([
      { speakerId: "0", displayName: "王总" },
      { speakerId: "1", displayName: "张工" },
    ]);
  });

  /*
   * 定的行为：哪里都没出现过 —— 不动文件，返回 false。补进去的话库里会多一个没有任何
   * 一句话属于它的说话人，永远显示在列表上且没有入口删掉。
   */
  it("speakerId 哪里都没出现过：返回 false，且文件一个字没动", () => {
    writeTranscript(sample());
    const before = readFileSync(transcriptPath("REC-20260831-a1b2c3"), "utf8");

    expect(renameSpeaker("REC-20260831-a1b2c3", "99", "路人")).toBe(false);
    expect(readFileSync(transcriptPath("REC-20260831-a1b2c3"), "utf8")).toBe(before);
  });

  it("文件不在返回 false", () => {
    expect(renameSpeaker("REC-never-written", "0", "王总")).toBe(false);
  });
});

describe("deleteTranscript", () => {
  it("删掉之后读回是 null", () => {
    writeTranscript(sample());
    deleteTranscript("REC-20260831-a1b2c3");
    expect(readTranscript("REC-20260831-a1b2c3")).toBeNull();
  });

  it("删一个不存在的不抛", () => {
    expect(() => deleteTranscript("REC-never-written")).not.toThrow();
  });
});

describe("路径穿越", () => {
  /** 假装这是对象库那份快照 —— 穿越成功的话它会被读到或者被删掉。 */
  const plantStore = (): string => {
    const f = join(dir, "store.json");
    writeFileSync(f, "{\"state\":\"别动我\"}", "utf8");
    return f;
  };

  it("readTranscript 穿越：抛，且没碰到目标文件", () => {
    const f = plantStore();
    expect(() => readTranscript("../store")).toThrow(/非法的 recordingId/);
    expect(() => readTranscript("../../store")).toThrow(/非法的 recordingId/);
    expect(existsSync(f)).toBe(true);
  });

  it("deleteTranscript 穿越（反斜杠也算）：抛，且目标文件还在", () => {
    const f = plantStore();
    expect(() => deleteTranscript("..\\..\\store")).toThrow(/非法的 recordingId/);
    expect(() => deleteTranscript("../store")).toThrow(/非法的 recordingId/);
    expect(existsSync(f)).toBe(true);
    expect(readFileSync(f, "utf8")).toBe("{\"state\":\"别动我\"}");
  });

  it("绝对路径、盘符、空 id 一样拦掉", () => {
    for (const bad of ["/etc/passwd", "C:\\Windows\\win.ini", "", "a/b", "a.json", "a b"]) {
      expect(() => transcriptPath(bad)).toThrow(/非法的 recordingId/);
    }
  });

  it("正常 id 不误伤", () => {
    for (const ok of ["REC-20260831-a1b2c3", "abc_123", "A"]) {
      expect(() => transcriptPath(ok)).not.toThrow();
    }
  });
});

describe("speakerLabel", () => {
  it("厂商给 0 和 1 时，是「说话人 1」「说话人 2」，不是「说话人 0」", () => {
    const t = sample({ speakers: [] });
    expect(speakerLabel(t, "0")).toBe("说话人 1");
    expect(speakerLabel(t, "1")).toBe("说话人 2");
  });

  it("厂商给非数字编号也照样按开口次序编", () => {
    const t = sample({
      utterances: [
        { idx: 0, speakerId: "speaker_2", startMs: 0, endMs: 1000, text: "甲" },
        { idx: 1, speakerId: "speaker_7", startMs: 1000, endMs: 2000, text: "乙" },
      ],
      speakers: [],
    });
    expect(speakerLabel(t, "speaker_2")).toBe("说话人 1");
    expect(speakerLabel(t, "speaker_7")).toBe("说话人 2");
  });

  it("次序按第一次开口，不按 speakers[] 的顺序，也不按数组存储顺序", () => {
    const t = sample({
      // 存储顺序被打乱：先出现的是 idx=1 那条。按 idx 排的话「1」号先开口。
      utterances: [
        { idx: 1, speakerId: "0", startMs: 5_000, endMs: 6_000, text: "后说的" },
        { idx: 0, speakerId: "1", startMs: 1_000, endMs: 2_000, text: "先说的" },
      ],
      speakers: [],
    });
    expect(speakerLabel(t, "1")).toBe("说话人 1");
    expect(speakerLabel(t, "0")).toBe("说话人 2");
  });

  it("displayName 有就用它", () => {
    expect(speakerLabel(sample(), "0")).toBe("王总");
  });

  it("displayName 是空串时退回编号（空名字不该显示成空白）", () => {
    const t = sample({ speakers: [{ speakerId: "0", displayName: "" }] });
    expect(speakerLabel(t, "0")).toBe("说话人 1");
  });

  it("这份逐字稿里根本没有的 speakerId：给占位，不拿 id 去拼", () => {
    expect(speakerLabel(sample(), "99")).toBe("说话人 ?");
  });
});

describe("toPlainText", () => {
  it("逐字符对：方括号、后面那个空格、全角冒号、一句一行", () => {
    const t = sample({ speakers: [{ speakerId: "0", displayName: "王总" }] });
    expect(toPlainText(t)).toBe(
      "[00:03:12] 王总：这一版先不改。\n" +
        "[00:03:40] 说话人 2：那预算这条呢。\n" +
        "[00:03:44] 王总：下周说。\n"
    );
  });

  it("不合并连续同一个人的句子", () => {
    const t = sample({
      utterances: [
        { idx: 0, speakerId: "0", startMs: 0, endMs: 1000, text: "一" },
        { idx: 1, speakerId: "0", startMs: 4_000, endMs: 5_000, text: "二" },
      ],
      speakers: [],
    });
    expect(toPlainText(t)).toBe("[00:00:00] 说话人 1：一\n[00:00:04] 说话人 1：二\n");
  });

  it("超过一小时的时间戳进位正确，不满一小时也留 00: 前缀", () => {
    const t = sample({
      utterances: [
        { idx: 0, speakerId: "0", startMs: 59_999, endMs: 60_000, text: "不满一分钟" },
        { idx: 1, speakerId: "0", startMs: 3_600_000, endMs: 3_601_000, text: "整一小时" },
        { idx: 2, speakerId: "0", startMs: 5_025_000, endMs: 5_026_000, text: "一小时二十三分四十五秒" },
        { idx: 3, speakerId: "0", startMs: 36_000_000, endMs: 36_001_000, text: "十小时" },
      ],
      speakers: [{ speakerId: "0", displayName: "甲" }],
    });
    expect(toPlainText(t)).toBe(
      "[00:00:59] 甲：不满一分钟\n" +
        "[01:00:00] 甲：整一小时\n" +
        "[01:23:45] 甲：一小时二十三分四十五秒\n" +
        "[10:00:00] 甲：十小时\n"
    );
  });

  it("没有句子时是空串，不是一行空行", () => {
    expect(toPlainText(sample({ utterances: [], speakers: [] }))).toBe("");
  });

  it("写盘读回之后拼出来的文本一样（走一遍真实链路）", () => {
    const t = sample();
    writeTranscript(t);
    const back = readTranscript(t.recordingId);
    expect(back).not.toBeNull();
    expect(toPlainText(back as RecordingTranscript)).toBe(toPlainText(t));
  });
});
