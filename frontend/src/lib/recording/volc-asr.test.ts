/**
 * 把厂商返回的那坨 JSON 折成我们的形状（`mapResult`）。
 *
 * **这个文件只测这一个纯函数。** 提交和轮询要凭据要网，那两段不在这一轮。
 *
 * 为什么单独把映射钉住：`utterances[].additions.speaker` 这一格**在官方字段说明表里
 * 根本没有定义**，只在返回示例里出现过一次，值是字符串 `"1"`。也就是说这条链路最关键
 * 的一格建立在一段示例上。所以下面每一条防的都是「真数据跟示例长得不一样」的那一刻：
 *
 *   · **缺字段不能丢句子。** 一句没认出说话人的话仍然是这场会说过的话；丢了的表现是
 *     逐字稿里少几句，而没有任何一处会说少了 —— 读的人只会觉得那天好像没说这个。
 *   · **`speaker` 可能是数字。** 示例里是字符串，字段表里没定义，真数据两种都可能。
 *     不折成字符串的话，`"1"` 和 `1` 会变成两个说话人，屏幕上一个人被拆成两个。
 *   · **`idx` 是按进入结果的次序重排的**，不是照抄厂商下标。跳过一句空话之后留个空号，
 *     后面所有按 idx 定位的事（跳转、改说话人）就整体错一位。
 *   · **形状不对时返回空数组，不抛。** 抛出去的表现是整条转写链路倒在最后一步，而钱
 *     已经花了、原文其实还在手上（`RecordingTranscript.raw` 存着）。
 *
 * 样本结构照抄文档里那段真实返回，字段名和层级一个字没改。
 */
import { describe, expect, it } from "vitest";

import { mapResult } from "./volc-asr";

/** 文档里那段返回的形状。`us` 是要塞进 `result.utterances` 的那几条。 */
const doc = (us: unknown[]): unknown => ({
  audio_info: { duration: 6312 },
  result: { text: "刚刚还在想…", utterances: us },
});

/** 一条 utterance。传 `undefined` 的那几格由各条测试自己在返回值上删。 */
const utt = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  additions: { channel_id: "1", speaker: "1" },
  start_time: 480,
  end_time: 5880,
  text: "刚刚还在想…",
  words: [{ confidence: 0, start_time: 480, end_time: 600, text: "刚" }],
  ...over,
});

describe("正常的一条", () => {
  it("一条进一条出，每一格都落在对应的位置上", () => {
    const { utterances, speakers } = mapResult(doc([utt()]));
    expect(utterances).toEqual([
      { idx: 0, speakerId: "1", startMs: 480, endMs: 5880, text: "刚刚还在想…" },
    ]);
    expect(speakers).toEqual([{ speakerId: "1" }]);
  });

  it("正文两端的空格去掉，中间的留着", () => {
    const [u] = mapResult(doc([utt({ text: "  他说 这事 再看看  " })])).utterances;
    expect(u.text).toBe("他说 这事 再看看");
  });

  it("厂商多给的字段（words、channel_id、audio_info）不往下带", () => {
    const [u] = mapResult(doc([utt()])).utterances;
    expect(Object.keys(u).sort()).toEqual(["endMs", "idx", "speakerId", "startMs", "text"]);
  });
});

describe("说话人", () => {
  it("多个说话人时，speakers 按第一次出现的顺序，不多不少", () => {
    // 顺序在这里是有意义的：屏幕上的「说话人 1」是先开口的那个人（见 transcript 的
    // speakerLabel），编号是出现次序而不是厂商给的号。
    const { speakers } = mapResult(
      doc([
        utt({ additions: { speaker: "2" } }),
        utt({ additions: { speaker: "1" } }),
        utt({ additions: { speaker: "2" } }),
        utt({ additions: { speaker: "3" } }),
        utt({ additions: { speaker: "1" } }),
      ]),
    );
    expect(speakers).toEqual([{ speakerId: "2" }, { speakerId: "1" }, { speakerId: "3" }]);
  });

  it("additions 整个不出现时退成 \"1\"，而且这句话仍然进结果", () => {
    const { utterances, speakers } = mapResult(doc([utt({ additions: undefined })]));
    expect(utterances).toHaveLength(1);
    expect(utterances[0].speakerId).toBe("1");
    expect(speakers).toEqual([{ speakerId: "1" }]);
  });

  it("additions 是 null、或者里面没有 speaker：一样退成 \"1\"，句子不丢", () => {
    const { utterances } = mapResult(
      doc([
        utt({ additions: null }),
        utt({ additions: { channel_id: "1" } }),
        utt({ additions: { speaker: "" } }),
      ]),
    );
    expect(utterances).toHaveLength(3);
    expect(utterances.map((u) => u.speakerId)).toEqual(["1", "1", "1"]);
  });

  it("speaker 是数字 1 时也折成字符串 \"1\"，不跟 \"1\" 分成两个人", () => {
    // 字段表里没定义这一格，示例里是字符串。真数据给数字的话，不折的结果是同一个人
    // 在屏幕上被拆成两个说话人。
    const { utterances, speakers } = mapResult(
      doc([utt({ additions: { speaker: 1 } }), utt({ additions: { speaker: "1" } })]),
    );
    expect(utterances.map((u) => u.speakerId)).toEqual(["1", "1"]);
    expect(speakers).toEqual([{ speakerId: "1" }]);
  });
});

describe("时间戳", () => {
  it("缺 start_time / end_time 时退成 0，句子仍然进结果", () => {
    // 点它会跳到开头，比整句丢掉好。
    const { utterances } = mapResult(
      doc([utt({ start_time: undefined, end_time: undefined })]),
    );
    expect(utterances).toHaveLength(1);
    expect(utterances[0].startMs).toBe(0);
    expect(utterances[0].endMs).toBe(0);
  });

  it("不是数字（null、对象、NaN）时也退成 0，不写进 NaN", () => {
    // NaN 一旦进库就会被 JSON.stringify 成 null，而那一格再读出来是 null 不是数字，
    // 坏在离这里很远的地方。
    const { utterances } = mapResult(
      doc([
        utt({ start_time: null, end_time: {} }),
        utt({ start_time: "abc", end_time: Number.NaN }),
      ]),
    );
    expect(utterances.map((u) => [u.startMs, u.endMs])).toEqual([
      [0, 0],
      [0, 0],
    ]);
  });

  it("字符串数字照收，小数四舍五入到整毫秒", () => {
    const [u] = mapResult(doc([utt({ start_time: "480", end_time: 5880.6 })])).utterances;
    expect(u.startMs).toBe(480);
    expect(u.endMs).toBe(5881);
  });
});

describe("空句子", () => {
  it("text 是空串或全空格的那条被跳过", () => {
    const { utterances } = mapResult(
      doc([utt({ text: "" }), utt({ text: "   " }), utt({ text: "有话" })]),
    );
    expect(utterances).toHaveLength(1);
    expect(utterances[0].text).toBe("有话");
  });

  it("跳过之后 idx 是连着的，不留空号", () => {
    // 留空号的表现是后面所有按 idx 定位的事（跳转、改说话人）整体错一位。
    const { utterances } = mapResult(
      doc([
        utt({ text: "第一句" }),
        utt({ text: "  " }),
        utt({ text: "第二句" }),
        utt({ text: "" }),
        utt({ text: "第三句" }),
      ]),
    );
    expect(utterances.map((u) => u.idx)).toEqual([0, 1, 2]);
    expect(utterances.map((u) => u.text)).toEqual(["第一句", "第二句", "第三句"]);
  });

  it("text 不是字符串（数字、null、缺）时同样跳过", () => {
    const { utterances } = mapResult(
      doc([utt({ text: 123 }), utt({ text: null }), utt({ text: undefined })]),
    );
    expect(utterances).toEqual([]);
  });

  it("只有空句子时说话人表也是空的，不留一个凭空的说话人", () => {
    const { speakers } = mapResult(doc([utt({ text: "" })]));
    expect(speakers).toEqual([]);
  });
});

describe("idx", () => {
  it("按进入结果的次序重排，不照抄厂商下标", () => {
    // 厂商那边给了 index 之类的东西也不用它 —— 我们跳过了空句子，两边的号对不上。
    const { utterances } = mapResult(
      doc([
        utt({ index: 7, text: "甲" }),
        utt({ index: 2, text: "乙" }),
        utt({ index: 99, text: "丙" }),
      ]),
    );
    expect(utterances.map((u) => u.idx)).toEqual([0, 1, 2]);
    expect(utterances.map((u) => u.text)).toEqual(["甲", "乙", "丙"]);
  });
});

describe("形状不对时", () => {
  it("result 缺失、result 是 null、utterances 不是数组：都给空，不抛", () => {
    for (const raw of [
      { audio_info: { duration: 6312 } },
      { result: null },
      { result: {} },
      { result: { utterances: null } },
      { result: { utterances: "刚刚还在想…" } },
      { result: { utterances: {} } },
    ]) {
      expect(() => mapResult(raw)).not.toThrow();
      expect(mapResult(raw)).toEqual({ utterances: [], speakers: [] });
    }
  });

  it("raw 是 null / undefined / 字符串 / 数字：一律空数组，不抛", () => {
    // 网关返回一段 HTML 错误页、或者 body 是空的，走到这里就是这几种形状。
    for (const raw of [null, undefined, "", "<html>502</html>", 0, 42, true, []]) {
      expect(() => mapResult(raw)).not.toThrow();
      expect(mapResult(raw)).toEqual({ utterances: [], speakers: [] });
    }
  });

  it("utterances 里混进字符串、数字、布尔、空对象：跳过那几条，好的那条还在", () => {
    const { utterances } = mapResult(doc(["一句话", 42, true, {}, utt({ text: "真的那句" })]));
    expect(utterances).toHaveLength(1);
    expect(utterances[0].text).toBe("真的那句");
    expect(utterances[0].idx).toBe(0);
  });

  it("utterances 里混进 null / undefined：跳过，不抛，好的那条还在", () => {
    /*
     * 这一条钉的是一个真出现过的洞：循环里 `item as {...}` 之后直接读属性，元素是
     * nullish 时那一读就 TypeError。别的垃圾形状（上一条）读属性只得到 undefined，
     * 唯独 nullish 会炸 —— 而炸在这里的代价是钱已经花了、厂商的原文就在手上，
     * 却因为一个空元素连一句都没存下。
     */
    for (const junk of [null, undefined]) {
      const { utterances } = mapResult(doc([junk, utt({ text: "真的那句" })]));
      expect(utterances).toHaveLength(1);
      expect(utterances[0].text).toBe("真的那句");
      expect(utterances[0].idx).toBe(0);
    }
  });

  it("只有一部分句子取不到说话人：那几句单独归一号，不许安到 1 号头上", () => {
    /*
     * 塞给「1 号」的话，几句无主的话会被安到一个真实存在的人头上，而屏幕上没有任何
     * 一处说它是猜的。名字直接定死成「未标注」，免得 `speakerLabel` 把它编成一个
     * 不存在的「说话人 N」。
     */
    const { utterances, speakers } = mapResult(
      doc([
        utt({ text: "甲说的", additions: { speaker: "1" } }),
        utt({ text: "没人认领", additions: {} }),
        utt({ text: "乙说的", additions: { speaker: "2" } }),
      ]),
    );
    expect(utterances.map((u) => u.speakerId)).toEqual(["1", "?", "2"]);
    expect(speakers).toContainEqual({ speakerId: "?", displayName: "未标注" });
  });

  it("全都取不到说话人：整份退成一个人，每一句都还在", () => {
    /*
     * 全都取不到 = 我们猜的字段名不对。那时退成单人是对的：屏幕上说话人数显示 1，
     * 一眼看得出不对，而一句话都没丢 —— 原文还在 `raw` 里，改完映射能重放。
     */
    const { utterances, speakers } = mapResult(
      doc([utt({ text: "第一句", additions: {} }), utt({ text: "第二句", additions: {} })]),
    );
    expect(utterances.map((u) => u.speakerId)).toEqual(["1", "1"]);
    expect(speakers).toEqual([{ speakerId: "1" }]);
  });
});
