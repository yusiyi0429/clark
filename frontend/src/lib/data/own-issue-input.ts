/**
 * 「我自己有一件事」那个框里收进来的东西 —— 一句话、一整篇、还是一个链接。
 *
 * ## 一个框，三种东西，不给他选
 *
 * 屏幕上没有「这是链接 / 这是文章」的开关。判定在这里做：整段就是一个 URL 就去抓，
 * 长到自己当不了标题就起一个标题，短的原样收下。给他一个开关等于要求他先替系统分类，
 * 而他手上那件事本来是什么样，系统自己看得出来。
 *
 * ## 短的那一支不叫模型
 *
 * 60 字以下原样当标题，一次模型都不调用。这条线是 `Card.headline` 那句「不超过一行
 * 半」换算出来的：短到自己就能当标题，就不该花一次调用、也不该多一句「标题是参谋起
 * 的」——那句话在这里是错的，标题就是他自己写的。**这条线以下的行为和以前一字不差。**
 *
 * ## 起标题这一下挂了，不许挡住立案
 *
 * 他要的是「这件事记下来」，不是「这件事有个好标题」。所以模型那一下失败就回落到原文
 * 首句，并且把 `titleByModel` 落回 false —— 于是详情页那行「标题是参谋起的」自动不出
 * 现，屏幕上是他自己那段话的开头。这是诚实的，也是他认得出来的。
 */
import { callJson, parseJson, str } from "@/lib/agent/json";

import { fetchArticle, looksLikeUrl } from "./fetch-article";

/** 短到自己就能当标题的长度。以上才叫模型。 */
export const TITLE_IT_YOURSELF = 60;
/** 原文最多存这么多字。 */
export const BODY_CAP = 20000;
/** 预研只读前面这么多字（`ensurePreResearch` 用）。 */
export const MATERIAL_FOR_PRE_RESEARCH = 6000;

export type OwnIssueInput = {
  /** 卡面那一行 = 议题标题。 */
  title: string;
  /** 这个标题是小模型起的。屏幕上要标出来（详情页一行小字）。 */
  titleByModel: boolean;
  /**
   * 原文。**他只打了一句话时这里是空的** —— 那一句已经是标题了，同一句话在卡上出现
   * 两遍（大字一遍、小字再一遍）看着像系统坏了。
   */
  body: string;
  /** 他贴的那个链接。抓没抓到都留着 —— 他要的是那篇东西，链接是唯一的凭据。 */
  link: { url: string; host: string } | null;
  /** 要照实交代的那一句：截了多少字 / 链接没抓到 / 正文是粗抽的。 */
  note: string | null;
};

/** 起标题用的那一句系统提示。短，因为它只干一件事。 */
const TITLE_SYSTEM = `你替一号位的参谋给一份材料起一行标题。

只输出 JSON：{"title": "……"}

标题的要求：

- 说清这份材料在讲什么。如果材料本身摆出了一个待决的问题，就写成问句 —— 但不要为了写成问句而编一个材料里没有的问题。
- 12 到 24 个字。它在屏幕上是一行大字，一行半就到顶了。
- 只用材料里有的东西。**一个材料里没有的数字、公司名、时间都不许出现。**
- 不写「关于」「浅析」「深度解读」这类套话，不加书名号，末尾不加句号。
- 引号一律用「」—— 输出是 JSON，裸的 " 会把它弄坏。
- 中英文与数字之间加空格：写「产品 1.0」，不写「产品1.0」。`;

/** 起不出来时的回落：原文第一句，截到 40 字。**不编，只截。** */
const firstSentence = (body: string): string => {
  const flat = body.replace(/\s+/g, " ").trim();
  const cut = flat.search(/[。！？!?\n]/);
  const head = cut > 0 ? flat.slice(0, cut) : flat;
  return head.length > 40 ? `${head.slice(0, 40)}…` : head;
};

/**
 * 叫一次小模型起标题。**永不抛** —— 失败返回 null，由调用处回落。
 *
 * 走 `callJson` 而不是 Harness：这一下没有质量门、不进运营台、也不该在 Run 记录里
 * 占一条（那张表是给 A 系列 agent 的产出用的）。同样的判断在 A2 那条路上已经做过一次。
 */
const titleFor = async (body: string): Promise<string | null> => {
  try {
    const raw = await callJson(
      [
        { role: "system", content: TITLE_SYSTEM },
        // 只递前 4000 字。标题看开头就够了，而他在等这一下。
        { role: "user", content: body.slice(0, 4000) },
      ],
      { slot: "flash", maxTokens: 200, temperature: 0.3, hint: "own.title" },
    );
    const title = str(parseJson<{ title?: unknown }>(raw).title);
    return title.length > 0 ? title.slice(0, 60) : null;
  } catch (e) {
    // 不静默：起标题挂了要在服务端日志里看得见，否则「标题怎么老是原文开头」查不出来。
    console.warn("[tkos:own.title] 起标题失败，回落成原文首句：", e instanceof Error ? e.message : e);
    return null;
  }
};

/** 存进卡里之前先截到上限，并把截掉了多少字说出来。 */
const capBody = (body: string): { body: string; cut: number } => {
  const b = body.trim();
  return b.length > BODY_CAP ? { body: b.slice(0, BODY_CAP), cut: b.length - BODY_CAP } : { body: b, cut: 0 };
};

const joinNotes = (...parts: (string | null)[]): string | null => {
  const kept = parts.filter((p): p is string => Boolean(p && p.trim()));
  return kept.length > 0 ? kept.join(" ") : null;
};

/**
 * 读一遍他递进来的东西，归成一份「卡上要写什么」。
 *
 * 三支的分法见文件头。**任何一支都不抛**（除了空输入，那一条由 `addIssue` 自己挡）：
 * 抓取失败、起标题失败都落成 `note` 写到屏幕上，立案照常。
 */
export async function readOwnIssueInput(raw: string): Promise<OwnIssueInput> {
  const text = raw.trim();

  // ① 整段就是一个链接。
  if (looksLikeUrl(text)) {
    const got = await fetchArticle(text);
    if (!got.ok) {
      // 抓不到，就只剩这个链接本身。**不从 URL 里的字反推一个标题** —— 那是猜，
      // 而猜出来的标题会被他当成参谋读过那篇东西的证据。
      return {
        title: text,
        titleByModel: false,
        body: "",
        link: { url: text, host: got.host },
        note: `没有取到这个链接的正文：${got.why}屏幕上只留着链接本身，参谋没读过它。`,
      };
    }
    const { body, cut } = capBody(got.body);
    const made = await titleFor(body);
    return {
      title: made ?? got.title ?? firstSentence(body),
      titleByModel: made !== null,
      body,
      link: { url: text, host: got.host },
      note: joinNotes(
        `正文是从 ${got.host} 抓下来的，粗抽的 —— 可能夹着页面上的导航文字。`,
        cut > 0 ? `太长，只收了前 ${BODY_CAP} 字，后面还有 ${cut} 字没收。` : null,
      ),
    };
  }

  // ② 一整篇。
  if (text.length > TITLE_IT_YOURSELF) {
    const { body, cut } = capBody(text);
    const made = await titleFor(body);
    return {
      title: made ?? firstSentence(body),
      titleByModel: made !== null,
      body,
      link: null,
      note: joinNotes(cut > 0 ? `太长，只收了前 ${BODY_CAP} 字，后面还有 ${cut} 字没收。` : null),
    };
  }

  // ③ 一句话。原样，不叫模型，也不把它当原文再存一遍。
  return { title: text, titleByModel: false, body: "", link: null, note: null };
}
