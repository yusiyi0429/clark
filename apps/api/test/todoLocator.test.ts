import { describe, expect, it } from "vitest";
import { locateTodo, mentionedPeople, nameForms, timeWindows, type OpenTodo } from "../src/delivery/todoLocator.js";
import { reviewPeriod } from "../src/conversationEntries.js";

const NOW = new Date("2026-10-18T02:00:00Z"); // 北京时间 10/18（周日）10:00
const day = (windows: { from: Date; to: Date }[] | null) => windows && windows.map((window) => [window.from.toISOString(), window.to.toISOString()]);
const MONDAY = new Date("2026-10-19T02:00:00Z");
const people = [{ personId: "jj", displayName: "唐巨杰" }, { personId: "sy", displayName: "于斯一" }, { personId: "xn", displayName: "陈溪南" }];
const todo = (requestId: string, initiatorId: string, initiatorName: string, title: string, at: string): OpenTodo =>
  ({ requestId, kind: "relay", title, body: "", initiatorId, initiatorName, sentAt: new Date(at) });

describe("定位待办的确定性规则", () => {
  it("时间前后各放宽一天（北京时间日历日）；只说周几时取最近已经过去的那天", () => {
    expect(day(timeWindows("昨天", NOW))).toEqual([["2026-10-15T16:00:00.000Z", "2026-10-18T16:00:00.000Z"]]);
    expect(day(timeWindows("周二发的", NOW))).toEqual([["2026-10-11T16:00:00.000Z", "2026-10-14T16:00:00.000Z"]]);
    expect(day(timeWindows("上周", NOW))).toEqual([["2026-10-03T16:00:00.000Z", "2026-10-12T16:00:00.000Z"]]);
    expect(day(timeWindows("10月1号", NOW))).toEqual([["2026-09-29T16:00:00.000Z", "2026-10-02T16:00:00.000Z"]]);
    expect(day(timeWindows("三天前", NOW))).toEqual([["2026-10-13T16:00:00.000Z", "2026-10-16T16:00:00.000Z"]]);
    expect(timeWindows("帮我问问截图怎么放", NOW)).toBeNull();
    // 「上周五」两种理解：周日说是 10/9（日历周）或 10/16（最近的周五）；周一说两种都是 10/16。上上周五只有一种。
    expect(day(timeWindows("上周五", NOW))).toEqual([["2026-10-07T16:00:00.000Z", "2026-10-10T16:00:00.000Z"], ["2026-10-14T16:00:00.000Z", "2026-10-17T16:00:00.000Z"]]);
    expect(day(timeWindows("上周五", MONDAY))).toEqual([["2026-10-14T16:00:00.000Z", "2026-10-17T16:00:00.000Z"]]);
    expect(day(timeWindows("上上周五", NOW))).toEqual([["2026-09-30T16:00:00.000Z", "2026-10-03T16:00:00.000Z"]]);
  });

  it("叫法与读音：全名、名字、杰哥、老唐、唐总；人名里的字只按它在名字里的读音比", () => {
    expect(nameForms("唐巨杰")).toEqual(expect.arrayContaining(["唐巨杰", "巨杰", "杰哥", "老唐", "唐总"]));
    expect(mentionedPeople("居杰让我填的", people).map((person) => person.personId)).toEqual(["jj"]);
    // 「南」在人名里读 nan，「那个」不是「南哥」；「是一张表」只在模糊同音上像「斯一」，原话里不算。
    expect(mentionedPeople("那个表帮我问问", people, 2)).toEqual([]);
    expect(mentionedPeople("这是一张表", people, 2)).toEqual([]);
  });

  it("说了人就只在这个人发来的里找，对不上如实说没有并带上他别的待办；还剩几件时只有一件说得上才定位", () => {
    const todos = [todo("a", "jj", "唐巨杰", "填备案信息表", "2026-10-17T08:20:00Z"), todo("b", "sy", "于斯一", "整理访谈记录", "2026-10-17T03:00:00Z"),
      todo("c", "jj", "唐巨杰", "补合同扫描件", "2026-10-09T03:00:00Z")];
    expect(locateTodo({ message: "昨天陈溪南发的表帮我问问", todos, people, now: NOW })).toMatchObject({ status: "none", person: "陈溪南", nearMisses: [] });
    expect(locateTodo({ message: "巨杰10月1号发的合同帮我问问", todos, people, now: NOW })).toMatchObject({ status: "none", person: "唐巨杰", nearMisses: [{ requestId: "a" }, { requestId: "c" }] });
    expect(locateTodo({ message: "昨天那个记录帮我问问", todos, people, now: NOW })).toMatchObject({ status: "one", todo: { requestId: "b" } });
    expect(locateTodo({ message: "昨天那个帮我问问", todos, people, now: NOW })).toMatchObject({ status: "many", total: 2 });
    // 模型摘出的「财务」不是人名，不当成说到了某个人。
    expect(locateTodo({ message: "昨天那个表帮我问问", hints: { person: "财务" }, todos, people, now: NOW })).toMatchObject({ status: "one", todo: { requestId: "a" } });
  });

  it("复盘月份：只说月份时取最近的那个", () => {
    expect(reviewPeriod("10", NOW)).toBe("2026-10");
    expect(reviewPeriod("12月", NOW)).toBe("2025-12");
    expect(reviewPeriod("2026-09", NOW)).toBe("2026-09");
    expect(reviewPeriod("这个月", NOW)).toBeNull();
  });
});
