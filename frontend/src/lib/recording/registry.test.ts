/**
 * 录音这张表上的那组纯函数。
 *
 * 这里只钉**错了以后不会报错、只会安静说错话**的那几条：
 *
 *   · **id 的日期段。** 月份少补一个零，`.data/recordings/` 底下那一堆文件名就排不齐，
 *     而运维在目录里找「那天那场会」正是靠肉眼扫这一段。尾部恒长六位同理 —— 长度会变
 *     的话文件名对不齐，且 `rand()` 恰好返回 0 的那一次会短成一位。
 *   · **空标题。** `title` 落空的表现是列表上一行什么都不写，看起来像那条记录坏了。
 *   · **`advance` 抹掉上一次的失败原话。** 不抹的表现最阴：屏幕同时显示「转写中」和
 *     一句上一轮的「转码失败」，读的人只能猜哪句是这一轮的。
 *   · **`noteChunk` 认得 seq 0。** `0` 是 falsy，判空写成 `!rec.lastChunkSeq` 的话第一片
 *     永远存不进去，而它的症状是断线重连时从头重传 —— 结果仍然是对的，只是慢。
 *   · **`byRecent` 不看 `updatedAt`。** 看了的表现是一份三天前的录音改个名字就窜到今天
 *     那场会前面，而列表要回答的问题是「哪天开的会」。
 *   · **`interrupted` 不含 `recording`。** 含了的话重启后会替他把一份只录了三秒的东西
 *     拼片转写 —— 那是替人做决定，且花的是真钱。
 *   · **`toSummary` 不带正文侧的那几格。** 带了不会报错，只是列表接口白白多传一份
 *     参会人和几个内部路径（`rawAudioPath` 还是绝对路径）。
 */
import { describe, expect, it } from "vitest";

import {
  advance,
  byRecent,
  create,
  defaultTitle,
  fail,
  find,
  interrupted,
  isSettled,
  newRecordingId,
  normalizeParticipants,
  noteChunk,
  patch,
  toSummary,
} from "./registry";
import type { Recording, RecordingStatus } from "./types";

/** 一条最小的记录。测哪一格就在 `over` 里盖哪一格。 */
function mk(over: Partial<Recording> = {}): Recording {
  const at = "2026-08-31T06:00:00.000Z";
  return {
    id: "REC-20260831-aaaaaa",
    title: "会议 2026-08-31 14:00",
    source: "live",
    status: "recording",
    startedAt: at,
    participants: [],
    createdAt: at,
    updatedAt: at,
    ...over,
  };
}

describe("newRecordingId", () => {
  it("形如 REC-20260831-xxxxxx，尾部取自传进来的 rand", () => {
    // 0.5 落在 36^6 的正中间，换算成三十六进制是 i00000 —— 这个数是精确的，
    // 用它才能把「尾部确实由 rand 决定」和「碰巧长度对了」分开。
    expect(newRecordingId(new Date(2026, 7, 31, 14, 5), () => 0.5)).toBe(
      "REC-20260831-i00000",
    );
  });

  it("一月五日是 20260105，不是 202615", () => {
    expect(newRecordingId(new Date(2026, 0, 5), () => 0.5)).toBe("REC-20260105-i00000");
  });

  it("rand 返回 0 时尾部仍是六位 000000，不是一位 0", () => {
    expect(newRecordingId(new Date(2026, 7, 31), () => 0)).toBe("REC-20260831-000000");
  });

  it("随便一个 rand，尾部长度恒为 6", () => {
    for (const r of [0, 0.000001, 0.123456, 0.5, 0.9999999]) {
      const id = newRecordingId(new Date(2026, 11, 9), () => r);
      expect(id).toMatch(/^REC-20261209-[0-9a-z]{6}$/);
    }
  });
});

describe("defaultTitle", () => {
  it("逐字符对：会议 2026-08-31 14:05", () => {
    expect(defaultTitle(new Date(2026, 7, 31, 14, 5))).toBe("会议 2026-08-31 14:05");
  });

  it("月、日、时、分四段都补零", () => {
    expect(defaultTitle(new Date(2026, 0, 5, 9, 7))).toBe("会议 2026-01-05 09:07");
  });
});

describe("create", () => {
  const now = new Date(2026, 7, 31, 14, 5);

  it("现场录音一进来是 recording，上传进来的是 uploaded", () => {
    const list: Recording[] = [];
    expect(create(list, { now, source: "live", rand: () => 0.5 }).status).toBe("recording");
    expect(create(list, { now, source: "upload", rand: () => 0.5 }).status).toBe("uploaded");
  });

  it("标题全是空格时落回默认标题，不留一行空白", () => {
    const list: Recording[] = [];
    expect(create(list, { now, source: "live", title: "   " }).title).toBe(
      defaultTitle(now),
    );
    expect(create(list, { now, source: "live", title: "" }).title).toBe(defaultTitle(now));
  });

  it("标题两端的空格去掉，中间的留着", () => {
    const list: Recording[] = [];
    expect(create(list, { now, source: "live", title: "  周一 早会  " }).title).toBe(
      "周一 早会",
    );
  });

  it("createdAt / updatedAt / startedAt 三格都填上，没有一格是空", () => {
    const list: Recording[] = [];
    const rec = create(list, { now, source: "upload" });
    expect(rec.createdAt).toBe(now.toISOString());
    expect(rec.updatedAt).toBe(now.toISOString());
    expect(rec.startedAt).toBe(now.toISOString());
  });

  it("返回的那条确实被 push 进了传进来的数组，不是另造了一份", () => {
    const list: Recording[] = [mk({ id: "REC-old" })];
    const rec = create(list, { now, source: "live" });
    expect(list).toHaveLength(2);
    // 同一个对象引用：后面 patch/advance 改的是列表里那一条，不是一份副本。
    expect(list[1]).toBe(rec);
    expect(find(list, rec.id)).toBe(rec);
  });

  it("参会人进来时就规整过了", () => {
    const list: Recording[] = [];
    const rec = create(list, { now, source: "live", participants: [" 王总 ", "", "王总"] });
    expect(rec.participants).toEqual(["王总"]);
  });
});

describe("patch", () => {
  it("改一格时 updatedAt 跟着刷新，不许停在创建那一刻", () => {
    const list = [mk({ updatedAt: "2026-08-31T06:00:00.000Z" })];
    const later = new Date("2026-08-31T08:30:00.000Z");
    const rec = patch(list, list[0].id, { title: "改过的" }, later);
    expect(rec?.title).toBe("改过的");
    expect(rec?.updatedAt).toBe(later.toISOString());
    expect(rec?.updatedAt).not.toBe("2026-08-31T06:00:00.000Z");
  });

  it("createdAt 不跟着动", () => {
    const list = [mk()];
    patch(list, list[0].id, { title: "改过的" }, new Date("2026-09-01T00:00:00.000Z"));
    expect(list[0].createdAt).toBe("2026-08-31T06:00:00.000Z");
  });

  it("id 不存在时返回 undefined，且数组一个字没动", () => {
    const list = [mk()];
    const before = structuredClone(list);
    expect(patch(list, "REC-不存在", { title: "改过的" }, new Date())).toBeUndefined();
    expect(list).toEqual(before);
  });
});

describe("advance", () => {
  it("从 failed 走到别的档时，failStage 和 error 都被抹掉", () => {
    // 这一条是这个文件里最要紧的：留着上一轮的原话，屏幕会同时说「转写中」和
    // 「转码失败：ffmpeg 不在 PATH 上」，而那两句话里只有一句是这一轮的。
    const list = [
      mk({
        status: "failed",
        failStage: "transcode",
        error: "ffmpeg 不在 PATH 上",
      }),
    ];
    const rec = advance(list, list[0].id, "transcoding", new Date());
    expect(rec?.status).toBe("transcoding");
    expect(rec?.failStage).toBeUndefined();
    expect(rec?.error).toBeUndefined();
  });

  it("extra 里的几格照样写进去", () => {
    const list = [mk()];
    const rec = advance(list, list[0].id, "uploading", new Date(), { durationMs: 6312 });
    expect(rec?.status).toBe("uploading");
    expect(rec?.durationMs).toBe(6312);
  });

  it("id 不存在时返回 undefined", () => {
    expect(advance([mk()], "REC-不存在", "done", new Date())).toBeUndefined();
  });
});

describe("fail", () => {
  it("状态变 failed，倒在哪一段单独一格", () => {
    const list = [mk({ status: "uploading" })];
    const rec = fail(list, list[0].id, "upload", "TOS 拒绝了这次上传：403", new Date());
    expect(rec?.status).toBe("failed");
    expect(rec?.failStage).toBe("upload");
  });

  it("错误原话一个字没被改写", () => {
    // 「处理失败」和「ffmpeg 不在 PATH 上」指向两条完全不同的排查路径，
    // 而前者哪条都不指。这里逐字符对，防的是有人在中间加一层「友好化」。
    const said = "ffmpeg 不在 PATH 上（which ffmpeg 找不到）";
    const list = [mk()];
    expect(fail(list, list[0].id, "transcode", said, new Date())?.error).toBe(said);
  });
});

describe("noteChunk", () => {
  const now = new Date("2026-08-31T06:10:00.000Z");

  it("第一片 seq 0 能把 undefined 变成 0", () => {
    // 0 是 falsy：判空写成 `!rec.lastChunkSeq` 的话这一片永远存不进去，
    // 而症状只是断线重连时白白从头重传一遍，谁也看不出来。
    const list = [mk()];
    expect(list[0].lastChunkSeq).toBeUndefined();
    expect(noteChunk(list, list[0].id, 0, now)?.lastChunkSeq).toBe(0);
  });

  it("同一个 seq 传两次，lastChunkSeq 不变", () => {
    const list = [mk({ lastChunkSeq: 3 })];
    noteChunk(list, list[0].id, 3, now);
    noteChunk(list, list[0].id, 3, now);
    expect(list[0].lastChunkSeq).toBe(3);
  });

  it("乱序到达：先 5 后 2 之后仍然是 5", () => {
    const list = [mk()];
    noteChunk(list, list[0].id, 5, now);
    noteChunk(list, list[0].id, 2, now);
    expect(list[0].lastChunkSeq).toBe(5);
  });

  it("id 不存在时返回 undefined", () => {
    expect(noteChunk([mk()], "REC-不存在", 1, now)).toBeUndefined();
  });
});

describe("normalizeParticipants", () => {
  it("undefined 给空数组，不是 undefined", () => {
    expect(normalizeParticipants(undefined)).toEqual([]);
  });

  it("去空、去重、去前后空格", () => {
    expect(normalizeParticipants([" 王总 ", "", "   ", "王总", "李工"])).toEqual([
      "王总",
      "李工",
    ]);
  });

  it("顺序保持第一次出现的顺序", () => {
    expect(normalizeParticipants(["李工", "王总", "李工", "赵"])).toEqual([
      "李工",
      "王总",
      "赵",
    ]);
  });

  it("trim 之后才判重：「王总」和「王总 」算同一个人", () => {
    expect(normalizeParticipants(["王总", "王总 "])).toHaveLength(1);
  });
});

describe("isSettled", () => {
  it("七档逐个对：只有 done 和 failed 是走完了的", () => {
    const table: [RecordingStatus, boolean][] = [
      ["recording", false],
      ["uploaded", false],
      ["transcoding", false],
      ["uploading", false],
      ["transcribing", false],
      ["done", true],
      ["failed", true],
    ];
    for (const [status, settled] of table) {
      expect(isSettled(status), status).toBe(settled);
    }
  });
});

describe("byRecent", () => {
  it("按 startedAt 倒序", () => {
    const list = [
      mk({ id: "旧", startedAt: "2026-08-20T01:00:00.000Z" }),
      mk({ id: "新", startedAt: "2026-08-31T01:00:00.000Z" }),
      mk({ id: "中", startedAt: "2026-08-28T01:00:00.000Z" }),
    ];
    expect([...list].sort(byRecent).map((r) => r.id)).toEqual(["新", "中", "旧"]);
  });

  it("不看 updatedAt：三天前那场刚改过名字，仍然排在今天那场后面", () => {
    const list = [
      mk({
        id: "三天前开的，刚改过",
        startedAt: "2026-08-28T01:00:00.000Z",
        updatedAt: "2026-08-31T23:59:00.000Z",
      }),
      mk({
        id: "今天开的",
        startedAt: "2026-08-31T01:00:00.000Z",
        updatedAt: "2026-08-31T01:00:00.000Z",
      }),
    ];
    expect([...list].sort(byRecent).map((r) => r.id)).toEqual([
      "今天开的",
      "三天前开的，刚改过",
    ]);
  });
});

describe("interrupted", () => {
  const all = (): Recording[] =>
    (
      [
        "recording",
        "uploaded",
        "transcoding",
        "uploading",
        "transcribing",
        "done",
        "failed",
      ] satisfies RecordingStatus[]
    ).map((status) => mk({ id: status, status }));

  it("recording 不在里面 —— 那是标签页被关掉留下的孤儿，要人按", () => {
    expect(interrupted(all()).map((r) => r.id)).not.toContain("recording");
  });

  it("卡在中间那四档都要接着跑", () => {
    expect(interrupted(all()).map((r) => r.id)).toEqual([
      "uploaded",
      "transcoding",
      "uploading",
      "transcribing",
    ]);
  });

  it("走完的两档不在里面（重跑一次是重新花一次钱）", () => {
    const ids = interrupted(all()).map((r) => r.id);
    expect(ids).not.toContain("done");
    expect(ids).not.toContain("failed");
  });
});

describe("toSummary", () => {
  const full = mk({
    status: "done",
    endedAt: "2026-08-31T07:00:00.000Z",
    durationMs: 6312,
    participants: ["王总", "李工"],
    rawAudioPath: "C:/Users/x/.data/recordings/raw/REC-20260831-aaaaaa.webm",
    audioKey: "recordings/REC-20260831-aaaaaa.mp3",
    asrTaskId: "0d4d1e0a-0000-4000-8000-000000000000",
  });

  it("正文侧那四格一格都不带：参会人、原始路径、对象键、任务 id", () => {
    const s = toSummary(full);
    expect(s).not.toHaveProperty("participants");
    expect(s).not.toHaveProperty("rawAudioPath");
    expect(s).not.toHaveProperty("audioKey");
    expect(s).not.toHaveProperty("asrTaskId");
  });

  it("列表那一行要的几格都在", () => {
    const s = toSummary(full, { speakerCount: 3, utteranceCount: 218 });
    expect(s).toEqual({
      id: full.id,
      title: full.title,
      source: "live",
      status: "done",
      failStage: undefined,
      error: undefined,
      startedAt: full.startedAt,
      endedAt: full.endedAt,
      durationMs: 6312,
      speakerCount: 3,
      utteranceCount: 218,
    });
  });

  it("失败那两格照抄，列表上一眼看得出倒在哪一段", () => {
    const s = toSummary(mk({ status: "failed", failStage: "transcribe", error: "厂商拒绝" }));
    expect(s.failStage).toBe("transcribe");
    expect(s.error).toBe("厂商拒绝");
  });
});
