/**
 * 把会后待办上那个自由文本的 `owner` 解析成「这是不是一号位」。
 *
 * 值得单测的是**它拒绝什么**，不是它认得什么。这条链路上最坏的错是把一件事安到一个
 * 没接过它的人头上——屏幕上那一行和真派过一模一样，而那个人根本不知道。所以下面
 * 一半的用例在钉「这些一律不算」。
 */
import { describe, expect, it } from "vitest";

import { resolveTodoAssignee } from "./todo-assignee";

const CEO = { personId: "PSN-01", name: "刘明华" };

describe("resolveTodoAssignee", () => {
  it("会上叫了一号位的真名就算", () => {
    expect(resolveTodoAssignee("刘明华")).toEqual({ ...CEO, confidence: "explicit" });
  });

  it("第一人称算 —— 他自己说「我来」的时候，会上点的就是他", () => {
    for (const owner of ["我", "我来", "我自己", "一号位"]) {
      expect(resolveTodoAssignee(owner)).toEqual({ ...CEO, confidence: "explicit" });
    }
  });

  it("没点名就是没点名", () => {
    expect(resolveTodoAssignee(undefined)).toBeUndefined();
    expect(resolveTodoAssignee("")).toBeUndefined();
    expect(resolveTodoAssignee("   ")).toBeUndefined();
  });

  it("别人的名字这一版一律不认 —— 只做一号位这一条判断", () => {
    expect(resolveTodoAssignee("白田田")).toBeUndefined();
    expect(resolveTodoAssignee("孙铭泽")).toBeUndefined();
  });

  /*
   * 人表里 PSN-04 的**名字**就叫「CEO」，而它的 role 是 dri —— 那是一个「以 CEO 岗位
   * 作为直接责任承担方，在位人待确认」的岗位占位符。认这个词就会把事安到一个占位符
   * 头上，而屏幕上看不出区别。
   */
  it("「CEO」这个词不认 —— 人表里那是一个岗位占位符的名字", () => {
    expect(resolveTodoAssignee("CEO")).toBeUndefined();
    expect(resolveTodoAssignee("ceo")).toBeUndefined();
  });

  it("含着一号位名字的长句不算 —— 只认整条 owner 就是那个人", () => {
    expect(resolveTodoAssignee("刘明华和白田田一起")).toBeUndefined();
    expect(resolveTodoAssignee("问一下刘明华")).toBeUndefined();
  });
});
