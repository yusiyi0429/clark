import { Type, type Static } from "@sinclair/typebox";

/** 伙伴的外形：三种长条胶囊，加几种 2D 卡通形象（胶囊很难二创）。 */
export const BuddyForm = Type.Union([
  Type.Literal("capsule-classic"),
  Type.Literal("capsule-alive"),
  Type.Literal("capsule-panda"),
  Type.Literal("panda"),
  Type.Literal("cat"),
  Type.Literal("whale"),
  Type.Literal("drop"),
]);

/** 本人的伙伴：本人起的名字（去掉首尾空白后 1–12 个字）和选的外形。 */
export const Buddy = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 12 }),
  form: BuddyForm,
}, { additionalProperties: false });

export const BuddyOrNull = Type.Union([Buddy, Type.Null()]);

export type TBuddyForm = Static<typeof BuddyForm>;
export type TBuddy = Static<typeof Buddy>;
