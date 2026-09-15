/**
 * 外部检索适配层。**只接受纯文字检索式，不接受任何公司上下文对象。**
 *
 * 这个约束是接口形状层面的，不是提示词里的一句叮嘱：检索式要发到境外或第三方的服务器
 * 上，所以「这次检索带不带公司数据」这件事必须由类型系统回答，不能靠人记得。
 *
 * ## 搜索结果不是证据
 *
 * 这一层只回答「该打开哪些页面」。摘要里那些裸数字不许直接进账本 —— 摘要把口径、
 * 日期、单位全剥掉了，剩下一个看起来精确的数，而它精确在哪一份口径上没人知道。
 * 证据只能来自 `fetch.ts` 抓回来的正文（见 `ledger.record` 的入口校验）。
 *
 * ## 对外只承诺一种形状
 *
 * 各家响应形状差得很远，对外一律折成 `SearchHit`。`sourceDomain` **一律从 url 里取**，
 * 不用各家自己的站点名字段：博查和豆包给的都是「新浪财经」这种中文台名，混在一起
 * 独立性折叠（`independence.ts`）就跨 provider 对不上了，而那是「每条命题 ≥2 个独立
 * 来源」这道判定的计数基础。
 *
 * ## 一轮可以同时用几家
 *
 * `TKOS_SEARCH_PROVIDER` 收一串家名（`bocha,doubao`），`providers()` 返回的是**一串**
 * 检索家，`searchAll` 把每条检索式发给每一家。多一家的价值不在多几条结果，在于各家的
 * 索引和排序不一样：一家漏掉的页另一家可能排在第一条。
 *
 * 三件事必须在这一层就说清，否则「同时用几家」会变成一个看不出真假的说法：
 *
 *  · **同一页被两家搜到不是两个来源。** 按 URL 去重，先收下的那一家留着 ——
 *    不去重的话，两家各返回一次同一篇稿子，独立性折叠之前就已经把它算成两条，
 *    而「≥2 组独立来源」那道门会被这种重复喂饱。
 *  · **每家各出了几条要分开记**（`SearchAccount`）。两家 `returned` 都高而 `unique`
 *    都低，说明它们在搜同一批页 —— 那时该换问法，不是再加一家。这个数是「哪家搜得好」
 *    唯一答得出来的形式。
 *  · **一家挂掉不拖垮这一轮。** 限流、额度用尽只影响那一家，原话带家名收进 `errors`，
 *    别家照常出结果。
 *
 * 顺序即优先级：列在前面的家先收，所以同一页留下的是它给的标题和摘要。
 *
 * ## 检索为空有三种成因，产出一模一样
 *
 *  · provider=none          —— 故意不搜。只测内部认知时的对照组，是正常状态。
 *  · provider 对但 key 没配 —— 这台机器没配完。
 *  · provider 名字不认识    —— 配错了，填了个没实现的家名。
 *
 * 后两种**不抛异常**（HP-5：查不到是合法结果，一次深研不该因为没配 key 就失败），
 * 但一律把原话留在 `reason` 里，由 `describe()` 带进 trace。不留原因就查不出来 ——
 * 实验台那边真发生过：`.env` 里填了个从未实现的家名，一声不响退回空检索，照样出一份
 * 格式漂亮的报告。
 */

import { tapSearchCall } from "@/lib/models/cost-tap";
import { acquire, OUTLETS, type Outlet } from "@/lib/models/gate";

/** 对外那份契约。`sourceDomain` 从 url 取，`siteName` 只给人看、不参与去重计数。 */
export type SearchHit = {
  title: string;
  url: string;
  snippet: string;
  sourceDomain: string;
  siteName?: string;
  publishedAt?: string;
  /** 哪条检索式命中的它。补搜时要答得出「这一条是第几轮哪个问法搜来的」。 */
  matchedQuery?: string;
  /** 哪一家搜到的（`bocha` / `doubao` / `mock`）。由 `searchAll` 填，各家适配器不填。 */
  provider?: string;
};

export type SearchProvider = {
  name: string;
  label: string;
  /** 这家的接口认不认时间窗。不认的一律忽略 `windowHours`，**而调用方要把这件事说出来** —— 不说的话，「这家的窗没生效」和「这题窗内真的没东西」长得一模一样。 */
  windowed: boolean;
  /** 空 = 正常。非空 = 这次不搜，原话在里面。 */
  reason: string;
  search(query: string, k: number, windowHours?: number): Promise<SearchHit[]>;
};

const domainOf = (url: string): string => (url.includes("://") ? url.split("/")[2] ?? "" : "");

/**
 * 时间窗（小时）→ 博查的 `freshness` 桶。0 或负数 = 不限。
 *
 * **向上取整**：桶必须 ≥ 窗。取整到更小的桶等于让检索端先砍掉本地时窗还想留的条目，
 * 而漏斗上看不出是谁砍的。
 */
export function freshness(windowHours: number): string {
  for (const [hours, bucket] of [
    [24, "oneDay"],
    [168, "oneWeek"],
    [720, "oneMonth"],
    [8760, "oneYear"],
  ] as const) {
    if (windowHours > 0 && windowHours <= hours) return bucket;
  }
  return "noLimit";
}

const TIMEOUT_MS = 60_000;

/** 响应体最多带这么长。够看清那句错误说明，又不至于把一整页 HTML 灌进台账。 */
const BODY_CLIP = 200;

/**
 * 非 2xx 的响应体，收拾成一行。
 *
 * **口令要抹掉**：有的接口会把请求原样回显，那时截出来的那一段里带着 key，而这句话要
 * 进台账、进事件明细、进屏幕。抹的是这一次真用的那把，不做通用的口令识别 —— 认不出来
 * 的形状照样漏，而这里手上正好有确切的那一串。
 */
function clipBody(body: string, key: string): string {
  const flat = body.replace(/\s+/g, " ").trim();
  return (key ? flat.split(key).join("***") : flat).slice(0, BODY_CLIP);
}

async function postJson(url: string, key: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
    // Next 会给全局 fetch 套一层缓存。检索结果被缓存的后果不是省钱，是
    // `retrievedAt` 变成假话 —— 台账上写着刚取的，实际是上一次的答案。
    cache: "no-store",
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) {
    /*
     * 体要带上。只报状态码的话这句话答不出下一步 —— 403 可能是口令写错、可能是这个
     * 账号没开这项服务、可能是欠费、也可能是被封，四种的处置完全不同，而分辨它们的
     * 那句话全在体里。真发生过：一整轮二十条检索式条条 403，现场只有「HTTP 403」
     * 五个字，于是那一轮的失败原因根本没法查。
     *
     * 读体本身失败（连接断了、不是文本）不许盖掉状态码 —— 那时状态码是唯一还剩的信息。
     */
    const body = await res.text().catch(() => "");
    const tail = clipBody(body, key);
    throw new Error(`检索接口返回 HTTP ${res.status}${tail ? `：${tail}` : ""}`);
  }
  const d: unknown = await res.json();
  return d && typeof d === "object" ? (d as Record<string, unknown>) : {};
}

const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const s = (v: unknown): string => (typeof v === "string" ? v : "");

/* -------------------------------------------------------------------------- */
/* 不搜 / 假搜                                                                 */
/* -------------------------------------------------------------------------- */

/** 不搜。`reason` 空 = 故意不搜；非空 = 配置有问题，原话在里面。 */
class NoSearch implements SearchProvider {
  readonly name = "none";
  readonly label = "未启用";
  readonly windowed = false;
  constructor(readonly reason: string = "") {}
  async search(): Promise<SearchHit[]> {
    return [];
  }
}

/**
 * 假搜。`TKOS_MODEL_MOCK=1` 时用它 —— 那个开关的含义是「这一轮整条链路不出网」，
 * 只把模型换成罐头而检索照样打真接口，等于测试会烧检索配额。
 *
 * 每条给一个按 url 定的署名机构：出处归因（`independence.assign` 的第一优先）认得出
 * 它，两页假材料才分得进两个独立组。不带署名的话假页正文几乎全同，simhash 会把它们
 * 并成一组，于是离线跑永远凑不齐「两组独立来源」，而那是判定达标的门。
 */
class MockSearch implements SearchProvider {
  readonly name = "mock";
  readonly label = "假检索（离线）";
  readonly windowed = false;
  readonly reason = "";
  async search(query: string, k: number): Promise<SearchHit[]> {
    const n = Math.max(1, Math.min(k, 3));
    return Array.from({ length: n }, (_, i) => ({
      title: `（假材料）${query} — 资料 ${i + 1}`,
      url: `https://example${i}.com/mock/${encodeURIComponent(query).slice(0, 24)}`,
      snippet: "这是离线自测用的占位材料，不是真实来源。",
      sourceDomain: `example${i}.com`,
    }));
  }
}

/* -------------------------------------------------------------------------- */
/* 博查                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 博查。国内主力。
 *
 * 取 `summary` 而不是 `snippet`：前者是整页长摘要，后者只是命中片段。这一层的产物要
 * 决定「值不值得打开」，片段判不出来。
 */
class BochaSearch implements SearchProvider {
  readonly name = "bocha";
  readonly label = "博查";
  readonly windowed = true;
  readonly reason = "";
  constructor(private readonly key: string) {}

  async search(query: string, k: number, windowHours = 0): Promise<SearchHit[]> {
    let d = await postJson("https://api.bochaai.com/v1/web-search", this.key, {
      query,
      count: k,
      summary: true,
      freshness: freshness(windowHours),
    });
    /*
     * 博查是「HTTP 200 + 业务码」的风格：成功时 `code` 是 200，出错时是别的值、
     * 正文在 `message`/`msg` 里。key 无效走的是真 401，但配额之类的错很可能是 200 ——
     * 那样 HTTP 判不出来，取不到 `webPages` 就静默变成 0 条，跟「这题搜不到东西」
     * 长得一样。所以这里显式拦一次，让它以异常的形式说出来。
     */
    const code = d.code;
    if (code !== undefined && code !== null && String(code) !== "200") {
      throw new Error(`博查检索失败 code=${String(code)}: ${s(d.message) || s(d.msg)}`.slice(0, 300));
    }
    // 结果包在 `data` 里，也有直接在顶层的调用路径。两种都接 —— 多一层兜底比某天
    // 换了包法之后静默返回 0 条要好。
    d = obj(d.data) === null ? d : Object.keys(obj(d.data)).length ? obj(d.data) : d;
    return arr(obj(obj(d.webPages).value ? d.webPages : {}).value).map((raw) => {
      const it = obj(raw);
      const url = s(it.url);
      return {
        title: s(it.name),
        url,
        snippet: s(it.summary) || s(it.snippet),
        sourceDomain: domainOf(url),
        siteName: s(it.siteName),
        publishedAt: s(it.datePublished),
      };
    });
  }
}

/* -------------------------------------------------------------------------- */
/* 豆包搜索                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 协议里那张错误码表，各配一句人话（对齐豆包搜索 Custom 版文档 2026-08-24 那一版）。
 *
 * 一条都不省，包括「兜底内部错误」那种：这几种的处置完全不同（改参数 / 去开通 / 充值 /
 * 换 key / 降并发 / 直接重试），而现场只有一个五位数字时，看的人只能去翻文档 —— 而这句话
 * 是要落进事件明细给一号位看的。
 *
 * `10406` 那一句为什么写这么长：这次排查真正卡住的地方就在这里。免费额度是**每个火山账号
 * 每月 500 次**、与 Global 版共用、不区分搜索类型和付费类型、**无论是否开通付费都优先消耗**；
 * 用完之后要这把 key 属于一个已开通的付费模式（按量后付费 / 在期的订阅套餐，两种各有独立的
 * API Key）才继续打得通。「火山账号里还有余额」是另一个开关 —— 有余额、付费调用没开，照样
 * 10406。原来那句「去控制台确认是否开通付费调用」把这件事说得太轻，读的人会先去查余额。
 */
const DOUBAO_HINTS: Record<string, string> = {
  "10400": "请求结构有问题，一般是某个字段类型写错了",
  "10401": "TOP 网关的 Token 无效 —— 我们走的是 API Key 那条路，出现它说明打错了地址",
  "10402": "搜索类型不合法：SearchType 写错了，或者这个账号没开通这一种",
  "10403": "权限错误：这个账号没开通对应的搜索服务",
  "10406":
    "每月免费额度（每个火山账号 500 次，与 Global 版共用，无论是否开通付费都先消耗它）已用尽。" +
    "注意火山账号里有余额不等于开通了付费调用 —— 去联网搜索控制台确认这把 key 所在的付费模式" +
    "（按量后付费或订阅套餐）已开通",
  "10408": "这项搜索服务没开通付费调用（这一码只在不提供每月免费额度的服务上出现）",
  "10409": "这把 key 是订阅套餐的，只能打 Custom 版 web 搜索",
  "10410": "无可用订阅套餐：这把 key 的套餐没开通或已到期",
  "10412": "订阅套餐剩余额度不足，升配或换一把按量后付费的 key",
  "10500": "对方服务端内部错误（兜底码），一般重试就过",
  "700429": "并发超了 QPS 限流（账号维度，默认 5，控制台的服务卡片上能看当前值）",
};

/** 「这条没有发布时间」豆包写成 epoch 零，不是空串。负时区会渲染成 1969-12-31，两天都算。 */
const EPOCH_SENTINEL = ["1970-01-01", "1969-12-31"];

/**
 * 豆包搜索 Custom 版。
 *
 * `Summary` 是 500~1000 字的相关摘要（文档明写推荐用于大模型场景），`Snippet` 约 200 字
 * （文档明写强烈不建议）。`Content`（整页正文）不取 —— 这一层不产证据，正文由 `fetch.ts`
 * 自己抓，从检索接口顺一份回来会让「证据来自哪一次抓取」答不清。
 *
 * `windowed = false`：协议里有 `TimeRange`，但取值格式没在这个号上验过，而拼错一个字段
 * 是静默的（照样 200、照样回全时段）。所以宁可承认这家不认窗，让调用方把「这次的窗没到
 * 检索端」说出来。
 */
class DoubaoSearch implements SearchProvider {
  readonly name = "doubao";
  readonly label = "豆包搜索";
  readonly windowed = false;
  readonly reason = "";
  /** 单次返回条数上限。豆包封 50，夹一下至少行为是确定的。 */
  private static readonly MAX_COUNT = 50;
  constructor(private readonly key: string) {}

  private static when(raw: string): string {
    return EPOCH_SENTINEL.some((p) => raw.startsWith(p)) ? "" : raw;
  }

  async search(query: string, k: number): Promise<SearchHit[]> {
    const d = await postJson("https://open.feedcoopapi.com/search_api/web_search", this.key, {
      Query: query,
      SearchType: "web",
      Count: Math.min(k, DoubaoSearch.MAX_COUNT),
      // 没有 URL 的一条根本收不进来；这个开关顺带滤掉天气、油价那类卡片。
      Filter: { NeedUrl: true },
    });
    // 和博查同一个套路：错误包在 HTTP 200 里。
    const err = obj(obj(d.ResponseMetadata).Error);
    if (Object.keys(err).length) {
      const code = String(err.CodeN ?? err.Code ?? "");
      const hint = DOUBAO_HINTS[code] ?? "";
      // 截的是厂商那句话，不是整条：原来 `.slice(0, 300)` 砍在末尾，而人话在末尾 ——
      // 对方哪天把 Message 写长一点，那句唯一说得出该做什么的话就被砍掉了。
      throw new Error(
        `豆包搜索失败 code=${code}: ${s(err.Message).slice(0, 160)}${hint ? `；${hint}` : ""}`
      );
    }
    return arr(obj(d.Result).WebResults).map((raw) => {
      const it = obj(raw);
      const url = s(it.Url);
      return {
        title: s(it.Title),
        url,
        snippet: s(it.Summary) || s(it.Snippet),
        sourceDomain: domainOf(url),
        siteName: s(it.SiteName),
        publishedAt: DoubaoSearch.when(s(it.PublishTime)),
      };
    });
  }
}

/* -------------------------------------------------------------------------- */
/* 选家                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 名字 → 构造。加一家就往这里加一条，**不要**回到 `if (name === "x")`：硬分支留下过
 * 一个谎 —— 注释里许诺的某个家名从来没实现过，填了它不报错。现在没注册的名字会由
 * `provider()` 说出来。
 */
const REGISTRY: Record<string, { keyEnv: string; make: (key: string) => SearchProvider }> = {
  bocha: { keyEnv: "TKOS_SEARCH_BOCHA_KEY", make: (k) => new BochaSearch(k) },
  doubao: { keyEnv: "TKOS_SEARCH_DOUBAO_KEY", make: (k) => new DoubaoSearch(k) },
};

/** key 取值。`TKOS_SEARCH_API_KEY` 是单 provider 时代的通用名，作为回落留着。 */
function keyFor(env: string): string {
  return (process.env[env] ?? process.env.TKOS_SEARCH_API_KEY ?? "").trim();
}

/** 一串家名。逗号、中文逗号、空格都当分隔符 —— 手填的配置里这三种都会出现。 */
const split = (spec: string): string[] => {
  const names = spec
    .split(/[,，、\s]+/)
    .map((n) => n.trim().toLowerCase())
    .filter(Boolean);
  // 去重但保留顺序：顺序就是「同一页留谁的摘要」的优先级。
  return names.filter((n, i) => names.indexOf(n) === i);
};

/** 这次的检索家阵容。 */
export type SearchSetup = {
  /** 真能用的几家，按配置顺序。一家都用不上时是一支空检索（`list.length` 永远 ≥1）。 */
  list: SearchProvider[];
  /**
   * 配置里写了、但这一轮用不上的那几家，一条一句原话。
   *
   * **有能用的家时这些话也要说出来。** 「配了三家其实只有一家在跑」和「本来就只配了一家」
   * 产出的报告长得一模一样，不说的话只表现成「这一轮外面的东西比预期少」。
   */
  skipped: string[];
};

/**
 * 这次用哪几家。`spec` 不给就读 `TKOS_SEARCH_PROVIDER`（可以是 `bocha,doubao`）。
 *
 * **一家配坏了不影响别家**：认不出的家名、配了家名却没配 key 的，各收一句原话进
 * `skipped`，能用的照常返回。全都用不上时返回一支带 `reason` 的空检索 —— 仍然不抛异常
 * （HP-5：查不到是合法结果，一次深研不该因为没配 key 就失败）。
 *
 * `TKOS_MODEL_MOCK=1` 压倒一切 —— 那个开关的含义是这一轮不出网。
 */
export function providers(spec?: string): SearchSetup {
  if (process.env.TKOS_MODEL_MOCK === "1") return { list: [new MockSearch()], skipped: [] };
  const wanted = split(spec ?? process.env.TKOS_SEARCH_PROVIDER ?? "").filter((n) => n !== "none");
  if (!wanted.length) return { list: [new NoSearch()], skipped: [] };

  const list: SearchProvider[] = [];
  const skipped: string[] = [];
  for (const n of wanted) {
    const reg = REGISTRY[n];
    if (!reg) {
      skipped.push(`未知的检索 provider「${n}」；可选 ${["none", ...Object.keys(REGISTRY)].join(" / ")}`);
      continue;
    }
    const key = keyFor(reg.keyEnv);
    if (!key) {
      // 说的是变量名，**不是** key 本身，也不是它的长度或哈希 —— 这句话会进运行记录。
      skipped.push(`配了 ${n}，但这台机器没配 ${reg.keyEnv}`);
      continue;
    }
    list.push(reg.make(key));
  }
  if (!list.length) {
    return { list: [new NoSearch(`${skipped.join("；")}。本次外部证据为空。`)], skipped: [] };
  }
  return { list, skipped };
}

/** 这几家的代号，`bocha+doubao` 这样接起来。统计用，不上屏。 */
export const providerCode = (list: SearchProvider[]): string => list.map((p) => p.name).join("+");

/** 这几家的中文说法，「博查 + 豆包搜索」。**上屏的一律用这个。** */
export const providerLabel = (list: SearchProvider[]): string => list.map((p) => p.label).join(" + ");

/**
 * 这次检索**实际**用的是谁、以及为什么。给 trace 用。
 *
 * 只报名字和原因，**不报 key、不报 key 的长度或哈希** —— trace 会经 HTTP 出去，也会
 * 落进运行记录。
 */
export function describe(list: SearchProvider[], skipped: string[] = []): Record<string, string> {
  const d: Record<string, string> = { 检索: providerLabel(list) };
  const reasons = list.map((p) => p.reason).filter(Boolean);
  if (reasons.length) d.检索未启用 = reasons.join("；");
  if (skipped.length) d.没用上的检索家 = skipped.join("；");
  /*
   * 不认窗的家要**点名**。多家一起跑时写一句笼统的「这家不认窗」，读的人分不出是哪一家
   * 的结果没经过窗筛 —— 而那正是「窗没生效」和「窗内真的没东西」唯一的分界。
   */
  const blind = list.filter((p) => !p.windowed && p.name !== "none").map((p) => p.label);
  if (blind.length) {
    /*
     * 话说到能力上，不说成「本轮的窗在本地生效」—— 深研这一层目前一条窗都不设，那么写
     * 等于许诺了一道本地筛，而它并不存在。这条要留着的是「哪天设了窗，这几家答不出来」。
     */
    d.时间窗 = `${blind.join("、")}的接口不认时间窗：传给它的窗到不了检索端。深研这一层目前不设窗，所以本轮没有影响`;
  }
  return d;
}

/** 一家在这一轮的账。 */
export type SearchAccount = {
  /** 这家的中文说法。跟着数一起走 —— 调用方要上屏，而它自己维护一张代号对照表会烂掉。 */
  label: string;
  /** 它返回过的条数，含别家先收下的重复页。 */
  returned: number;
  /** 其中头一次出现的地址数。**这才是它独有的贡献。** */
  unique: number;
};

/**
 * 这家检索源对应哪个限流池（`models/gate.ts`）。认不出来就是**不限速**。
 *
 * 认不出来的只有 `none` 和 `mock` —— 它们压根不出网。哪天真加一家出网的检索源而忘了在
 * `Outlet` 上给它一格，表现是那一家不排队；这比反过来（硬塞进别人的池，让两家互相挡）好，
 * 而且下面那句 `providers()` 的注册表和 `Outlet` 摆在一起看，漏了一眼就能看见。
 */
const searchOutlet = (name: string): Outlet | null =>
  (OUTLETS as string[]).includes(name) ? (name as Outlet) : null;

/**
 * 把一组检索式在这几家上跑完，按 URL 去重。
 *
 * 一条检索式在某一家上抛错**不中断整轮** —— 四条问法里有一条触发限流，把整次深研判
 * 失败是过度反应。抛错的那条把原话连家名收在 `errors` 里，由调用方带进 trace：错了几条、
 * 错在哪一家，和「这几个问法搜不出东西」必须分得开。
 *
 * **并发只跨家，不跨检索式**：同一家同一时刻只有一条请求在飞（豆包封 5 QPS），而两家
 * 之间没有理由互相等 —— 串起来跑，两家就是两倍时长，而一轮补搜的墙钟时间是他在屏幕前
 * 真的要等的东西。
 */
export async function searchAll(
  list: SearchProvider[],
  queries: string[],
  k: number,
  windowHours = 0
): Promise<{ hits: SearchHit[]; errors: string[]; perProvider: Record<string, SearchAccount> }> {
  const hits: SearchHit[] = [];
  const errors: string[] = [];
  const seen = new Set<string>();
  const perProvider: Record<string, SearchAccount> = {};
  for (const q of queries) {
    if (!q.trim()) continue;
    const batches = await Promise.all(
      list.map(async (p) => {
        /*
         * 每一次真发出去的检索都记一笔（见 `cost-tap.ts`，关着的时候零开销）。
         *
         * 检索是按**次**收钱的，而这个函数原来只往上交「入账了几条证据」——
         * 那两个数不是一回事：一次检索可能一条都没入账，钱照付。算账那一轮里
         * 光预研一段就发了 40 次（20 个检索式 × 两家），而账上一次都看不见。
         */
        /*
         * 检索也过出口限速器。**理由和模型调用那边是同一条**：这个函数里「同一家同一时刻只有
         * 一条请求在飞」只在**一次调用之内**成立，而四条取证链是并着跑的（`a4/sweep.ts`）——
         * 四条链各自都守着「一家一条」，合起来仍是四条同时打在博查上。撞限的表现是这一条问法
         * 记进 `errors`，屏幕上读成「这几个问法搜不出东西」。
         *
         * 抓取（`fetch.ts`）不进这道闸：抓的是各家网站，没有共同的限流池。
         */
        const outlet = searchOutlet(p.name);
        const release = outlet ? await acquire(outlet) : null;
        const t0 = Date.now();
        try {
          const batch = await p.search(q, k, windowHours);
          tapSearchCall({
            provider: p.name,
            query: q,
            hits: batch.length,
            ms: Date.now() - t0,
            ok: true,
          });
          return { p, batch };
        } catch (e) {
          tapSearchCall({
            provider: p.name,
            query: q,
            hits: 0,
            ms: Date.now() - t0,
            ok: false,
          });
          errors.push(`「${q}」· ${p.label}：${e instanceof Error ? e.message : String(e)}`);
          return { p, batch: [] as SearchHit[] };
        } finally {
          // 成败都还。漏还一次的表现是这一家的并发额度永久少一格（见 `gate.ts` 的 `acquire`）。
          release?.();
        }
      })
    );
    // 收下的顺序按 `list` 的顺序，不按谁先返回 —— 同一页留谁的摘要不该由网络快慢决定。
    for (const { p, batch } of batches) {
      const acc = (perProvider[p.name] ??= { label: p.label, returned: 0, unique: 0 });
      for (const it of batch) {
        if (!it.url) continue;
        acc.returned += 1;
        if (seen.has(it.url)) continue;
        seen.add(it.url);
        acc.unique += 1;
        hits.push({ ...it, matchedQuery: q, provider: p.name });
      }
    }
  }
  return { hits, errors, perProvider };
}
