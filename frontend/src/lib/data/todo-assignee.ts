/**
 * 把会后待办上那个自由文本的 `owner` 解析成「这是不是一号位自己」。
 *
 * 这一版只判一号位这一条，不判任何别人 —— 右栏这一版要回答的问题只有「这件事是不是
 * 我的」，认出「这是白田田的」对这一版没有任何用处，却要多担一份「认错人」的风险
 * （见 `AGENTS.md` 之外，规格那份文档里的判 —— `assignedTo` 从相三挪到相二那条）。
 *
 * ## 为什么不做包含匹配
 *
 * 「问一下刘明华」里确实出现了这四个字，但这句话不是在指派，是在提一句要联系他。
 * 包含匹配会把这种转写里顺口带到名字的句子也判成「这是他的事」——而这条链路最坏
 * 的错就是把一件事安到一个没接过它的人头上，屏幕上那一行和真派过一模一样，本人却
 * 根本不知道。所以只认 `trim()` 之后**整条相等**，不做子串搜索。
 *
 * ## 为什么不把「刘明华」写死在这里
 *
 * 一号位是谁由人表（`seed-tokenking.ts`）说了算，不是由这个文件说了算。人换了，
 * 这里要跟着换，而它跟着的应该是人表，不是这个文件里的一个字符串字面量。
 */
import { VIEWER_ID, people } from "./seed-tokenking";

import type { TodoAssignee } from "./types";

const CEO_NAME = people.find((p) => p.id === VIEWER_ID)!.name;

/**
 * 一号位在转写里自陈的说法，只有这几种。
 *
 * 白名单只列这几个词，是因为**转写里一号位自陈的说法就这几种**——多列一个词，
 * 就是多给「把别人说的一句话当成他自己的话」留一分空子。「我们」故意不算：那是在
 * 说一群人，不是在说他一个人接下了这件事。
 */
const FIRST_PERSON_ALIASES: readonly string[] = ["我", "我来", "我自己", "一号位"];

/**
 * 解析会后待办的 `owner`。解不出就是 `undefined`，这不是一个错误 —— 会上没点名是
 * 正常结果（理由见 `DebriefTodo.owner` 上的注释），这个函数只负责回答「点的这个
 * 名字是不是一号位」。
 *
 * `"CEO"` / `"ceo"` 这两个词特意不认：人表里 `PSN-04` 那个人的**名字**恰好就叫
 * 「CEO」——那是一个「以 CEO 岗位作为直接责任承担方，在位人待确认」的岗位占位符，
 * 不是一号位本人。认下这个词，就会把一件事安到一个占位符头上，而屏幕上看不出区别。
 * 这两个词天然不在一号位的真名和上面那份第一人称白名单里，所以不需要额外的排除
 * 分支，这里只留这段注释，防止以后有人「顺手」把它加进白名单。
 */
export function resolveTodoAssignee(owner: string | undefined): TodoAssignee | undefined {
  const name = owner?.trim();
  if (!name) return undefined;
  if (name !== CEO_NAME && !FIRST_PERSON_ALIASES.includes(name)) return undefined;
  return { personId: VIEWER_ID, name: CEO_NAME, confidence: "explicit" };
}
