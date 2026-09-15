/**
 * 排会的纯逻辑。
 *
 * 这个文件只钉一类东西：**错了以后屏幕上不会报错、只会安静地说错话**的那几条。
 *
 *   · **同一天的同一半天只能算出同一个 id。** 这是整个聚类的地基（`slotIdOf`）——
 *     它要是不成立，两件排在同一格的议题会落成两条会，屏幕上画成两块色块，而两块
 *     看着都对，没有任何一处会提示这是同一场。
 *   · **上午必须排在下午前面。** 排序键是自己拼出来的串（`slotOrderKey`），拼错一位
 *     的表现只是日程板上顺序看着有点怪 —— 而他正是照着这个顺序决定明天先谈哪一件。
 *   · **`slotPast` 不是「散会了没有」。** 粒度降到半天之后时钟答不出散会，散会由他按
 *     那一下说（`MeetingSlot.endedAt`）。这两件事一旦被当成一件，会出现「屏幕自己认为
 *     会开完了」而他还没按 —— 于是那颗「标记会议结束」消失，会后那条链路整条走不进去。
 *     这个文件因此要把边界钉死在「这一格在墙上的时间里过去了没有」这一句上。
 *   · **颜色只回答「这两件是不是同一场」。** `seq` 按时间序在数据层算一次
 *     （`slotIndexOf`），各屏共用；各屏自己数的话，同一场会在议题卡片上和日程板上会是
 *     两个颜色，而颜色在这里承担的正是那一句话。
 *   · **参会域是算出来的。** `domainsOfSlot` 错一位的表现是「标了 FE、会上却没有 FE
 *     的议题」——屏幕上完全看不出来是有意还是坏了。
 *   · **议题栏从上往下的四档次序。** 排错档的表现是他打开首页第一眼看到的不是「接下来
 *     要谈的」，而这一屏存在的全部理由就是那一句。
 *
 * 时间一律由调用方给（`now` / `today` 参数），这里不取时钟 —— 取了就没法测，而没法测
 * 的边界正是上面第三条最容易错的地方。
 */
import { describe, expect, it } from "vitest";

import {
  agendaCompare,
  agendaCompareBy,
  bySlotTime,
  dayLabel,
  domainsOfSlot,
  fullDayLabel,
  halfLabel,
  HALVES,
  isHalf,
  nextDay,
  prevDay,
  rankOf,
  slotIdOf,
  slotIndexOf,
  slotLabel,
  slotPast,
  slotTimeError,
  toneOf,
  UNRANKED,
} from "./agenda";
import type { DayHalf, MeetingSlot } from "./types";

const slot = (
  date: string,
  half: DayHalf,
  ids: string[],
  extra?: { extraDomainIds?: string[]; endedAt?: string },
): MeetingSlot => ({
  id: slotIdOf(date, half),
  date,
  half,
  issueIds: ids,
  extraDomainIds: extra?.extraDomainIds ?? [],
  createdAt: "2026-09-01T09:00:00+08:00",
  ...(extra?.endedAt ? { endedAt: extra.endedAt } : {}),
});

describe("一场会的身份就是「哪一天的哪半天」", () => {
  it("同一天的同一半天算出同一个 id —— 聚类的全部实现就是这一句", () => {
    expect(slotIdOf("2026-09-04", "am")).toBe(slotIdOf("2026-09-04", "am"));
  });

  it("上午和下午是两场 —— 一天最多两场，但那两场互不相干", () => {
    expect(slotIdOf("2026-09-04", "am")).not.toBe(slotIdOf("2026-09-04", "pm"));
  });

  it("不同日期的同一半天也是两场", () => {
    expect(slotIdOf("2026-09-04", "am")).not.toBe(slotIdOf("2026-09-05", "am"));
  });

  it("一天只有这两格，而且上午在前 —— 屏幕上那两颗键就是照这个顺序摆的", () => {
    expect(HALVES).toEqual(["am", "pm"]);
    expect(isHalf("am")).toBe(true);
    expect(isHalf("evening")).toBe(false);
  });
});

describe("这一格能不能用，回的是一句能上屏的话", () => {
  it("合法的一格返回 null", () => {
    expect(slotTimeError("2026-09-04", "am")).toBeNull();
    expect(slotTimeError("2026-09-04", "pm")).toBeNull();
  });

  it("半天只有上午和下午 —— 拒的那句话直接就是屏幕上要说的", () => {
    // 抛异常的话，日程板为了问一句「这一格能不能落」就得去 try/catch，而它一秒钟内
    // 要问上十几次（拖着一张卡在两格之间来回移动的时候）。
    expect(slotTimeError("2026-09-04", "evening")).toBe("只能排在上午或下午。");
    expect(slotTimeError("2026-09-04", "")).toBe("只能排在上午或下午。");
  });

  it("坏日期先被挡下来 —— 它会一路拼进 slot id 里，而那时已经看不出来是从哪儿坏的", () => {
    expect(slotTimeError("9/4", "am")).toBe("日期格式不对。");
    expect(slotTimeError("2026-9-4", "am")).toBe("日期格式不对。");
  });
});

describe("按时间先后排", () => {
  it("同一天里上午排在下午前面", () => {
    const list = [
      slot("2026-09-04", "pm", []),
      slot("2026-09-04", "am", []),
    ].sort(bySlotTime);
    expect(list.map((s) => s.half)).toEqual(["am", "pm"]);
  });

  it("跨天按日期，昨天下午仍然排在今天上午前面", () => {
    const list = [
      slot("2026-09-05", "am", []),
      slot("2026-09-04", "pm", []),
    ].sort(bySlotTime);
    expect(list.map((s) => s.id)).toEqual([
      slotIdOf("2026-09-04", "pm"),
      slotIdOf("2026-09-05", "am"),
    ]);
  });
});

describe("屏幕上那行字", () => {
  it("今天、明天、昨天不写星期 —— 这三天他不用去数", () => {
    expect(dayLabel("2026-09-04", "2026-09-04")).toBe("今天");
    expect(dayLabel("2026-09-05", "2026-09-04")).toBe("明天");
    // 会后那一格摊的多半就是昨天那场会，所以「昨天」和前两个一样要紧。
    expect(dayLabel("2026-09-03", "2026-09-04")).toBe("昨天");
  });

  it("跨月的明天和昨天也认 —— 月底那两天是错得最不容易被发现的两天", () => {
    expect(dayLabel("2026-10-01", "2026-09-30")).toBe("明天");
    expect(dayLabel("2026-08-31", "2026-09-01")).toBe("昨天");
  });

  it("再往后写星期加日期", () => {
    // 2026-09-06 是周日。星期由 Date.UTC 算，不取本地时区 —— 服务端和浏览器各算一遍，
    // 差一个时区就是同一场会在两处显示成两个星期几。
    expect(dayLabel("2026-09-06", "2026-09-04")).toBe("周日 9/6");
  });

  it("前后一天跨年也认 —— 这两个函数是上面那三个词的全部依据", () => {
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
    expect(prevDay("2027-01-01")).toBe("2026-12-31");
  });

  it("日程板抬头写全 —— 中文的十几和二十几都要写对", () => {
    // 2026-08-15 是周六、2026-12-11 是周五、2026-09-20 是周日。
    expect(fullDayLabel("2026-08-15")).toBe("八月十五日（周六）");
    expect(fullDayLabel("2026-12-11")).toBe("十二月十一日（周五）");
    expect(fullDayLabel("2026-09-20")).toBe("九月二十日（周日）");
  });

  it("上午下午两个词", () => {
    expect(halfLabel("am")).toBe("上午");
    expect(halfLabel("pm")).toBe("下午");
  });

  it("整场会那一行两处共用一句 —— 议题卡片和日程板不许各写各的", () => {
    expect(slotLabel(slot("2026-09-05", "pm", []), "2026-09-04")).toBe(
      "明天下午",
    );
  });
});

describe("这一格在墙上的时间里过去了没有", () => {
  /*
   * 再说一遍这个函数**不**回答什么：它不回答「散会了没有」。一场排在下午的会可能三点
   * 就散了，也可能拖到晚上，那件事只由他按下的那一下说（`MeetingSlot.endedAt`）。
   *
   * 它只决定两件小事：这一格该不该沉到日程的下面去、那颗「标记会议结束」该不该开始
   * 显眼。所以**判错了不会有任何东西丢失** —— 上午那场十一点五十九分还没「过去」，
   * 也不妨碍他这一刻就去按结束；下午六点这一格「过去了」，会还开着也照样能按。
   */
  it("上午的边界在 12:00", () => {
    const s = slot("2026-09-04", "am", []);
    expect(slotPast(s, { day: "2026-09-04", minutes: 11 * 60 + 59 })).toBe(
      false,
    );
    expect(slotPast(s, { day: "2026-09-04", minutes: 12 * 60 })).toBe(true);
  });

  it("下午的边界在 18:00 —— 上午那格早就过去了，下午那格还没有", () => {
    const pm = slot("2026-09-04", "pm", []);
    const am = slot("2026-09-04", "am", []);
    const now = { day: "2026-09-04", minutes: 17 * 60 + 59 };
    expect(slotPast(am, now)).toBe(true);
    expect(slotPast(pm, now)).toBe(false);
    expect(slotPast(pm, { day: "2026-09-04", minutes: 18 * 60 })).toBe(true);
  });

  it("昨天的两格一律过去了，明天的一律没有", () => {
    expect(
      slotPast(slot("2026-09-03", "pm", []), { day: "2026-09-04", minutes: 0 }),
    ).toBe(true);
    expect(
      slotPast(slot("2026-09-05", "am", []), {
        day: "2026-09-04",
        minutes: 23 * 60,
      }),
    ).toBe(false);
  });
});

describe("颜色按时间序取，相邻两场必不同色", () => {
  it("四种循环", () => {
    // 四种够用：同屏能同时看见的会最多三五场，多出来的色相买不到信息只买到嘈杂。
    expect([0, 1, 2, 3, 4].map(toneOf)).toEqual(["a", "b", "c", "d", "a"]);
  });
});

/*
 * 这个文件里的一只固定的表。
 *
 * `slotIndexOf` 现在要一个「此刻」——「这场会结束了没有」的判据 2026-08-30 从「他按过
 * 那一下没有」扩成了「到点了，或者他按过」（理由整段写在 `slotPast` 上）。夹具全排在
 * 九月，所以把此刻定在 09-01 的上午十点：没标结束的那几场一律还没到点，那正是这些用例
 * 原来的前提。哪一条要验「到点了」，自己再给一只更晚的表。
 */
const NOW = { day: "2026-09-01", minutes: 10 * 60 };

describe("每件议题排在哪一场", () => {
  const slots = [
    slot("2026-09-05", "am", ["ISS-3"]),
    slot("2026-09-04", "pm", ["ISS-1", "ISS-2"]),
  ];

  it("seq 按时间序给，所以同一场会在哪一屏都是同一个颜色", () => {
    const idx = slotIndexOf(slots, NOW);
    expect(idx["ISS-1"].seq).toBe(0);
    expect(idx["ISS-2"].seq).toBe(0);
    expect(idx["ISS-3"].seq).toBe(1);
  });

  it("摘要上带着这一格是哪一天的哪半天 —— 卡片不必回头去问会议表", () => {
    const idx = slotIndexOf(slots, NOW);
    expect(idx["ISS-1"]).toMatchObject({
      slotId: slotIdOf("2026-09-04", "pm"),
      date: "2026-09-04",
      half: "pm",
    });
  });

  it("同一场会里的第几件从 1 起，size 是那场会的总件数", () => {
    const idx = slotIndexOf(slots, NOW);
    expect([idx["ISS-1"].index, idx["ISS-1"].size]).toEqual([1, 2]);
    expect([idx["ISS-2"].index, idx["ISS-2"].size]).toEqual([2, 2]);
    expect([idx["ISS-3"].index, idx["ISS-3"].size]).toEqual([1, 1]);
  });

  /*
   * ## 这一条钉的规则 2026-08-30 换过一次
   *
   * 原来是「`ended` 只是 `endedAt` 的投影，不许拿时钟推」，理由是「一场拖到晚上还没散的
   * 会会提前显示成等你确认，而那时根本没有东西可确认」。
   *
   * 那条理由站不住：粒度就是上午/下午，所以「下午那一格过去了」和「下午那场会散了」在
   * **这个粒度上是同一句话**。而只认那一下按键有一个没有症状的坏法 —— 他忘了按，第二天
   * 那几件议题还躺在「可以排会」的清单里，屏幕上没有一处说得出这场会昨天就该开完了。
   *
   * 现在两条判据取或：到点了算，他提前按了也算。
   */
  it("到点了算结束，他提前按那一下也算", () => {
    const idx = slotIndexOf(
      [
        // 提前散会：还没到十二点，但他按过了。
        slot("2026-09-04", "am", ["ISS-1"], {
          endedAt: "2026-09-04T11:20:00+08:00",
        }),
        // 没人按过，而此刻（09-05 上午十点）已经在这一格之后。
        slot("2026-09-04", "pm", ["ISS-2"]),
        // 没人按过，也还没到。
        slot("2026-09-09", "am", ["ISS-3"]),
      ],
      { day: "2026-09-05", minutes: 10 * 60 },
    );
    expect(idx["ISS-1"].ended).toBe(true);
    expect(idx["ISS-2"].ended).toBe(true);
    expect(idx["ISS-3"].ended).toBe(false);
  });

  it("当天上午那一格，过了十二点就算结束", () => {
    // 边界那一分钟单独钉：`slotPast` 用的是 `>=`，十二点整就算过去了。
    const at = (minutes: number) =>
      slotIndexOf([slot("2026-09-04", "am", ["ISS-1"])], {
        day: "2026-09-04",
        minutes,
      })["ISS-1"].ended;
    expect(at(11 * 60 + 59)).toBe(false);
    expect(at(12 * 60)).toBe(true);
  });
});

describe("这场会有哪几个域到场", () => {
  const domainOf = (issueId: string): string | undefined =>
    ({ A: "D-01", B: "D-01", C: "D-05" })[issueId];

  it("默认是会上那几件议题的域的并集，去重", () => {
    // A 和 B 都在 D-01 上：屏幕上只该出现一枚 D-01 的标记，出现两枚看着像数据脏了。
    expect(
      domainsOfSlot(
        { issueIds: ["A", "B", "C"], extraDomainIds: [] },
        domainOf,
      ),
    ).toEqual(["D-01", "D-05"]);
  });

  it("还没派 DRI 的议题不贡献任何域 —— 那是诚实的空", () => {
    // 编一个域出来的后果是屏幕上写着「FE 到场」，而这场会上根本没有 FE 的事。
    expect(
      domainsOfSlot({ issueIds: ["N"], extraDomainIds: [] }, domainOf),
    ).toEqual([]);
  });

  it("额外请到场的域补在后面，和议题贡献的域重了也不出现两遍", () => {
    expect(
      domainsOfSlot(
        { issueIds: ["A"], extraDomainIds: ["D-07", "D-01"] },
        domainOf,
      ),
    ).toEqual(["D-01", "D-07"]);
  });
});

describe("议题栏从上往下的次序", () => {
  const upcoming = slotIndexOf([slot("2026-09-09", "pm", ["A", "B"])], NOW);
  const mk = (
    id: string,
    ready: boolean,
    updatedAt = "2026-09-01T00:00:00+08:00",
  ) => ({
    id,
    readyForMeeting: ready,
    updatedAt,
    ...(upcoming[id] ? { slot: upcoming[id] } : {}),
  });

  it("四档：没开的会 → 开完的会 → 可开会的 → 还没准备好的", () => {
    /*
     * 这一屏从上往下读的是「接下来」。一场已经开完的会仍然要留在待排的上面（它在等他
     * 确认会后要点，那也是一件压着他的事），但不能压在还没开的会前面 —— 压过去之后
     * 他打开首页第一眼看到的是昨天的事。
     */
    const past = slotIndexOf(
      [
        slot("2026-09-01", "am", ["P"], {
          endedAt: "2026-09-01T11:00:00+08:00",
        }),
        slot("2026-09-09", "pm", ["Q"]),
      ],
      NOW,
    );
    const withSlot = (id: string) => ({
      id,
      readyForMeeting: true,
      updatedAt: "2026-09-01T00:00:00+08:00",
      slot: past[id],
    });
    const list = [withSlot("P"), withSlot("Q"), mk("R", true), mk("S", false)];
    // 时间上 P 在 Q 前面，但 P 那一场已经开完了。
    expect(list.sort(agendaCompareBy(() => UNRANKED)).map((x) => x.id)).toEqual(
      ["Q", "P", "R", "S"],
    );
  });

  it("已开完那一档由 slot.ended 说了算，不再由外面传一个「过去了没有」进来", () => {
    /*
     * 上一版这里收第二个参数（`isPast`），由**调用方各自**拿时钟算。那意味着同一件议题在
     * 服务端和浏览器里可能落在两个不同的档上，而两边看着都是一份正常的清单。
     *
     * 时钟现在又回来了（见上面那一条），但只回到 `slotIndexOf` 里面 —— 排序这一头仍然
     * 只读 `slot.ended` 这一个布尔，判据还是一个。
     */
    const idx = slotIndexOf(
      [
        // 排在明天、但他已经按过结束（会提前开了）——它仍然要沉到没开的那一场下面。
        slot("2026-09-08", "am", ["X"], {
          endedAt: "2026-09-07T20:00:00+08:00",
        }),
        slot("2026-09-09", "pm", ["Y"]),
      ],
      NOW,
    );
    const item = (id: string) => ({
      id,
      readyForMeeting: true,
      updatedAt: "2026-09-01T00:00:00+08:00",
      slot: idx[id],
    });
    expect(
      [item("X"), item("Y")]
        .sort(agendaCompareBy(() => UNRANKED))
        .map((x) => x.id),
    ).toEqual(["Y", "X"]);
  });

  it("同一场会里按那场会自己的议程顺序，不按他拖过的全局顺序", () => {
    // 全局顺序里 B 在前，但 A 是这场会的第一件 —— 会内顺序说了算，否则同一场会的两件
    // 议题在日程板上会以和会议议程相反的顺序摊开。
    const list = [mk("B", true), mk("A", true)];
    expect(list.sort(agendaCompare(["B", "A"])).map((x) => x.id)).toEqual([
      "A",
      "B",
    ]);
  });

  it("他拖过的排在没拖过的前面", () => {
    const list = [mk("D", true), mk("E", true)];
    expect(list.sort(agendaCompare(["E"])).map((x) => x.id)).toEqual([
      "E",
      "D",
    ]);
    expect(rankOf(["E"], "D")).toBe(UNRANKED);
  });

  it("都没拖过时按最近有动静", () => {
    const list = [
      mk("D", true, "2026-09-01T00:00:00+08:00"),
      mk("E", true, "2026-09-02T00:00:00+08:00"),
    ];
    expect(list.sort(agendaCompare([])).map((x) => x.id)).toEqual(["E", "D"]);
  });
});
