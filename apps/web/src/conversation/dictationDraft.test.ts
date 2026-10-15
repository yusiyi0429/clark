import { describe, expect, it } from "vitest";
import {
  anchorOffset,
  applyEdit,
  applyFullPolish,
  applyPolished,
  applySlice,
  createDraft,
  diffText,
  dictatedSpan,
  dropUnstable,
  finalizeDraft,
  freshRange,
  hasDictated,
  polishUnits,
  renderDraft,
  shiftCaret,
  type Draft,
} from "./dictationDraft";
import { RUN_20_SLICES } from "./dictationFixture";

const view = (draft: Draft) => renderDraft(draft).value;
const underlined = (draft: Draft) => {
  const { value, marks } = renderDraft(draft);
  return marks.map((mark) => value.slice(mark.start, mark.end));
};
const feed = (draft: Draft, slices: typeof RUN_20_SLICES, gen = 1) =>
  slices.reduce((current, [type, index, , text]) => applySlice(current, `${gen}:${index}`, text, type === 2), draft);

describe("识别结果合并进输入框（实测消息序列）", () => {
  it("非稳态原地刷新，定稿以定稿为准（三点 → 3点。），下一句接在后面；全程带下划线", () => {
    let draft = createDraft("");
    const seen: string[] = [];
    for (const [type, index, , text] of RUN_20_SLICES) {
      draft = applySlice(draft, `1:${index}`, text, type === 2);
      seen.push(view(draft));
    }
    expect(seen[0]).toBe("文");
    expect(seen[2]).toBe("那");
    expect(seen[15]).toBe("嗯，那个我们今天下午三点开会，呃，就是讨论一下，讨论一下第四季度的预算");
    expect(seen[16]).toBe("嗯，那个我们今天下午3点开会，呃，就是讨论一下，讨论一下第四季度的预算。");
    expect(seen[17]).toBe(`${seen[16]}然`);
    expect(view(draft)).toBe("嗯，那个我们今天下午3点开会，呃，就是讨论一下，讨论一下第四季度的预算。然后呢，请大家提前准备好材料。");
    expect(underlined(draft)).toEqual([view(draft)]);
  });

  it("从光标处插入：原文切成 head / tail，文字只在插入点长", () => {
    let draft = createDraft("开头。结尾", 3);
    draft = applySlice(draft, "1:0", "中间", false);
    expect(view(draft)).toBe("开头。中间结尾");
    draft = applySlice(draft, "1:0", "中间一句。", true);
    draft = applySlice(draft, "1:1", "再一句", false);
    expect(view(draft)).toBe("开头。中间一句。再一句结尾");
    expect(anchorOffset(draft)).toBe("开头。中间一句。再一句".length);
    expect(renderDraft(draft).marks).toEqual([{ start: 3, end: 11 }]);
  });

  it("重连：上一条连接没定稿的那句去掉，已定稿的留着", () => {
    let draft = feed(createDraft(""), RUN_20_SLICES.slice(0, 19));
    expect(view(draft).endsWith("然")).toBe(true);
    draft = dropUnstable(draft, (key) => !key.startsWith("2:"));
    expect(view(draft)).toBe(RUN_20_SLICES[16][3]);
    draft = applySlice(draft, "2:0", "然后呢", false);
    expect(view(draft)).toBe(`${RUN_20_SLICES[16][3]}然后呢`);
  });

  it("停下：还没定稿的按现在的样子收下；没说话时 hasDictated 为假", () => {
    const empty = createDraft("原文");
    expect(hasDictated(empty)).toBe(false);
    const draft = finalizeDraft(applySlice(empty, "1:0", "半句", false));
    expect(draft.pieces.every((piece) => piece.kind === "user" || piece.stable)).toBe(true);
    expect(hasDictated(draft)).toBe(true);
  });
});

describe("听写中用户改字（固定插入点）", () => {
  const base = () => applySlice(applySlice(createDraft("前文。后文", 3), "1:0", "第一句。", true), "1:1", "第二", false);

  it("改在插入点之前（head）：head 更新，识别继续在插入点刷新", () => {
    let draft = applyEdit(base(), "前文改了。第一句。第二后文");
    expect(draft.pieces[0]).toEqual({ kind: "user", text: "前文改了。" });
    draft = applySlice(draft, "1:1", "第二句。", true);
    expect(view(draft)).toBe("前文改了。第一句。第二句。后文");
  });

  it("改在插入点之后（tail）：tail 更新，新句子仍插在 tail 之前", () => {
    let draft = applyEdit(base(), "前文。第一句。第二后文！");
    draft = applySlice(draft, "1:2", "第三。", true);
    expect(view(draft)).toBe("前文。第一句。第二第三。后文！");
  });

  it("碰到听写的句子：那句冻结成用户文字、不再带下划线，之后的结果不覆盖它；新句接在后面", () => {
    let draft = applyEdit(base(), "前文。第1句。第二后文");
    expect(underlined(draft)).toEqual(["第二"]);
    draft = applySlice(draft, "1:0", "第一句。", true);
    expect(view(draft)).toBe("前文。第1句。第二后文");
    draft = applySlice(draft, "1:2", "第三。", true);
    expect(view(draft)).toBe("前文。第1句。第二第三。后文");
  });

  it("在正说着的那句末尾接着打字：那句冻结，同一句后面新说的部分接在打的字后面", () => {
    let draft = applyEdit(base(), "前文。第一句。第二，后文");
    expect(underlined(draft)).toEqual(["第一句。"]);
    draft = applySlice(draft, "1:1", "第二句话说完。", true);
    expect(view(draft)).toBe("前文。第一句。第二，句话说完。后文");
    expect(underlined(draft)).toEqual(["第一句。", "句话说完。"]);
  });

  it("删掉跨 head 和听写句子的一段：合成一段用户文字，插入点在它后面", () => {
    let draft = applyEdit(base(), "前一句。第二后文");
    expect(view(draft)).toBe("前一句。第二后文");
    draft = applySlice(draft, "1:2", "三", false);
    expect(view(draft)).toBe("前一句。第二三后文");
  });

  it("没改（只移动光标）：草稿原样", () => {
    const draft = base();
    expect(applyEdit(draft, view(draft))).toBe(draft);
  });
});

describe("送整理的段落", () => {
  it("每句定稿一段；以改口词开头的句子并进上一句；没定稿的不送", () => {
    let draft = createDraft("");
    draft = applySlice(draft, "1:0", "下午两点开会。", true);
    draft = applySlice(draft, "1:1", "不对，三点。", true);
    draft = applySlice(draft, "1:2", "请准备材料。", true);
    draft = applySlice(draft, "1:3", "然后", false);
    expect(polishUnits(draft)).toEqual([
      { keys: ["1:0", "1:1"], text: "下午两点开会。不对，三点。" },
      { keys: ["1:2"], text: "请准备材料。" },
    ]);
  });

  it("整理好了原地替换、下划线消失；用户改过的那段不替换", () => {
    let draft = applySlice(applySlice(createDraft("问："), "1:0", "嗯，下午三点开会。", true), "1:1", "呃，带上材料。", true);
    const [first, second] = polishUnits(draft);
    draft = applyEdit(draft, "问：嗯，下午三点开会。呃，带上材料！");
    draft = applyPolished(draft, first, "下午三点开会。");
    draft = applyPolished(draft, second, "带上材料。");
    expect(view(draft)).toBe("问：下午三点开会。呃，带上材料！");
    expect(underlined(draft)).toEqual([]);
  });
});

describe("整段整理（停下后）", () => {
  const spoken = () => {
    let draft = applySlice(createDraft("问：结尾", 2), "1:0", "下周有三件事，第一个就是签合同。", true);
    draft = applySlice(draft, "1:1", "第二个就是催回款。", true);
    return applySlice(draft, "1:2", "嗯，第三个对口径。", true);
  };

  it("送整段的范围 = head 与插入点之间（不带输入框原有的文字）；逐句整理换进来的照算", () => {
    let draft = spoken();
    expect(dictatedSpan(draft)).toEqual({ from: 1, to: 4, text: "下周有三件事，第一个就是签合同。第二个就是催回款。嗯，第三个对口径。" });
    draft = applyPolished(draft, polishUnits(draft)[0], "下周有三件事，第一个签合同。");
    expect(dictatedSpan(draft)?.text).toBe("下周有三件事，第一个签合同。第二个就是催回款。嗯，第三个对口径。");
  });

  it("范围里有用户打的或改过的字（包括改了逐句整理过的那句）、还没定稿的句子、什么都没说：不整段整理", () => {
    const draft = spoken();
    expect(dictatedSpan(applyEdit(draft, "问：下周有三件事，第一个就是签合同。第二个就是催回款！嗯，第三个对口径。结尾"))).toBeNull();
    const polished = applyPolished(draft, polishUnits(draft)[0], "下周有三件事，第一个签合同。");
    expect(dictatedSpan(applyEdit(polished, "问：下周有四件事，第一个签合同。第二个就是催回款。嗯，第三个对口径。结尾"))).toBeNull();
    expect(dictatedSpan(applySlice(draft, "1:3", "然后", false))).toBeNull();
    expect(dictatedSpan(createDraft("问：结尾"))).toBeNull();
    // 只改了听写前就有的文字：不影响
    expect(dictatedSpan(applyEdit(draft, "问题：下周有三件事，第一个就是签合同。第二个就是催回款。嗯，第三个对口径。结尾"))?.text).toBe(
      "下周有三件事，第一个就是签合同。第二个就是催回款。嗯，第三个对口径。",
    );
  });

  it("整理好了：范围没动过就整段换上（带换行、无下划线），插入点落在它后面；动过就不换", () => {
    const draft = spoken();
    const span = dictatedSpan(draft)!;
    const listed = "下周有三件事。\n1. 签合同。\n2. 催回款。\n3. 对口径。";
    const next = applyFullPolish(draft, span, listed);
    expect(view(next)).toBe(`问：${listed}结尾`);
    expect(underlined(next)).toEqual([]);
    expect(anchorOffset(next)).toBe(2 + listed.length);
    expect(freshRange(draft, next)).toEqual({ start: 2, end: 2 + listed.length });
    // 再来的同一句识别结果不再覆盖
    expect(view(applySlice(next, "1:1", "第二个就是催回款。", true))).toBe(`问：${listed}结尾`);
    const edited = applyEdit(draft, "问：下周有三件事，第一个就是签合同。第二个就是催回款！嗯，第三个对口径。结尾");
    expect(applyFullPolish(edited, span, listed)).toBe(edited);
    expect(applyFullPolish(draft, span, span.text)).toBe(draft);
  });

  it("淡入范围只算这次新换进来的整理结果", () => {
    const draft = spoken();
    const [first] = polishUnits(draft);
    const once = applyPolished(draft, first, "下周有三件事，第一个签合同。");
    expect(freshRange(draft, once)).toEqual({ start: 2, end: 16 });
    const twice = applyPolished(once, polishUnits(once)[0], "第二个催回款。");
    expect(freshRange(once, twice)).toEqual({ start: 16, end: 23 });
    expect(freshRange(twice, twice)).toBeNull();
  });
});

describe("差异与光标", () => {
  it("diffText 找出被换掉的那一段", () => {
    expect(diffText("abcdef", "abXYef")).toEqual({ start: 2, oldEnd: 4, insert: "XY" });
    expect(diffText("嗯那个", "嗯，那个")).toEqual({ start: 1, oldEnd: 1, insert: "，" });
  });

  it("光标：在改动之前不动，在之后跟着平移，在插入点上跟到新字后面", () => {
    expect(shiftCaret(1, "前文后文", "前文中间后文")).toBe(1);
    expect(shiftCaret(4, "前文后文", "前文中间后文")).toBe(6);
    expect(shiftCaret(2, "前文后文", "前文中间后文")).toBe(4);
  });
});
