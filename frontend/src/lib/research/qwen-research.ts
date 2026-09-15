/**
 * 通义深研（`qwen-deep-research`）交回来的一面 url。**这个模块只出 url，不出结论。**
 *
 * 它服务的是 N2′ 那一步：整条链需要的是「外面有哪些页值得抓」，而这件事一次真正的深度
 * 研究比几条检索式答得好 —— 它自己会拆子问题、自己搜好几轮。但**它写的那份报告我们一个
 * 字都不要**：报告里的断言没有台账、没有跨度定位、没有独立性折叠，进不了 `ledger`（HP-1
 * 那条「检索摘要不许进账本」对它同样成立，而它比摘要还远一层 —— 那是模型改写过的话）。
 * 我们只要它路上踩过的地址，正文照旧由 `fetch.ts` 自己抓、由 N3 自己抽。
 *
 * ## 所以拿到 url 就断流
 *
 * 阶段顺序是 `ResearchPlanning → WebResearch → answer`，而 url 在 `WebResearch` 就到齐了，
 * `answer` 才是写报告那一段（也是最慢、最贵的一段）。收完 `WebResearch` 立刻 `abort()`：
 * 省下来的不只是钱，是**墙上时间** —— 深研这一整轮的时间上限是 30 分钟，余量一百多秒
 * （`a4/deadline.ts`），等它把一份要丢掉的报告写完是这条链上最贵的一次等待。
 *
 * ## 只收 `WebResearch` 的 `webSites`，不收 `answer` 的 `references`
 *
 * 两处都是 `{url, title, description}`，但来路差一层，而**这一层正是 `fetch.ts` 白名单在
 * 防的东西**：`webSites` 是通义自己那个检索工具吐出来的，和博查/豆包同一个信任等级；
 * `references` 是模型写报告时挑出来引的 —— 中间隔着「模型读了那些页的正文」。一个被它读到
 * 的页面里写一句「详见 http://…」，就能顺着 `references` 把地址塞进我们的抓取队列，而
 * `fetch.ts` 文件头那条纪律说的正是「抓取目标只能由检索结果决定，不能由页面正文决定」。
 *
 * 断流本身已经让 `answer` 到不了这里，`phase === "WebResearch"` 那一道再挡一次 —— 两道都
 * 是有意的：哪天有人为了别的原因把断流去掉，这一道还在。
 *
 * ## 阶段的取字是**扫出来的**，不是照着字段路径取的
 *
 * 官方文档给全了 `answer` 那一层的形状（`references[]`），但 `WebResearch` 里 `webSites`
 * 挂在哪一级只写了「存在」，没给样例。照猜的路径取，猜错的表现不是报错，是**这一步永远
 * 交零条 url 而整轮照常出稿** —— 也就是这个模块最坏的失败形态：静默变回没有它的样子。
 * 所以这里在 `extra.deep_research` 这棵子树上扫「带 `url` 字段的对象」，扫空了再退一步扫
 * 整帧。多扫到几个不相干的对象没有代价（下面 `keepUrl` 会滤、抓不动的页会进 `failures`），
 * 漏掉整片有。
 *
 * **这个担心不是假想的，2026-09-01 真跑第一次就撞上了**：真回包把阶段放在
 * `output.message.phase`，而文档样例画的是 `extra.deep_research.phase` —— 后者实际是个空
 * 对象 `{}`。照文档取的那一版 `phaseOf` 恒返回空串，于是一条地址都收不到、一个错都不报。
 * 两处都认的写法见 `phaseOf`。
 *
 * ## 端点用通用那个，**不要**用带 WorkspaceId 的
 *
 * 文档里所有样例都是 `https://{WorkspaceId}.cn-beijing.maas.aliyuncs.com/...`，实测这个账号
 * 上打过去是 403 `Endpoint.AccessDenied`；换成通用的 `https://dashscope.aliyuncs.com/api/v1/...`
 * 直接 200。带 `X-DashScope-WorkSpace` 头也被拒（403 `Model.AccessDenied`）—— 也就是说 key
 * 挂在默认空间上，那个业务空间里没有这个模型的权限。
 *
 * 所以 `TKOS_QWEN_RESEARCH_URL` 仍然由环境变量给（换账号、换地域都可能要改），但**默认该填
 * 通用那一个**。填成工作空间那种形状的表现是整步 403，`reason` 里带着原话，不会静默。
 *
 * ## 两步调用是这个模型的合同，不是我们加的
 *
 * 第一次它**反问**（问你要哪个口径、什么时间窗），第二次把 `assistant`(反问)+`user`(回答)
 * 追进 `messages` 才真开跑。反问由 `answerFor` 就地答 —— 不叫模型，答案本来就在主体卡里。
 */

import { readSse, frameJson } from "@/lib/agent/sse";

import type { SearchHit } from "./search";

/** 请求体里的一轮对话。 */
type Turn = { role: "user" | "assistant"; content: string };

export type QwenResearchAccount = {
  /** 走到过的阶段，按出现顺序、去重。零阶段 = 流开了但一帧都没读到。 */
  phases: string[];
  /** 扫出来多少条带 url 的对象。 */
  seen: number;
  /** 过完 `keepUrl` 和去重之后留下多少条。 */
  kept: number;
  /** 它反问的那句话。留着上 trace —— 答得对不对只能靠人读这两句话对出来。 */
  clarify: string;
  /** 两次调用各花了多少毫秒。 */
  ms: { clarify: number; research: number };
};

export type QwenResearchResult = {
  hits: SearchHit[];
  /**
   * 空 = 正常跑完。非空 = 这一次没跑、或者没跑完，**原话在里面**。
   *
   * 和 `search.ts` 的 `SearchProvider.reason` 是同一个约定，理由也是同一个：没配 key、
   * 接口挂了、到点断流，这三件事最后都表现成「这一轮 url 面比预期小」，不把话说出来的话
   * 屏幕上分不出是哪一种。
   */
  reason: string;
  account: QwenResearchAccount;
};

/** 这一步在屏幕和台账上的名字。**一处出处** —— 台账、trace、报告文首说的必须是同一个词。 */
export const QWEN_RESEARCH_LABEL = "通义深研";
/** 填进 `SearchHit.provider`。和 `bocha` / `doubao` / `mock` 并列。 */
export const QWEN_RESEARCH_PROVIDER = "qwen-research";
/**
 * 填进 `SearchHit.matchedQuery`。
 *
 * 这一栏的问题是「这一条是第几轮哪个问法搜来的」，而这几条的答案就是「不是我们搜来的」。
 * 写一句真话比塞一条我们其实没发过的检索式强 —— 后者会让「已搜未得」那张清单上出现
 * 一条从没发出去过的问法（`sweep.ts` 文件头那条纪律）。
 */
export const QWEN_RESEARCH_QUERY = `${QWEN_RESEARCH_LABEL}交回来的地址（本轮未自行检索）`;

/** 模型名。写死 —— 换模型是行为变更，不该由环境变量悄悄发生。 */
const MODEL = "qwen-deep-research";

/**
 * 整个 N2′ 最多占多久。
 *
 * 4 分钟。这个数不是量出来的（还没跑过一整轮真研究），是**倒推的**：它跑在 N1 草稿
 * （265s）+ N2 检索计划（200s）底下，那两步一共 465 秒，所以 240 秒以内它是白搭的车。
 * 超过就断，拿手上已有的那几条走 —— `WebResearch` 是边搜边推流的，断在中间也有货。
 */
const DEFAULT_TIMEOUT_MS = 240_000;

/**
 * 反问那一步**单独一道闸**，不许它吃掉整个预算。
 *
 * 这一步的产物只有一句话（「你要哪个地区、哪个应用领域」），实测几秒钟就说完了。但代码是
 * 把这条流**读到服务端关**为止的 —— 万一它说完之后挂着不关（心跳、KeepAlive），那 240 秒
 * 就全耗在一句问话上，真研究那一次一秒都不剩。而那种耗法的表现是「这一轮种子零条」，跟
 * 「外面没材料」在报告上长得一模一样。
 *
 * 90 秒是估的，不是量的：只发过反问那一步、没量过它多久关流。估高的代价是万一它真的慢，
 * 反问被砍掉一半 —— 那时 `clarify` 是半句话，发回去它多半会再问一轮，`reason` 里看得见。
 */
const CLARIFY_TIMEOUT_MS = 90_000;

/** 一次最多带回几条。够 N3 那几条链吃满（一条链 3 波 × 每波 3 条种子 × 4 条链 = 36）。 */
const MAX_URLS = 60;

/** 出错时回体截多长。同 `search.ts` 的口径。 */
const BODY_CLIP = 400;

const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

const clip = (body: string, key: string): string => {
  const flat = body.replace(/\s+/g, " ").trim();
  return (key ? flat.split(key).join("***") : flat).slice(0, BODY_CLIP);
};

const domainOf = (url: string): string => {
  try {
    return new URL(url).hostname;
  } catch {
    return "";
  }
};

/**
 * 这条地址抓不抓。**这一层是白名单变宽之后补上的那道闸**，见文件头第三节。
 *
 * 挡的四类各有各的理由：
 *  · 非 https —— 明文回来的正文在路上可以被改，而它接着就进台账当证据。
 *  · 带账号密码（`user:pass@host`）—— 那不是一条公开可复现的出处，事后重放取不到同一页。
 *  · 非默认端口 —— 正经的公开材料不挂在 8080 上；这一条同时挡掉内网服务。
 *  · 主机名是 IP、`localhost`、或没有点 —— 内网探测的形状，而这台机器上的抓取器出得去内网。
 *
 * 挡掉的**不记进 `failures`**：那份清单是给「本该抓到却没抓到」用的，混进这些会让人以为
 * 外面的材料比实际少。数量记在 `account.seen - account.kept` 里。
 */
export function keepUrl(raw: string): boolean {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password) return false;
  if (u.port && u.port !== "443") return false;
  const host = u.hostname;
  if (!host.includes(".")) return false;
  // IPv4 字面量。IPv6 进不了这里 —— 它的 hostname 带方括号，上面那条 `.` 已经挡掉了。
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  return true;
}

/* -------------------------------------------------------------------------- */
/* 流里的东西                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 一帧里的 `output`。两种形状都认：`output.message` 和 `output.choices[0].message`。
 *
 * 不是防御过度：DashScope 上这两种形状由 `result_format` 决定，而这个模型的文档两处样例
 * 用的不是同一种。认错的代价是整步静默交零条（文件头第四节那件事）。
 */
function messageOf(frame: unknown): Record<string, unknown> {
  const output = obj(obj(frame).output);
  const direct = obj(output.message);
  if (Object.keys(direct).length) return direct;
  const choices = Array.isArray(output.choices) ? output.choices : [];
  return obj(obj(choices[0]).message);
}

/**
 * 在一棵子树上扫「带 `url` 字段的对象」。见文件头第四节 —— 路径没文档，所以不猜路径。
 *
 * 深度封在 6 层：这棵子树本来就浅，封住是为了一份畸形的回包不会把这里变成一次深递归。
 *
 * 导出只为一件事：真跑探针（`qwen-research.live.test.ts`）要拿真回包喂它一遍，确认这个扫法
 * 在真的那份 JSON 上找得到东西。链上没有第二个调用方。
 */
export function scanSites(node: unknown, out: Record<string, unknown>[], depth = 0): void {
  if (depth > 6 || !node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const x of node) scanSites(x, out, depth + 1);
    return;
  }
  const o = node as Record<string, unknown>;
  if (s(o.url)) out.push(o);
  for (const v of Object.values(o)) scanSites(v, out, depth + 1);
}

/**
 * 这一帧走到哪个阶段了。取不出来返回空字符串 —— 上游那几帧（心跳、状态帧）本来就没有阶段，
 * 而「没有阶段」不该被读成「阶段变了」（那会让下面那一句提前断流）。
 */
export function phaseOf(frame: unknown): string {
  const message = messageOf(frame);
  const extra = obj(message.extra);
  /*
   * **`message.phase` 排第一，因为真回包就是这么给的**（2026-09-01 实测，见文件头第四节
   * 那条真跑记录）。文档里的样例把阶段画在 `extra.deep_research.phase` 上，实际那个位置
   * 是个空对象 `{}` —— 照文档取的话这里恒为空串，于是一条地址都收不到而整轮照常出稿。
   *
   * 另外两处照旧留着：这个模型有快照版本，别的版本或别的地域给的形状不一定和这个账号
   * 上看到的一样，而多认一处的代价是零。
   */
  return s(message.phase) || s(obj(extra.deep_research).phase) || s(extra.phase);
}

/**
 * 报告写出来之前的那几个阶段。走到这几个之外的任何一个 = 它开始写了，我们该走了。
 *
 * 写成白名单而不是 `p === "answer"`：多一个我们没见过的中间阶段名，白名单的表现是提前收工
 * （少几条地址，看得见），黑名单的表现是**一路等到报告写完**（那正是这个模块要省掉的钱和
 * 时间，而且不会有任何一处报错）。
 */
const BEFORE_ANSWER = ["ResearchPlanning", "WebResearch", "KeepAlive"];

/**
 * 正文累加。**增量和全量两种都认**。
 *
 * `incremental_output` 我们请求了，但请求了不等于服务端给 —— 而两种搞混的表现是那句反问
 * 被复读成几倍长，然后原样发回给它当「用户的回答」。判据是 `next` 是不是以已收的为前缀：
 * 是就当全量（换掉），不是就当增量（接上）。
 */
function accumulate(acc: string, next: string): string {
  if (!next) return acc;
  if (!acc) return next;
  return next.startsWith(acc) ? next : acc + next;
}

/* -------------------------------------------------------------------------- */
/* 配置                                                                        */
/* -------------------------------------------------------------------------- */

export type QwenResearchSetup =
  /** 能跑。 */
  | { on: true; url: string; key: string }
  /** 不跑，原话在 `reason` 里。**这是正常结果，不是故障**（同 `providers()`）。 */
  | { on: false; reason: string };

/**
 * 这一轮跑不跑得起来。
 *
 * 地址由环境变量给：地域和账号形态都会让它变（见文件头最后一节 —— 文档写的那种带
 * WorkspaceId 的形状在实测的这个账号上是 403，通用那个才通）。写死在代码里的话，换个账号
 * 就是一条对谁都不对的地址。
 *
 * key 复用 `DASHSCOPE_API_KEY`（这台机器上听和播报用的是同一把，见 `asr/paraformer.ts`），
 * 另给一个 `TKOS_QWEN_RESEARCH_KEY` 做覆盖 —— 哪天研究和语音要分开计费时不用改代码。
 */
export function qwenResearchSetup(): QwenResearchSetup {
  if ((process.env.TKOS_DR_SEED ?? "").trim() === "0") {
    return { on: false, reason: `${QWEN_RESEARCH_LABEL}这一步被 TKOS_DR_SEED=0 关掉了` };
  }
  const url = (process.env.TKOS_QWEN_RESEARCH_URL ?? "").trim();
  const key = (process.env.TKOS_QWEN_RESEARCH_KEY ?? process.env.DASHSCOPE_API_KEY ?? "").trim();
  // 说的是变量名，**不是** key 本身，也不是它的长度或哈希 —— 这句话会进运行记录。
  if (!url) return { on: false, reason: `这台机器没配 TKOS_QWEN_RESEARCH_URL，${QWEN_RESEARCH_LABEL}这一步不跑` };
  if (!key) return { on: false, reason: `这台机器没配 DASHSCOPE_API_KEY，${QWEN_RESEARCH_LABEL}这一步不跑` };
  return { on: true, url, key };
}

/* -------------------------------------------------------------------------- */
/* 跑一次                                                                      */
/* -------------------------------------------------------------------------- */

const emptyAccount = (): QwenResearchAccount => ({
  phases: [],
  seen: 0,
  kept: 0,
  clarify: "",
  ms: { clarify: 0, research: 0 },
});

/**
 * 离线罐头。`TKOS_MODEL_MOCK=1` 的含义是这一轮不出网，对这一步同样成立。
 *
 * 地址用 `example*.com`，和 `MockSearch` 同一套 —— `fetch.ts` 的 `mockPage` 认得它们，
 * 并且按域名尾数分派署名机构，所以离线跑出来的几条种子能分进不同的独立组。
 */
function mockResult(): QwenResearchResult {
  const hits: SearchHit[] = [0, 1, 2].map((i) => ({
    title: `（假材料）${QWEN_RESEARCH_LABEL}种子 ${i + 1}`,
    url: `https://example${i}.com/qwen-seed/${i + 1}`,
    snippet: "这是离线自测用的占位来源，不是真实材料。",
    sourceDomain: `example${i}.com`,
    matchedQuery: QWEN_RESEARCH_QUERY,
    provider: QWEN_RESEARCH_PROVIDER,
  }));
  return { hits, reason: "", account: { ...emptyAccount(), seen: 3, kept: 3, phases: ["WebResearch"] } };
}

/**
 * 发一次，把流读到 `WebResearch` 收尾为止。
 *
 * `stop` 说这一帧之后要不要断。返回读到的东西 —— **断流不是异常**，是这个模块的正常出口。
 */
async function stream(
  setup: { url: string; key: string },
  messages: Turn[],
  timeoutMs: number,
  onFrame: (frame: unknown) => "go" | "stop"
): Promise<{ text: string; aborted: boolean }> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(new Error("timeout")), timeoutMs);
  let aborted = false;
  try {
    const res = await fetch(setup.url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${setup.key}`,
        // 这个模型只支持流式。少这一行拿回来的是一个整包，而整包要等报告写完。
        "X-DashScope-SSE": "enable",
      },
      body: JSON.stringify({
        model: MODEL,
        input: { messages },
        parameters: { incremental_output: true },
      }),
      // 同 `search.ts`：这一层被 Next 缓存的后果不是省钱，是台账上的时间变成假话。
      cache: "no-store",
      signal: ctl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      const tail = clip(body, setup.key);
      throw new Error(`${QWEN_RESEARCH_LABEL}接口返回 HTTP ${res.status}${tail ? `：${tail}` : ""}`);
    }
    if (!res.body) throw new Error(`${QWEN_RESEARCH_LABEL}接口没有回流`);

    let text = "";
    for await (const frame of readSse(res.body)) {
      const data = frameJson(frame);
      if (!data) continue;
      text = accumulate(text, s(messageOf(data).content));
      if (onFrame(data) === "stop") {
        aborted = true;
        // 主动断。上游还在算，但那一段的产物我们不要（文件头第二节）。
        ctl.abort(new Error("got-what-we-need"));
        break;
      }
    }
    return { text, aborted };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 跑一次深研，交回一面 url。
 *
 * **不抛。** 挂了、超时了、一条都没扫到，都折成 `reason` 加一份空/半份 `hits` 走
 * （HP-5：查不到是合法结果）。这一步是加出来的一层，它挂掉不该让整轮深研跟着挂 ——
 * 没有它的时候 N3 本来就自己搜。
 *
 * @param brief    发给它的研究题面（`a4/seed.ts` 的 `buildSeedBrief`）
 * @param answer   它反问之后我们的回答（`a4/seed.ts` 的 `answerFor`）
 */
export async function qwenResearch(
  brief: string,
  answer: string,
  opts: { timeoutMs?: number } = {}
): Promise<QwenResearchResult> {
  if (process.env.TKOS_MODEL_MOCK === "1") return mockResult();

  const setup = qwenResearchSetup();
  if (!setup.on) return { hits: [], reason: setup.reason, account: emptyAccount() };

  const account = emptyAccount();
  const budget = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const started = Date.now();

  // ---- 第一步：让它反问 ----------------------------------------------------
  let clarify = "";
  try {
    // 反问那一步不扫 url（那时候它还没搜），读完即可。
    const r = await stream(
      setup,
      [{ role: "user", content: brief }],
      Math.min(budget, CLARIFY_TIMEOUT_MS),
      () => "go"
    );
    clarify = r.text;
  } catch (e) {
    return {
      hits: [],
      reason: `${QWEN_RESEARCH_LABEL}第一次调用（反问确认）没跑成：${e instanceof Error ? e.message : String(e)}`,
      account,
    };
  }
  account.clarify = clarify.slice(0, 500);
  account.ms.clarify = Date.now() - started;
  const left = budget - account.ms.clarify;
  if (left <= 0) {
    return {
      hits: [],
      reason: `${QWEN_RESEARCH_LABEL}反问那一步就用掉了全部 ${Math.round(budget / 1000)} 秒，没发第二次`,
      account,
    };
  }

  // ---- 第二步：真跑，收 WebResearch 的地址 --------------------------------
  const sites: Record<string, unknown>[] = [];
  const seen = new Set<string>();
  const t2 = Date.now();
  let reason = "";
  try {
    await stream(
      setup,
      [
        { role: "user", content: brief },
        { role: "assistant", content: clarify },
        { role: "user", content: answer },
      ],
      left,
      (data) => {
        const research = obj(obj(messageOf(data).extra).deep_research);
        const p = phaseOf(data);
        if (p && !account.phases.includes(p)) account.phases.push(p);
        /*
         * **只在 `WebResearch` 这一阶段收**，见文件头第三节。`answer` 阶段的
         * `references` 是模型挑出来引的，那一层能被它读过的页面正文指挥。
         */
        if (p === "WebResearch") {
          const before = sites.length;
          scanSites(research, sites);
          /*
           * **子树里一条都没扫到就退一步，扫整帧。**
           *
           * `extra.deep_research` 是文档里唯一点过名的那一层，所以先扫它。但这一层的内部
           * 结构官方没给样例（文件头第四节），而猜错的代价是整步静默交零条 —— 那正是这个
           * 模块最坏的失败形态。退一步的代价小得多：多扫到几个不相干的对象，`keepUrl` 会滤，
           * 抓不动的页会进 `failures`。
           *
           * **仍然只在 `WebResearch` 这一帧上退**，所以第三节那条边界一格没动：`answer`
           * 阶段的 `references` 到不了这里，模型挑出来引的地址进不了抓取白名单。
           */
          if (sites.length === before) scanSites(data, sites);
        }
        // 搜完就走。`answer` 那一段在写一份我们要丢掉的报告。
        return BEFORE_ANSWER.includes(p) || !p ? "go" : "stop";
      }
    );
  } catch (e) {
    // 半路挂掉**照样用已经收到的那几条**：`WebResearch` 是边搜边推的，断在中间也有货。
    reason = `${QWEN_RESEARCH_LABEL}取地址那一段没跑完：${e instanceof Error ? e.message : String(e)}`;
  }
  account.ms.research = Date.now() - t2;

  // ---- 折成 SearchHit ------------------------------------------------------
  const hits: SearchHit[] = [];
  for (const raw of sites) {
    account.seen += 1;
    const url = s(raw.url);
    if (!keepUrl(url) || seen.has(url)) continue;
    seen.add(url);
    if (hits.length >= MAX_URLS) continue;
    hits.push({
      title: s(raw.title),
      url,
      // 摘要照抄它给的 `description`。**这一条不进台账** —— `ledger.record` 只认
      // `fetch.ts` 抓回来的正文（HP-1）。它在这里的唯一用处是 `withHint` 那一行提示。
      snippet: s(raw.description),
      sourceDomain: domainOf(url),
      matchedQuery: QWEN_RESEARCH_QUERY,
      provider: QWEN_RESEARCH_PROVIDER,
    });
  }
  account.kept = hits.length;
  if (!hits.length && !reason) {
    reason = `${QWEN_RESEARCH_LABEL}跑完了但一条地址都没扫到（走到过 ${account.phases.join("→") || "零个"} 阶段）`;
  }
  return { hits, reason, account };
}
