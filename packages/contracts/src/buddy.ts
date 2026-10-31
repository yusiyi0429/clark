import { Type, type Static } from "@sinclair/typebox";

/**
 * 伙伴的外形：原来的三种横放胶囊（值和浏览器里记的形象一致），加上 Miles —— 一个从小胶囊上沿探出半身的 2D 男孩
 * （用户 10/31 让接入，10/29「先不做 2D 形象」作废）。
 */
export const BuddyForm = Type.Union([
  Type.Literal("classic"),
  Type.Literal("alive"),
  Type.Literal("panda"),
  Type.Literal("miles"),
]);

/** 本人的伙伴：本人起的名字（去掉首尾空白后 1–12 个字）和选的外形。 */
export const Buddy = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 12 }),
  form: BuddyForm,
}, { additionalProperties: false });

export const BuddyOrNull = Type.Union([Buddy, Type.Null()]);

export type TBuddyForm = Static<typeof BuddyForm>;
export type TBuddy = Static<typeof Buddy>;
