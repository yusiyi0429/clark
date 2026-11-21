import { Type, type Static } from "@sinclair/typebox";

/**
 * 伙伴的外形：原来的三种横放胶囊（值和浏览器里记的形象一致），加上 Miles —— 一个从小胶囊上沿探出半身的 2D 男孩
 * （用户 10/31 让接入，10/29「先不做 2D 形象」作废），和 C妹 —— 同样探出半身的女生（用户 11/04 让接入）。
 */
export const BuddyForm = Type.Union([
  Type.Literal("classic"),
  Type.Literal("alive"),
  Type.Literal("panda"),
  Type.Literal("miles"),
  Type.Literal("cmei"),
]);

/**
 * 伙伴的性格（11/08 调研后定，新首页设计稿 17.3）：沉稳靠谱（默认）、直言不讳、温和体贴、启发追问。
 * 只改说话的样子，判断不随性格变。11/08 前的四种由迁移 252 换过来：理性冷静并进沉稳靠谱，较真犀利改叫直言不讳，乐观开朗改叫温和体贴。
 */
export const BuddyPersonality = Type.Union([
  Type.Literal("steady"),
  Type.Literal("direct"),
  Type.Literal("warm"),
  Type.Literal("coach"),
]);

/**
 * 本人的伙伴：本人起的名字、选的外形和性格。名字去掉首尾空白后按宽度算 1–12：汉字、全角、大写字母等宽字算 2，
 * 窄字母、数字等算 1（服务端 buddyNameUnits 为准）；这里的 12 个字只是外层上限。
 */
export const Buddy = Type.Object({
  name: Type.String({ minLength: 1, maxLength: 12 }),
  form: BuddyForm,
  /** 可选以兼容分批部署：保存时不带就沿用原来的（新伙伴是沉稳靠谱）；读的时候总会返回。 */
  personality: Type.Optional(BuddyPersonality),
}, { additionalProperties: false });

export const BuddyOrNull = Type.Union([Buddy, Type.Null()]);

export type TBuddyForm = Static<typeof BuddyForm>;
export type TBuddyPersonality = Static<typeof BuddyPersonality>;
export type TBuddy = Static<typeof Buddy>;
