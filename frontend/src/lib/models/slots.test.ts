/**
 * 槽位与注册表上那几条**账号事实**：谁走哪把 key、哪条地址、哪套方言。
 *
 * ## 2026-09-01 换网关，这一份跟着重写
 *
 * 深研的两条链路（`alt`「Claude」与 `synth`「ChatGPT」）从 AWS Bedrock 换到了网宿
 * AI Gateway。上一版这里钉着三件已经不成立的事，删掉的理由各不相同，都不是「测试碍事」：
 *
 *   · **Bedrock 那两个域名**（`bedrock-runtime.<region>.amazonaws.com`，带不带
 *     `/openai/v1`、两个各自的覆盖变量、区域拼进域名）—— 现在两条链路是**同一条**地址
 *     （`wangsuBase()`），换区域这件事在网宿这边根本不存在。
 *   · **两套方言**（Claude 走 Anthropic Messages、GPT 走 OpenAI 兼容口）—— 现在两条都是
 *     OpenAI 兼容口，`provider` 都是 `wangsu`。所以「同一把 key 但方言是两套」那一条不是
 *     改个字符串的事，它钉的那件事没有了。
 *   · **`BEDROCK_API_KEY`** —— 换成 `WANGSU_API_KEY`。「一把 key 撑两条链路，缺了是一次
 *     少两栏」这件事本身没变，只是换了个变量名，所以那一条留着。
 *
 * **「三条链路各是一个家族」那一条一个字没动**：它是设计前提，不是出口细节。换网关的全部
 * 意义就是在境内可达的前提下保住它（Bedrock 那边是模型层按来源国拒绝，见 `registry.ts`）。
 *
 * `registry.ts` 里 `bedrockBase()` / `bedrockRuntimeBase()` / `bedrockRegion()` 还导出着，
 * 但 `baseUrlFor` 只在 `wangsu` 与 `ark` 之间分支 —— **没有任何模型经过它们**。这里不再为
 * 它们留断言：给死代码配测试会让下一个人以为那条路还在跑。真删它们是实现侧的事。
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MODELS, arkBase, getModel, wangsuBase } from "./registry";
import { SLOT_ALIAS, areIndependent, familyOf, resolveModel } from "./slots";

/**
 * 每条用例开跑前清干净的那几个变量。
 *
 * **配了真 key 的机器上不清就会全绿而没验到东西**：`resolveModel` 读的是
 * `process.env`，本机 `.env.local` 里那把 key 会让「没配 key 时返回 null」那条恒假。
 * 新增一个出口就要往这张表上补它的全部变量 —— 少补一个，那一条的失败只在别人机器上出现。
 *
 * DeepSeek 直连回落那三个变量是这一版补上的：上一版没清 `DEEPSEEK_BASE_URL`，
 * 而回落那条用例断言的正是那个默认地址。
 */
const KEYS = [
  "ARK_API_KEY",
  "ARK_BASE_URL",
  "ARK_MODEL_DEEPSEEK_PRO",
  "ARK_MODEL_DEEPSEEK_FLASH",
  "DEEPSEEK_API_KEY",
  "DEEPSEEK_BASE_URL",
  "DEEPSEEK_MODEL",
  "DEEPSEEK_MODEL_PRO",
  "WANGSU_API_KEY",
  "WANGSU_BASE_URL",
  "WANGSU_MODEL_OPUS5",
  "WANGSU_MODEL_GPT56",
] as const;

let saved: Record<string, string | undefined> = {};

beforeEach(() => {
  saved = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
  for (const k of KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("方舟那个出口", () => {
  it("模型广场打 /api/v3", () => {
    expect(arkBase()).toBe("https://ark.cn-beijing.volces.com/api/v3");
  });

  it("整条地址可以覆盖（部署期可能有代理路径）", () => {
    process.env.ARK_BASE_URL = "https://proxy.test/api/v3/";
    expect(arkBase()).toBe("https://proxy.test/api/v3");
  });

  it("改方舟的地址改不到网宿那条口上", () => {
    process.env.ARK_BASE_URL = "https://proxy.test/api/v3";
    expect(wangsuBase()).toBe("https://api.edgecloudapp.com/v2/llm");
  });
});

describe("网宿那个网关", () => {
  it("默认打 /v2/llm —— 深研那两条链路共用的一条地址", () => {
    expect(wangsuBase()).toBe("https://api.edgecloudapp.com/v2/llm");
  });

  it("整条地址可以覆盖，末尾的斜杠要去掉", () => {
    /*
     * 不去斜杠的话拼出来是 `…/v2/llm//chat/completions`。多一个斜杠有的网关认、有的回
     * 404，而 404 看起来像模型 id 写错了 —— 这条断言就是为了不再走一遍那次误判。
     */
    process.env.WANGSU_BASE_URL = "https://gw.test/v2/llm/";
    expect(wangsuBase()).toBe("https://gw.test/v2/llm");
  });

  it("改网宿的地址改不到方舟那条口上", () => {
    process.env.WANGSU_BASE_URL = "https://gw.test/v2/llm";
    expect(arkBase()).toBe("https://ark.cn-beijing.volces.com/api/v3");
  });
});

describe("注册表", () => {
  it("四个别名，一个都不吃 effort / verbosity —— 发过去是 400，不是被忽略", () => {
    expect(Object.keys(MODELS)).toEqual([
      "deepseek-pro",
      "deepseek-flash",
      "claude-opus-5",
      "gpt-5.6",
    ]);
    /*
     * 上一版这里只判方舟那两个。现在四个全是 false，理由是两条：方舟那两个本来就不认；
     * 网宿这条口只认 OpenAI 的标准字段（`model` / `messages` / `max_tokens` / `stream` /
     * `temperature`），`reasoning_effort` 与 `verbosity` 是各家自己的扩展，**发一个不认的
     * 字段是 400，整条链路当场挂掉**。
     *
     * 所以这一版里「按这一轮还剩多少时间调思考深度」这件事对 alt/synth 是发不出去的。
     * 等网宿那边确认支持再打开，届时要一并回答字段名走哪一套方言。
     */
    for (const m of Object.values(MODELS)) {
      expect(m.acceptsEffort, m.alias).toBe(false);
      expect(m.acceptsVerbosity, m.alias).toBe(false);
    }
  });

  it("两把 key，一把也不多 —— 配着却没有代码去读的 key 是个陷阱", () => {
    expect(new Set(Object.values(MODELS).map((m) => m.keyEnv))).toEqual(
      new Set(["ARK_API_KEY", "WANGSU_API_KEY"])
    );
  });

  it("方舟上那两个共用一把 key，走的是同一个地址、同一套方言", () => {
    for (const alias of ["deepseek-pro", "deepseek-flash"] as const) {
      expect(MODELS[alias].keyEnv, alias).toBe("ARK_API_KEY");
      expect(MODELS[alias].provider, alias).toBe("ark");
    }
  });

  it("网宿上那两个共用一把 key，而且是**同一套**方言", () => {
    expect(MODELS["deepseek-pro"].keyEnv).toBe("ARK_API_KEY");
    expect(MODELS["claude-opus-5"].keyEnv).toBe("WANGSU_API_KEY");
    expect(MODELS["gpt-5.6"].keyEnv).toBe("WANGSU_API_KEY");
    /*
     * **这一条正是换网关改掉的那件事。** Bedrock 那一版上，同一把 key、同一个域名下面是
     * 两个口（Claude 走 Anthropic Messages、GPT 走 OpenAI 兼容），所以 `complete.ts` 里要
     * 按 provider 分两套请求体拼法。网宿这边两条都是 OpenAI 兼容口，那条分支连同
     * `callClaudeOnBedrock` 一起删掉了。
     */
    expect(MODELS["claude-opus-5"].provider).toBe("wangsu");
    expect(MODELS["gpt-5.6"].provider).toBe("wangsu");
  });

  it("网宿上那两个都不发 temperature —— 少发一个字段不会让报告变差，发错一个会让链路挂掉", () => {
    /*
     * 网宿文档写着 temperature 支持，但 Claude 这一代原厂对它是 400，上游怎么归一化不确定。
     * 方舟那两个照旧发（`sampling: true`），所以这一条不能写成「表上全是 false」。
     */
    expect(MODELS["claude-opus-5"].sampling).toBe(false);
    expect(MODELS["gpt-5.6"].sampling).toBe(false);
    expect(MODELS["deepseek-pro"].sampling).toBe(true);
  });

  it("网宿上发的是裸模型名 —— 推理配置那套前缀是 Bedrock 的规矩，这里没有", () => {
    /*
     * Bedrock 上必须发 `us.anthropic.claude-opus-5` / `us.openai.gpt-5.6-sol`：基础模型 id
     * 在那个账号上是 INFERENCE_PROFILE-only，直接发 400/404。网宿这边就是模型名本身，
     * 带上那个前缀反而找不到。
     */
    expect(MODELS["claude-opus-5"].providerModelId).toBe("claude-opus-5");
    expect(MODELS["gpt-5.6"].providerModelId).toBe("gpt-5.6-sol");
  });

  it("provider_model_id 可由环境变量覆盖 —— 网关上叫什么名字是部署期才知道的事", () => {
    process.env.WANGSU_MODEL_OPUS5 = "claude-opus-5-20260801";
    expect(getModel("claude-opus-5").providerModelId).toBe("claude-opus-5-20260801");
  });

  it("未知别名要报出可选项，不能返回 undefined 让下游炸在别处", () => {
    // 拿已经下掉的那个当例子：它同时验「kimi-k3 真的不在表上了」。
    expect(() => getModel("kimi-k3")).toThrow(/deepseek-pro/);
  });
});

describe("familyOf", () => {
  it("认得出家族", () => {
    expect(familyOf("deepseek-v4-pro")).toBe("deepseek");
    // 换网关之后发出去的就是这两个裸名字，所以拿它们当例子。
    expect(familyOf("claude-opus-5")).toBe("claude");
    expect(familyOf("gpt-5.6-sol")).toBe("gpt");
    // 带前缀的老 id 也照旧认得出来：运行记录里存着一堆，读账那一侧还要按家族归并。
    expect(familyOf("us.anthropic.claude-opus-5")).toBe("claude");
    // 别名归并那一支（moonshot → kimi）留着：它是这个函数里唯一不平凡的一段。
    expect(familyOf("moonshot-v1-128k")).toBe("kimi");
  });

  it("猜不出来就返回模型名本身：宁可漏报，不要把两个不同的判成同一个", () => {
    expect(familyOf("ep-20260818-abcdef")).toBe("ep-20260818-abcdef");
  });
});

describe("槽位", () => {
  it("深研那几条链路互不同家族 —— 自己判自己会通过自己的失败模式", () => {
    /*
     * **换网关是为了保住这一条。** Bedrock 那边网络是通的，但 Anthropic 与 OpenAI 在模型层
     * 按来源国拒绝（400 `…not allowed from unsupported countries`），换 key、换区域都不解决。
     * 真让那两条落回 deepseek 的话，屏幕上仍旧摆着三栏，而三栏会一起犯同一类错。
     *
     * `flash` 不在这张表上：它不是链路，而且和 pro 同家族是有意的（见下面那一条）。
     */
    const lanes = ["pro", "alt", "synth"] as const;
    const families = lanes.map((s) => MODELS[SLOT_ALIAS[s]].family);
    expect(new Set(families).size).toBe(lanes.length);
    expect(families).toEqual(["deepseek", "claude", "gpt"]);
  });

  it("没有任何 key 时返回 null，不返回一个打不通的配置", () => {
    expect(resolveModel("pro")).toBeNull();
  });

  it("配了方舟那把就出 pro，并带上出错时要报的那个变量名", () => {
    process.env.ARK_API_KEY = "ark-plaza-key";
    const pro = resolveModel("pro");
    expect(pro?.keyEnv).toBe("ARK_API_KEY");
    expect(pro?.baseUrl.endsWith("/api/v3")).toBe(true);
    // 方舟那把配上了也解析不出另一把上的那两条链路。
    expect(resolveModel("alt")).toBeNull();
    expect(resolveModel("synth")).toBeNull();
  });

  it("N3 抽取那个槽位（flash）和 pro 同一把 key、同一个家族 —— 这是有意的", () => {
    /*
     * 2026-08-27 起七步链的逐页抽取押在 `flash` 上（原来是已撤掉的 `seed`/豆包）。上一条
     * 那个「互不同家族」的不变量管的是**判断** —— 谁写、谁复核、谁摆立场；抽取是「把这一页里
     * 的数字和引句照抄出来」，抄错了 N4 逐条对账会拿原文比出来。所以这里断言的是相反的一件
     * 事：它**就该**和 pro 同家族，改成别的家族要连 `slots.ts` 文件头那段理由一起改。
     *
     * 它缺了的表现也不一样：不是「少一栏」，是整段取证一页都抽不出东西。
     */
    expect(resolveModel("flash")).toBeNull();

    process.env.ARK_API_KEY = "ark-plaza-key";
    const flash = resolveModel("flash");
    expect(flash?.keyEnv).toBe("ARK_API_KEY");
    expect(flash?.provider).toBe("ark");
    expect(flash?.baseUrl).toBe("https://ark.cn-beijing.volces.com/api/v3");
    expect(areIndependent(resolveModel("pro")!, flash!)).toBe(false);
  });

  it("只配了 WANGSU_API_KEY 时，pro 槽位不许偷用它 —— 那会把账记到另一边", () => {
    process.env.WANGSU_API_KEY = "wangsu-key";
    expect(resolveModel("pro")).toBeNull();
    expect(resolveModel("flash")).toBeNull();
  });

  it("WANGSU_API_KEY 一把撑两条链路：一起有，一起没有", () => {
    /*
     * `alt` 与 `synth` 共用这一把。所以它缺了是**一次少两栏**，而且判断板的主源同时落回
     * `pro` —— 这条不变量写在这里，是因为屏幕上那两栏看起来是两件独立的事。
     *
     * 换网关之前撑这两条的是 `BEDROCK_API_KEY`，形状一模一样，只是那时两条链路的地址和
     * 方言各是一套；现在是同一条地址、同一套方言（见下面两条断言）。
     */
    expect(resolveModel("alt")).toBeNull();
    expect(resolveModel("synth")).toBeNull();

    process.env.WANGSU_API_KEY = "wangsu-key";
    const alt = resolveModel("alt");
    const synth = resolveModel("synth");
    expect(alt).not.toBeNull();
    expect(synth).not.toBeNull();
    expect(alt?.keyEnv).toBe("WANGSU_API_KEY");
    expect(synth?.keyEnv).toBe("WANGSU_API_KEY");
    // 一把 key、一条地址、一套方言。两条链路的区别只剩「是哪个模型」。
    expect(alt?.provider).toBe("wangsu");
    expect(synth?.provider).toBe("wangsu");
    expect(alt?.baseUrl).toBe(wangsuBase());
    expect(synth?.baseUrl).toBe(alt?.baseUrl);
    // 而这才是那两栏摆在屏幕上的全部理由。
    expect(areIndependent(alt!, synth!)).toBe(true);
  });

  it("换网关的地址一改就是两条一起改 —— 它们本来就是同一条", () => {
    /*
     * Bedrock 那一版这里钉的是相反的事：两个口各有自己的覆盖变量，共用一个会把 Claude 那条
     * 打歪成 404。网宿这边共用是**对的**，所以这一条正过来钉：配一个变量，两条一起走。
     */
    process.env.WANGSU_API_KEY = "wangsu-key";
    process.env.WANGSU_BASE_URL = "https://gw.test/v2/llm";
    expect(resolveModel("alt")?.baseUrl).toBe("https://gw.test/v2/llm");
    expect(resolveModel("synth")?.baseUrl).toBe("https://gw.test/v2/llm");
  });

  it("两把 key 全配上时，三条链路各是一个家族", () => {
    process.env.ARK_API_KEY = "ark-plaza-key";
    process.env.WANGSU_API_KEY = "wangsu-key";
    const live = (["pro", "alt", "synth"] as const).map((s) => resolveModel(s));
    expect(live.every((c) => c !== null)).toBe(true);
    expect(new Set(live.map((c) => c!.family)).size).toBe(3);
  });

  it("DeepSeek 直连回落只有 pro/flash：深研另外几条回落到 deepseek 等于把它们悄悄取消", () => {
    process.env.DEEPSEEK_API_KEY = "ds-key";
    expect(resolveModel("pro")?.baseUrl).toBe("https://api.deepseek.com/v1");
    expect(resolveModel("pro")?.provider).toBe("deepseek");
    expect(resolveModel("alt")).toBeNull();
    expect(resolveModel("synth")).toBeNull();
    // `flash` 跟着 pro 一起回落是允许的：它不是链路，回落之后仍旧只是「抽取用的那个便宜模型」。
    expect(resolveModel("flash")?.provider).toBe("deepseek");
  });

  it("SYNTH 配了就走网宿那条兼容口，扩展字段一个都不发", () => {
    process.env.WANGSU_API_KEY = "wangsu-key";
    const synth = resolveModel("synth");
    expect(synth?.baseUrl).toBe(wangsuBase());
    // 这三个字段 `complete.ts` 照着决定请求体里发不发对应的那一项。
    expect(synth?.sampling).toBe(false);
    expect(synth?.acceptsEffort).toBe(false);
    expect(synth?.acceptsVerbosity).toBe(false);
  });
});
