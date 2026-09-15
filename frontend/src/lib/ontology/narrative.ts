/**
 * 本体叙述接口（memory-api）的客户端。
 *
 * 整个上游只有一个端点：`POST /v1/context-graph/narrative`，入参一句话，回一段
 * **叙述文** —— 从公司愿景出发、沿主导航路径讲到与这句话相关的节点。
 *
 * ## 本体分两层，这个端点只给其中一层
 *
 * · **语义记忆**：跟公司有关的内容 —— 愿景、本期 Outcome、八个 Domain、各条 Mission、
 *   经营原则。**这个端点回的就是它**，加上一句「你问的这件事挂在其中哪一条下面」。
 * · **工作记忆**：存进本体的议题，以及它挂着的判断与共识。**本体还没建到这一层**，
 *   所以这一路一条都取不到。
 *
 * 这个区分不是背景知识，它决定了下游每一处措辞。少了工作记忆，这些东西一律没有：
 * 这条议题以前被讨论过没有、围绕它形成过哪些判断、哪些已经确认、被什么推翻过。
 * 而调用方手上会拿到一整段真实的公司材料 —— 最顺手的写法恰恰是从那段材料里推想出
 * 一句「公司现有判断是……」。防这一手的话写在 `prompts.ts` 的 `wrapCompanyNarrative`、
 * `talk/turn.ts` 的 `renderMembers` 和 `talk/tools.ts` 的工具说明里，三处一起改。
 *
 * 另有一条结构性事实：**每一条战略议题都从属于某一条当前的 Mission。** 所以这一路
 * 真正的产出不是「公司记过这件事没有」，是「这件事挂在哪条 Mission 下」—— 挂不上
 * 本身也是一条结论。
 *
 * ## 它和 GraphKnowledge 那一层的形状差别
 *
 * 那一层是四个取数点（P0/P1/P2/P3）加一套配方，前端自己装配、自己算锚点、自己拼
 * Markdown；这一层是**上游已经装配好了**，我们只发一句话。跟着没有的两样：
 *
 * · **没有编号。** 返回里一个 `ISS-D6` / `01-J2` 这样的短码都没有，对象以名字出现
 *   （「8月Outcome-01方向与经营选择」）。所以这一路装不出 `memberIds`。
 * · **没有配方。** S01/S02/S03 三种厚度在这个接口上没有旋钮，只有 `query`。
 *
 * ## 两份文
 *
 * `narrative` 是上游过了一遍模型压缩的（实测 1851 → 762 字），`narrative_raw` 是压缩前
 * 那份。**差的不是长度，是来源和确认状态**：原文里带着「CEO 刘明华 2026-08-24 内部会议
 * 原话」「该 PDF 已向管理层汇报且未被推翻」「仅创建 pending，不 confirm」这类话，压缩版
 * 把它们磨掉了。深研和预研要的正是那些，所以那几条链路取原文（`includeRaw`），
 * 对话取压缩版 —— 取哪一份由调用方定，见 `context.ts` 的 `includeRaw` 那段。
 *
 * ## 为什么用 undici 不用全局 fetch
 *
 * 同 `graphknowledge/client.ts` 的第二条理由：绕开 Next.js 给全局 `fetch` 打的缓存补丁。
 * 本体读的是「此刻的公司状态」，被缓存住的表现是同一轮里两次取到的公司状态不一样、
 * 或者改了本体之后前端半天不变，而屏幕上看不出任何异常。
 */
import { Agent, request } from "undici";

import { OntologyUnavailable } from "./errors";

/**
 * 一次调用的上限。**2026-09-03 从 25 秒抬到 45 秒。**
 *
 * 比 GraphKnowledge 那边的 30 秒长，而那边一次装配是十来个**顺序**请求、这边只有一次
 * 往返 —— 反过来了。抬的理由是实测：同一句话交替打十二次（带原文六次、只要压缩稿六次），
 * 回话 5247 / 5471 / 5701 / 6364 / 6382 / 9046 / 10024 / 10419 / 13340 / 29102 /
 * 32207 / 32912 ms。**十二次里三次越过 25 秒**，而这条尾巴跟带不带原文无关（最慢那两次
 * 恰好都是带原文那一档）——上游两种配置下都要跑同一遍压缩模型，`include_raw` 只是多回
 * 一个它手里已经有的字段。
 *
 * 25 秒那一版是照着「实测 3.0～6.0 秒」定的，那个量程现在不成立了。按上面这十二个数，
 * 25 秒不是「慢得该放弃」的闸，是**四分之一的正常调用会被它拦掉**；45 秒才回到当初
 * 那句话的意思。代价写在明处：上游真躺了的那一次，这一步要多等 20 秒才判死，而重发
 * 一次（`ATTEMPTS`）之后最坏是 45 + 1 + 45 = 91 秒。
 *
 * **这是止血不是修好。** 1500 字符压成 600 字要跑 33 秒，问题在 memory-api 那一侧；
 * 这里抬闸只是不让它顺手弄死一轮深研。那边治好了，这个数该收回去。
 *
 * 它跟 `TKOS_ONTOLOGY_TIMEOUT_MS` 是同一个值：那个变量本来就是给「本体」这条链路的，
 * 换了源不该换名字，否则线上那份 env 里会同时留着一个还在读的和一个没人读的。
 * **改这里要连 `.env.local` / `.env.example` 里那一行一起改**，否则本机照旧按旧值跑。
 */
const DEFAULT_TIMEOUT_MS = 45_000;

export type NarrativeSettings = {
  baseUrl: string;
  apiKey: string;
  tenant: string;
  org: string;
  timeoutMs: number;
  /** 环境变量的解析问题。**不抛** —— 一个解析失败会让模块导入失败，表现是每条路由都 500。 */
  warnings: string[];
};

export function narrativeSettings(): NarrativeSettings {
  const warnings: string[] = [];

  const baseUrl = (process.env.TKOS_MEMORY_API_BASE_URL ?? "").trim().replace(/\/+$/, "");
  const apiKey = (process.env.TKOS_MEMORY_API_KEY ?? "").trim();

  const rawTimeout = (process.env.TKOS_ONTOLOGY_TIMEOUT_MS ?? "").trim();
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (rawTimeout) {
    const n = Number(rawTimeout);
    /*
     * 解析不出来就用默认值**并且说一声**。静默回落的下场是：有人把它写成 `25s`，
     * 而线上仍然按 25000 跑 —— 那个变量看起来生效了，其实一直没被读进去。
     */
    if (Number.isFinite(n) && n > 0) timeoutMs = n;
    else warnings.push(`TKOS_ONTOLOGY_TIMEOUT_MS=${rawTimeout} 不是正数，本次按 ${DEFAULT_TIMEOUT_MS}ms`);
  }

  return {
    baseUrl,
    apiKey,
    /*
     * 租户与组织有服务端默认值（local / local-org），所以留空是**合法配置**不是漏配 ——
     * 留空时我们一个字段都不发，由服务端填它自己的默认，而不是我们在这里抄一份可能会
     * 跟上游漂移的默认值。
     */
    tenant: (process.env.TKOS_MEMORY_API_TENANT ?? "").trim(),
    org: (process.env.TKOS_MEMORY_API_ORG ?? "").trim(),
    timeoutMs,
    warnings,
  };
}

/** 上游回来的那一份，字段名折成前端的写法。 */
export type NarrativeResult = {
  /** 真正送出去的那一句。 */
  sent: string;
  /** 主文。`includeRaw` 时是未压缩那份，否则是压缩版。**取哪一份由调用方定。** */
  text: string;
  /** 上游压缩前那份。没要 `include_raw` 时是空串。 */
  raw: string;
  /** 压缩版。`includeRaw` 时这一份仍然在，用来记账（两份各多少字）。 */
  compressed: string;
  /** 这次从愿景走下来命中了几条路径 / 几个旁支。**它们判不出「有没有相关内容」**，见文件头。 */
  hitPaths: number;
  lateralNodes: number;
  /** 根陈述（公司愿景那一段）。每次都一样，留着是为了在 trace 上认出「这次接的是哪个租户」。 */
  rootStatement: string;
  tenant: string;
  org: string;
  /** 上游做压缩用的模型。**记进 trace** —— 这段话不是原始数据，是它写的。 */
  model: string;
  rawChars: number;
  compressedChars: number;
  sourceBaseUrl: string;
  /**
   * 这一步花掉的毫秒数。**重发过的那次连头一次和中间那一秒一起算在里面** ——
   * 这一栏答的是「这一步占了多久」，而占掉的时间是全部，不是最后那一次。
   */
  ms: number;
  /** 打了几个往返。1 是没抖，2 是重发过一次（见 `ATTEMPTS`）。上层拿它写 warnings。 */
  attempts: number;
};

/**
 * 一次调用最多打几个往返。**2 = 头一次加重发一次。**
 *
 * 这条纪律在别处是反过来的：一轮深研挂了不自动重开，因为重开一轮是十几分钟加一轮真实
 * 开销（见 `store.ts` 的 `deepRoundState`）。这里不一样 —— 这是整条链**最便宜**的一次
 * 调用：一个 HTTP 往返加上游一遍 flash 压缩，几秒钱。而它挂掉的代价是一轮 20 分钟的深研
 * 在起跑线上就被判死，模型一个都还没调。
 *
 * 2026-09-03 实测的理由：同一句话打十二次，回话最快 5247 ms、最慢 32912 ms，中位十秒
 * 上下（十二个数全列在 `DEFAULT_TIMEOUT_MS` 那一段）。这条尾巴甩得比任何一版上限都远，
 * 所以「撞上限」是常态里的一次，不是故障。ISS-225 那一轮就是这么没的：18:56:48 开跑，
 * 27 秒后收场，trace 只有一条。
 *
 * 只重发一次不是两次：真的是上游躺了的时候，第二次也会等满上限，最坏情况已经是
 * 45 + 1 + 45 = 91 秒。再加一次就把「慢」变成了「卡死」，而深研那一轮的余量是有数的。
 */
const ATTEMPTS = 2;

/** 两次之间隔多久。够上游那一下过去，又不至于让调用方在这儿干等。 */
const RETRY_DELAY_MS = 1_000;

/**
 * **网关类 5xx 另算一档，2026-09-04 加。**
 *
 * 上面那条「上游答了就不重发」的纪律对 4xx 成立，对 502/503/504 不成立：这三种不是上游读懂了
 * 并且拒绝，是上游**自己后面的东西**没起来。当天的实例：`/v1/context-graph/narrative` 回 502，
 * 正文是 `connection to server at "127.0.0.1", port 5435 failed: Connection refused` —— memory-api
 * 活着，它的 Postgres 没起。这种故障的时间尺度是几秒到几十秒（进程重启、连接池恢复），一次
 * 往返之后当场判死，等于让一轮深研在起跑线上被一次 DB 重启判死，而那正是 `ATTEMPTS` 那段
 * 注释要躲的事。
 *
 * 三次、间隔 2s / 5s / 10s：合计十七秒，够一次进程重启，不够把「上游真躺了」拖成「卡死」。
 * 三次之后照旧抛 `OntologyUnavailable` —— 就地失败这条纪律不变，变的只是判死之前多等十七秒。
 * 4xx、非 JSON、200 空正文照旧一次都不重发。
 */
const GATEWAY_STATUSES = new Set([502, 503, 504]);
const GATEWAY_RETRY_DELAYS_MS = [2_000, 5_000, 10_000] as const;

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** 连接池缓存一个。每次新建 `Agent` 会把连接复用也一起丢掉，而症状只是「本体这一步有点慢」。 */
let agent: Agent | undefined;

function agentFor(timeoutMs: number): Agent {
  if (!agent) {
    agent = new Agent({
      connect: { timeout: timeoutMs },
      headersTimeout: timeoutMs,
      bodyTimeout: timeoutMs,
    });
  }
  return agent;
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export class NarrativeClient {
  readonly baseUrl: string;
  readonly warnings: string[];
  private readonly apiKey: string;
  private readonly tenant: string;
  private readonly org: string;
  private readonly timeoutMs: number;

  constructor(settings: NarrativeSettings = narrativeSettings()) {
    this.baseUrl = settings.baseUrl;
    this.warnings = settings.warnings;
    this.apiKey = settings.apiKey;
    this.tenant = settings.tenant;
    this.org = settings.org;
    this.timeoutMs = settings.timeoutMs;
  }

  get configured(): boolean {
    return Boolean(this.baseUrl && this.apiKey);
  }

  /**
   * 取一段叙述。**取不到一律抛 `OntologyUnavailable`** —— 这一层不产生任何「正常的空」。
   *
   * 空正文也算取不到：上游回 200 但 `narrative` 是空串时，继续往下走就是把一段空白
   * 当公司上下文塞进 prompt，而 prompt 里那句「下面这段是公司经营脉络」还在。
   */
  async narrative(query: string, opts: { includeRaw?: boolean } = {}): Promise<NarrativeResult> {
    const sent = (query ?? "").trim();
    if (!sent) {
      throw new OntologyUnavailable("问句是空的，这个请求没发出去", { where: "narrative" });
    }
    if (!this.baseUrl) {
      throw new OntologyUnavailable(
        "没配 TKOS_MEMORY_API_BASE_URL，地址是空的，这个请求压根没发出去",
        { where: "narrative" }
      );
    }
    if (!this.apiKey) {
      /*
       * 缺 key 和地址错是两条排查路径，所以分开报。**不打印 key 本身，也不打印它的长度** ——
       * 长度足够把一把线上的 key 从日志里认出来。
       */
      throw new OntologyUnavailable("没配 TKOS_MEMORY_API_KEY，这个请求压根没发出去", {
        where: "narrative",
        baseUrl: this.baseUrl,
      });
    }

    const url = `${this.baseUrl}/v1/context-graph/narrative`;
    const payload: Record<string, unknown> = { query: sent };
    if (opts.includeRaw) payload.include_raw = true;
    // 留空就不发这两个字段，由服务端填它自己的默认值（见 `narrativeSettings`）。
    if (this.tenant) payload.tenant = this.tenant;
    if (this.org) payload.org = this.org;

    const t0 = Date.now();
    let status = 0;
    let body = "";
    let attempts = 0;
    /** 网关类 5xx 重发了几次。和 `attempts` 分开数：那一个记的是「没等到回话」。 */
    let gatewayRetries = 0;
    /*
     * **只有「请求发出去了、没等到回话」这一类才重发**（超时、连不上、连接被掐）——
     * 外加 502/503/504 那一档（`GATEWAY_STATUSES`，理由见那段注释）。
     *
     * 上游**答了**的那几种一律不重发，它们在下面各自抛：4xx/5xx 是它读懂了并且拒绝，
     * 不是 JSON 是它坏了，200 但正文空是这一层自己判的取不到。这三种再打一个往返，
     * 回来的是同一句话 —— 白等一秒，还把「上游在拒绝我们」写成了「网络有点抖」。
     *
     * 重发同一个 POST 是安全的：这个端点读图、写一段话回来，不落任何东西。
     */
    for (;;) {
      attempts += 1;
      try {
        const res = await request(url, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            accept: "application/json",
            authorization: `Bearer ${this.apiKey}`,
          },
          body: JSON.stringify(payload),
          dispatcher: agentFor(this.timeoutMs),
        });
        status = res.statusCode;
        body = await res.body.text();
        if (GATEWAY_STATUSES.has(status) && gatewayRetries < GATEWAY_RETRY_DELAYS_MS.length) {
          const wait = GATEWAY_RETRY_DELAYS_MS[gatewayRetries];
          gatewayRetries += 1;
          // `attempts` 只数「没等到回话」那一类：这一次上游答了（答的是 502），不算进去，
          // 否则后面一次真超时会被读成「连着两次」，重发成功也会被上层写成假 warning。
          attempts -= 1;
          console.warn(
            `[tkos:ontology] ${url} 回 ${status}（${body.slice(0, 160).replace(/\s+/g, " ")}），` +
              `${wait}ms 后重发（第 ${gatewayRetries}/${GATEWAY_RETRY_DELAYS_MS.length} 次）`
          );
          await sleep(wait);
          continue;
        }
        break;
      } catch (e) {
        const why = e instanceof Error ? e.message : String(e);
        if (attempts < ATTEMPTS) {
          /*
           * 这一行要打出来。重发成功的那次在产物上跟一次正常调用一模一样，只是慢了
           * 二十几秒 —— 不留痕的话，「今天这轮怎么比平时久」在任何地方都查不出来。
           * （上层还会把它写进 warnings，见 `context.ts`。）
           */
          console.warn(
            `[tkos:ontology] ${url} 第 ${attempts} 次没等到回话（${why}），` +
              `${RETRY_DELAY_MS}ms 后重发一次`
          );
          await sleep(RETRY_DELAY_MS);
          continue;
        }
        // 一定要带上目标 URL：只报底层 errno 的话，服务没起和网络不通分不出来。
        throw new OntologyUnavailable(
          `请求 ${url} 失败：${why}（连着两次都没等到回话）`,
          { where: "narrative", url, ms: Date.now() - t0, attempts }
        );
      }
    }

    if (status < 200 || status >= 300) {
      /*
       * 正文截一段带出来。上游是 FastAPI，400/422 的 `detail` 里写着到底哪个字段不对，
       * 而只报一个状态码的话，「body 解析失败」和「key 不对」在日志里长得一模一样。
       */
      const retried = gatewayRetries
        ? `（网关类 ${status}，隔 ${GATEWAY_RETRY_DELAYS_MS.slice(0, gatewayRetries).map((x) => x / 1000).join("s / ")}s 重发了 ${gatewayRetries} 次仍是它 —— 多半是 memory-api 后面的库或进程没起，不是网络）`
        : "";
      throw new OntologyUnavailable(`${url} 回 ${status}${retried}：${body.slice(0, 400)}`, {
        where: "narrative",
        url,
        status,
        ms: Date.now() - t0,
      });
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      throw new OntologyUnavailable(`${url} 回的不是 JSON：${body.slice(0, 200)}`, {
        where: "narrative",
        url,
        status,
        ms: Date.now() - t0,
      });
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new OntologyUnavailable(`${url} 回的不是 JSON 对象`, { where: "narrative", url, status });
    }

    const d = parsed as Record<string, unknown>;
    const compressed = str(d.narrative);
    const raw = str(d.narrative_raw);
    /*
     * 要原文却没拿到时**回落到压缩版，并且不抛**。
     *
     * 上游哪天把 `include_raw` 去掉、或者某一次没带回来，为此让一整轮深研失败换不来任何
     * 诚实 —— 压缩版仍然是真材料。但这件事要留痕：调用方拿 `raw` 是空串判得出来，
     * `context.ts` 会把它写进 warnings，报告的溯源行上因此看得见这一轮吃的是哪一份。
     */
    const text = opts.includeRaw ? raw || compressed : compressed;
    if (!text.trim()) {
      throw new OntologyUnavailable(`${url} 回了 200，但正文是空的`, {
        where: "narrative",
        url,
        status,
        ms: Date.now() - t0,
      });
    }

    return {
      sent,
      text,
      raw,
      compressed,
      hitPaths: num(d.hit_paths),
      lateralNodes: num(d.lateral_nodes),
      rootStatement: str(d.root_statement),
      tenant: str(d.tenant),
      org: str(d.org),
      model: str(d.model),
      rawChars: num(d.narrative_raw_chars),
      compressedChars: num(d.narrative_chars),
      sourceBaseUrl: this.baseUrl,
      ms: Date.now() - t0,
      attempts,
    };
  }

  /** 存活探针。`/api/health` 用它，不带鉴权。 */
  async health(): Promise<Record<string, unknown>> {
    if (!this.baseUrl) throw new OntologyUnavailable("没配 TKOS_MEMORY_API_BASE_URL");
    const res = await request(`${this.baseUrl}/healthz`, {
      method: "GET",
      headers: { accept: "application/json" },
      dispatcher: agentFor(this.timeoutMs),
    });
    const body = await res.body.text();
    try {
      return JSON.parse(body) as Record<string, unknown>;
    } catch {
      throw new OntologyUnavailable(`/healthz 回的不是 JSON：${body.slice(0, 200)}`);
    }
  }
}
