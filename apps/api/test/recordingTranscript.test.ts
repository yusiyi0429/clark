/**
 * 识别结果 → 候选 turns。钉的是没有症状的几件事（说话人编号部分移植自概念版 transcript.test.ts）：
 * 厂商从 0 起编号时不能出现「说话人 0」；编号按第一次开口的先后；offset 不回退（确认时会校验发言顺序）。
 */
import { describe, expect, it } from "vitest";
import { MAX_TRANSCRIPT_TURNS, MAX_TURN_TEXT_LENGTH } from "../src/transcriptMarkdown.js";
import { recordingFileName, speakerLabels, utterancesToTurns } from "../src/recordingTranscript.js";
import type { RecordingUtterance } from "../src/volcAsr.js";

const u = (idx: number, speakerId: string, startMs: number, text: string): RecordingUtterance => ({ idx, speakerId, startMs, endMs: startMs + 1000, text });

describe("speakerLabels", () => {
  it("厂商给 0 和 1 时，是「说话人 1」「说话人 2」，不是「说话人 0」", () => {
    const labels = speakerLabels([u(0, "0", 0, "甲"), u(1, "1", 1000, "乙")], []);
    expect(labels.get("0")).toBe("说话人 1");
    expect(labels.get("1")).toBe("说话人 2");
  });

  it("非数字编号也按开口次序编；次序按 idx，不按数组存储顺序", () => {
    const labels = speakerLabels([u(1, "speaker_7", 5000, "后说的"), u(0, "speaker_2", 1000, "先说的")], []);
    expect(labels.get("speaker_2")).toBe("说话人 1");
    expect(labels.get("speaker_7")).toBe("说话人 2");
  });

  it("已定死的名字（未标注）优先，不编成一个不存在的「说话人 N」", () => {
    const labels = speakerLabels([u(0, "1", 0, "甲"), u(1, "?", 1000, "无主")], [{ speakerId: "1" }, { speakerId: "?", displayName: "未标注" }]);
    expect(labels.get("?")).toBe("未标注");
  });
});

describe("utterancesToTurns", () => {
  it("连续同一个人的句子并成一段，offset 取第一句的开始秒数", () => {
    const turns = utterancesToTurns(
      [u(0, "0", 5_400, "我确认这个方向。"), u(1, "0", 8_000, "先做渠道。"), u(2, "1", 20_900, "我周五前给排期。"), u(3, "0", 35_000, "好。")],
      [],
    );
    expect(turns).toEqual([
      { speakerName: "说话人 1", offsetSeconds: 5, text: "我确认这个方向。先做渠道。" },
      { speakerName: "说话人 2", offsetSeconds: 20, text: "我周五前给排期。" },
      { speakerName: "说话人 1", offsetSeconds: 35, text: "好。" },
    ]);
  });

  it("offset 不回退：时间戳乱序或缺失（0）时沿用上一段", () => {
    const turns = utterancesToTurns([u(0, "0", 10_000, "甲"), u(1, "1", 0, "乙"), u(2, "0", 9_000, "丙")], []);
    expect(turns.map((t) => t.offsetSeconds)).toEqual([10, 10, 10]);
  });

  it("一段超过正文上限时另起一段，不截断任何一句", () => {
    const long = "字".repeat(MAX_TURN_TEXT_LENGTH - 10);
    const turns = utterancesToTurns([u(0, "0", 0, long), u(1, "0", 1000, "再说二十个字再说二十个字再说二十个字")], []);
    expect(turns).toHaveLength(2);
    expect(turns[1].text).toBe("再说二十个字再说二十个字再说二十个字");
    expect(turns.every((t) => t.text.length <= MAX_TURN_TEXT_LENGTH)).toBe(true);
  });

  it("合并后仍超过 2000 段：整份拒绝，说清上限", () => {
    const many = Array.from({ length: MAX_TRANSCRIPT_TURNS + 1 }, (_, i) => u(i, i % 2 ? "1" : "0", i * 1000, "嗯"));
    expect(() => utterancesToTurns(many, [])).toThrow(/超过会议记录 2000 段的上限/);
  });
});

describe("recordingFileName", () => {
  it("按公司时区显示录音开始时刻：会议录音 9月26日 15:02.mp3", () => {
    expect(recordingFileName(new Date("2026-09-26T07:02:30.000Z"))).toBe("会议录音 9月26日 15:02.mp3");
    expect(recordingFileName(new Date("2026-01-04T16:05:00.000Z"))).toBe("会议录音 1月5日 00:05.mp3");
  });
});
