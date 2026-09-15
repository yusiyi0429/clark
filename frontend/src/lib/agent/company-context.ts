/**
 * 给 route 层用的一扇门。
 *
 * `route` 与 UI **不许直接 import `@/lib/graphknowledge`**（spec §5.5）——
 * 那一层的三态语义（命中 / 转纯外部 / 就地失败）只有懂它的调用方才接得对，
 * 而 route 里最容易写出的就是「catch 住一切，少一段上下文而已」。
 * 所以对话路径要用公司上下文，从这里拿。
 */
import type { OntologyMember } from "@/lib/graphknowledge";
import { openOntologyContext } from "@/lib/ontology/context";
import { isOntologyUnavailable } from "@/lib/ontology/errors";
import { lookupOntology } from "@/lib/ontology/lookup";
import { ontologySource } from "@/lib/ontology/source";
import { wrapCompanyNarrative, wrapCompanyStateOnly } from "@/lib/agent/prompts";

/**
 * 这次取上下文的总上限。
 *
 * 一次 S02 装配是十来次**顺序** HTTP（autopick 的 P3 + P1，装配的 P0/P1/P2，
 * 最后一次 P3），而 M7 客户端的超时是**每请求** 30 秒 —— 没有总闸的话，图服务
 * 「慢而不挂」时对话栏会长时间不出字，这种故障最难查。
 *
 * 6 秒是拿实测定的：这台机器上图谱那一层（四层自检，含一次装配）跑 2.7–5.2 秒。
 * 所以正常情况下这道闸不会拦到人，它拦的是发疯。代价写在明处：带上公司上下文
 * 的对话，首字比 `chat/route.ts` 头部写的「第三秒」要晚，这是 CEO 拍过的取舍。
 *
 * 超时之后底下那几个请求还在跑（各自有 30 秒上限），我们只是不再等它 ——
 * 中断整条装配要把 signal 一路透传到 M7 客户端，那是上半那一层的改动。
 */
const CONTEXT_DEADLINE_MS = 6000;

/**
 * 本体叙述那一支的闸，**比上面那道宽一倍**。
 *
 * 不是放松要求，是那一支的正常耗时本来就更长：上游一次调用里自己要跑一遍图检索**再过一遍
 * 模型做压缩**，实测 3.0～6.0 秒。拿 6 秒去卡它，卡到的会是**正常调用** —— 而超时的表现
 * 是这一轮对话悄悄没有公司上下文，屏幕上只有一句「答得有点虚」。一道正常情况下就会拦到人
 * 的闸不是闸，是随机丢材料。
 *
 * 代价照实说：这条路上首字比 6 秒那一档更晚，最坏 12 秒。它仍然值 —— 少一段公司上下文的
 * 回答，一号位当场就感觉得到；多等几秒他知道自己在等什么。
 */
const NARRATIVE_CONTEXT_DEADLINE_MS = 12_000;

/** 注入 prompt 时的包裹。 */
export const wrapCompanyContext = (text: string): string =>
  `以下是公司决策上下文，来自 GraphKnowledge。每行末尾方括号里是该条的锚点。\n\n` +
  `锚点有两种，区别很重要：像 ISS-D6、JDG-01、DOC-05 这样的**短码**可以照原样引用，` +
  `屏幕会把它变成可点开的；而 [member:x][partition:y][source:z] 是图谱内部编号，` +
  `屏幕认不出、点不开 —— 不要把它写进回复，要引用那一条就改写成它对应的那句话。\n\n${text}`;

const TIMED_OUT = Symbol("timeout");

async function withDeadline<T>(work: Promise<T>, ms: number): Promise<T | typeof TIMED_OUT> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<typeof TIMED_OUT>((resolve) => {
        timer = setTimeout(() => resolve(TIMED_OUT), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * 对话路径的公司上下文。取不到就返回 `null`，**由调用方决定要不要继续**。
 *
 * 这里与 A1a/A3/A4 有一处**有意分歧**：图服务连不上时这个函数不抛，只记一句。
 * 理由是产物性质不同 —— 一份少了公司上下文的研究报告看起来和完整的一样，那种
 * 坏产出没人查得出来，所以必须就地失败；而一次对话少一段上下文，一号位当场就
 * 感觉到答得虚，而且让他因为后台某个服务不在而完全对不了话，比少一段糟得多。
 * `company-context.test.ts` 里那个用例锁着这条分歧 —— 它不是漏写的 catch。
 *
 * `note` 里一律带毫秒数：这条路径不落 Run 记录，那行日志是唯一的现场。
 */
export async function companyContextForChat(
  issueTitle: string,
  /**
   * 这条议题挂着的判断号。跟 A3 预研走同一条锚点路 —— 图谱里没有前端这些议题
   * 对象，按标题检索 `ISS-*` 一次都命中不了；而判断在图里是真实存在的。
   * 空数组照旧走检索。
   */
  judgmentCodes: string[] = []
): Promise<{ block: string | null; note: string; members: string[] }> {
  const t0 = Date.now();
  const ms = () => `${Date.now() - t0}ms`;
  // 两支各有各的闸，理由见 `NARRATIVE_CONTEXT_DEADLINE_MS`。
  const deadline =
    ontologySource() === "narrative" ? NARRATIVE_CONTEXT_DEADLINE_MS : CONTEXT_DEADLINE_MS;
  try {
    const opened = await withDeadline(
      openOntologyContext({
        recipe: "S02",
        prefix: "ISS-",
        channel: "A3",
        q: issueTitle,
        judgmentCodes,
        /*
         * 对话取压缩版，**不跟着预研深研一起吃原文**。这条路上首字什么时候出来是产品的
         * 一部分，而原文比压缩版厚一倍多；那一千多字买到的是来源和确认状态，那是写报告
         * 时要的东西，不是当面对话时要的。（口径和 harness 那份 `RAW_NARRATIVE_AGENTS`
         * 是一对，改一处要改两处。）
         */
        includeRaw: false,
      }),
      deadline
    );
    if (opened === TIMED_OUT) {
      return { block: null, note: `取上下文超过 ${deadline}ms，本次不带公司上下文`, members: [] };
    }
    if (opened.mode === "narrative") {
      const text = opened.bundle?.renderedMarkdown ?? "";
      return {
        /*
         * 包的是 `wrapCompanyNarrative`，不是 `wrapCompanyContext`：后者整段在教模型
         * 「短码可以照原样引用」，而这一支一个短码都不回 —— 照抄过来就是教它去引一批
         * 不存在的编号。
         */
        block: text ? wrapCompanyNarrative(text) : null,
        note: text
          ? `本体叙述 ${text.length} 字符（${ms()}）` +
            (opened.warnings.length ? `（告警 ${opened.warnings.length} 条）` : "")
          : `本体叙述回了空正文（${ms()}）`,
        /*
         * 空数组是这条路的事实，不是漏填：叙述接口不回短码，这一轮一个可引的编号都没有。
         * 于是 `turn.ts` 那边的短码机检整轮不报 —— 全是误报的清单等于没有清单。
         */
        members: [],
      };
    }
    if (opened.mode === "external_only") {
      // 前缀故意是中性的：external_only 有两种成因，「图谱里确实没有这条议题」
      // 和「P3 这一次没算出检索结果」。后者写成前者，就是把一次检索故障读成
      // 「这条议题对公司还太新」—— 而 noAnchorReason 本来已经把两者分清楚了。
      const why = `未取到锚点（${ms()}）：${opened.noAnchorReason ?? ""}`;
      /*
       * 锚点没命中也把【公司经营状态】带上。对话这条路上这一段格外值钱：一号位问
       * 「我们现在在哪」这类问题时，它要的就是本期 Outcome 和在版判断，跟他正好在
       * 看哪条议题没关系。原来这里一律回 null，于是那种问题全靠模型的常识回答。
       *
       * 包的是 `wrapCompanyStateOnly`，不是 `wrapCompanyContext`：后者在教模型怎么
       * 引用短码锚点，而这一段一个可引的锚点都没有，那套话在这儿是错的指引。
       */
      if (opened.staticContext) {
        return {
          block: wrapCompanyStateOnly(opened.staticContext),
          note: `${why} —— 只带上【公司经营状态】${opened.staticContext.length} 字符`,
          // 这一段一个可引的锚点都没有 —— 空数组是这条路的事实，不是漏填。
          members: [],
        };
      }
      return { block: null, note: why, members: [] };
    }
    const b = opened.bundle!;
    return {
      /*
       * `memberIds` 也带出去。原来这一栏在这里被扔掉，于是对话这条路上**没有任何一处
       * 知道这一轮到底载入了哪些编号** —— 而 `wrapCompanyContext` 正在教模型「短码可以照
       * 原样引用」。教了它引，却没有一处校验它引的那个号是不是真的载入过。
       */
      members: [...b.memberIds],
      block: wrapCompanyContext(b.renderedMarkdown),
      note:
        `命中 ${b.anchorCode}，${b.memberIds.length} 个对象、${b.renderedMarkdown.length} 字符，${ms()}` +
        (opened.warnings.length ? `（告警 ${opened.warnings.length} 条）` : ""),
    };
  } catch (e) {
    const why = isOntologyUnavailable(e) ? "本体服务不可达" : "取上下文出错";
    return {
      block: null,
      note: `${why}（${ms()}）：${e instanceof Error ? e.message : String(e)}`,
      members: [],
    };
  }
}

/**
 * 轮内从本体取一条的上限。
 *
 * 比开局那道 6 秒闸窄：那一道盖的是一次装配（十来次**顺序** HTTP），这一次只有一到两次
 * 并着发的往返。8 秒是「慢得该放弃」而不是「正常会拦到」的量级 —— 实测图谱那一层整套
 * 装配是 2.7–5.2 秒，单次往返是它的十分之一档。
 *
 * 它还必须明显小于对谈轮内那 30 秒总预算（`talk/tools.ts` 的 `BUDGET.syncTimeoutMs`）：
 * 这一次取回来之后模型还要说话，把 30 秒花光在取材料上，他等到的是一句被截断的回答。
 */
const LOOKUP_DEADLINE_MS = 8000;

/**
 * 叙述那一支轮内的闸。同 `NARRATIVE_CONTEXT_DEADLINE_MS` 的理由：上游一次调用自己要跑
 * 图检索加一次模型压缩，实测 3.0～6.0 秒，8 秒会卡到正常调用。
 *
 * 12 秒仍然明显小于对谈轮内那 30 秒总预算（`talk/tools.ts` 的 `BUDGET.syncTimeoutMs`）——
 * 取回来之后模型还要说话。而 `BUDGET.ontology` 是 2 次，两次都走满是 24 秒：所以这一支
 * 实际上**取一次就该够**，取第二次多半会把这一轮逼到超时那一档。旧路那个「先按语义问一次
 * 有哪几条、再按短码取其中一条」的两步走在这一支上不存在（没有短码），所以额度用不满是
 * 正常的，不是预算配大了。
 */
const NARRATIVE_LOOKUP_DEADLINE_MS = 12_000;

/**
 * 对话路径从本体取几条。**三态照实回，一律不抛。**
 *
 * 和 `companyContextForChat` 是两件事：那一个是回合开始前的一次性预取（按议题标题和判断
 * 号装一份上下文），这一个是**说到一半再去取**。分开的理由不是代码整洁 —— 预取那一次问的
 * 是「这条议题的既有认识是什么」，而这一次问的是「他刚说的这个东西，图里有没有」，两个问题
 * 的入参、预算和失败处理都不一样。
 *
 * 三态必须分开，理由同图谱那扇门：
 *
 *   · `found`       取到了
 *   · `not_found`   图里没有这条 —— **不是故障**。他问的东西公司还没记过，这是常态
 *   · `unavailable` 本体服务连不上或太慢 —— 是故障，但这一轮对话照样要继续
 *
 * 把 `not_found` 报成 `unavailable`，他会去查一个没有故障的服务；反过来更糟 —— 一次真故障
 * 被读成「公司没有这条」，而那句话会被当成结论写进对话。
 *
 * ## 叙述那一支永远回不了 `not_found`
 *
 * 它对任何问句都会回一段公司叙述（实测拿「日本北海道的滑雪场雪质如何」去问，照样回
 * `hit_paths=2` 和 498 字）。所以那一档在这一支上是**结构性缺席**，不是恰好没遇到。
 *
 * 三态照旧留着，不为它改类型：换回旧路那一支时 `not_found` 立刻又是常态，而按当下这个源
 * 把类型收成两态，换回去时 `turn.ts` 那边少的是一个分支 —— 少分支不报错，只是那句「公司
 * 还没记过这条」再也不会说了。
 *
 * 补救在摆给模型看的那一步（`turn.ts` 的 `renderMembers`）和工具说明（`tools.ts`）里，
 * 不在这里按字数之类的判据伪造一个 `not_found`：那是拿我们自己编的判据去回答一个上游没
 * 回答的问题，而错判的样子是「公司明明记过却说没有」。
 */
export type ChatLookup =
  | {
      kind: "found";
      mode: "code" | "semantic" | "narrative";
      items: OntologyMember[];
      recall: string;
      note: string;
      /**
       * 这一批东西的来历，**要摆给模型看的那种**（`note` 是给日志的，两者不同）。
       *
       * 图谱那一支装的是服务端自报的降级；叙述那一支装的是「这段话是上游哪个模型压出来
       * 的」—— 摆到模型面前的不是图里的原话，而对谈里最容易发生的就是把它当原话复述。
       */
      warning?: string;
    }
  | { kind: "not_found"; note: string }
  | { kind: "unavailable"; note: string };

export async function ontologyLookupForChat(query: string): Promise<ChatLookup> {
  const q = (query ?? "").trim();
  // 空问句不打图服务：那一次必然是空结果，而它照样要走一个网络往返和 8 秒预算。
  if (!q) return { kind: "not_found", note: "没给问句" };

  const t0 = Date.now();
  const ms = () => `${Date.now() - t0}ms`;
  const deadline =
    ontologySource() === "narrative" ? NARRATIVE_LOOKUP_DEADLINE_MS : LOOKUP_DEADLINE_MS;
  try {
    const got = await withDeadline(lookupOntology(q), deadline);
    if (got === TIMED_OUT) {
      return { kind: "unavailable", note: `取本体超过 ${deadline}ms，本次没取到` };
    }
    if (got.mode === "narrative") {
      /*
       * **不许走下面那条 `items` 为空就判 not_found 的路。** 这一支的 `items` 永远是空的
       * （没有短码可发），正文在 `recall` 里 —— 照那条路走的话，每一次取本体都会被报成
       * 「公司没记过这条」，而它手上明明有一整段。
       */
      return {
        kind: "found",
        mode: "narrative",
        items: [],
        recall: got.recall,
        note: `取回一段公司叙述 ${got.recall.length} 字（${ms()}）` +
          (got.warning ? `；${got.warning}` : ""),
        // 这一句也要往上走 —— 它是给模型看的（见 `warning` 的注释），不只是日志。
        ...(got.warning ? { warning: got.warning } : {}),
      };
    }
    const how = got.mode === "code" ? "按编号" : "按语义";
    if (!got.items.length) {
      return {
        kind: "not_found",
        note: `${how}取「${got.sent}」，图里没有对应条目（${ms()}）` +
          (got.warning ? `；服务端报了降级：${got.warning}` : ""),
      };
    }
    return {
      kind: "found",
      mode: got.mode,
      items: got.items,
      recall: got.recall,
      note: `${how}取「${got.sent}」，回 ${got.items.length} 条（${ms()}）` +
        (got.warning ? `；服务端报了降级：${got.warning}` : ""),
      ...(got.warning ? { warning: `服务端报了降级：${got.warning}` } : {}),
    };
  } catch (e) {
    /*
     * 这里**不区分**「本体不可达」和别的异常 —— 两者对这一轮对话是同一件
     * 事：没取到，继续说话。原话照实带上，那是唯一的现场（这条路不落 Run 记录）。
     */
    const why = isOntologyUnavailable(e) ? "本体服务不可达" : "取本体出错";
    return { kind: "unavailable", note: `${why}（${ms()}）：${e instanceof Error ? e.message : String(e)}` };
  }
}
