/**
 * 模型槽位。**按角色配，不按厂商配。**
 *
 * ## 四个槽位，两把 key
 *
 * · `pro`：对话、预研、四节压缩、反证复核，以及深研第一条链路（屏幕上「DeepSeek」那一栏）。
 *   没有它整轮都跑不了。走 `ARK_API_KEY`。
 * · `flash`：短活与选路，**以及七步链里 N3 那一步逐页抽取**（见下一节）。不是链路，屏幕上
 *   没有它的页签。也走 `ARK_API_KEY`。
 * · `alt`：深研第二条链路（屏幕上「Claude」那一栏）。
 * · `synth`：深研第三条链路（屏幕上「ChatGPT」那一栏），**也是判断板的主源** —— 四节压缩、
 *   立案、写回都从它那一份来。不配也跑得起来：主源顺位落到 `pro` 那一条。
 *
 * `alt` 与 `synth` **共用 `WANGSU_API_KEY`**（同一个网关上供的两个家族，走的是
 * 出口方言不同，见 `registry.ts`）。所以那把 key 缺了是一次少两栏，而且判断板的主源同时
 * 落回 `pro`。
 *
 * 2026-08-27 之前还有第五个槽位 `seed`（方舟上的 Doubao-Seed-Evolving，屏幕上「豆包」那
 * 一栏），撤掉了 —— 依据是一轮真运行的账，见 `registry.ts` 文件头。它原来干的 N3 抽取
 * 交给了 `flash`。
 *
 * ## 「一条链路一整套深研」只在旧那一支成立
 *
 * 上面那几栏名字（DeepSeek / Claude / ChatGPT）说的是**多链路那一支**：各自编命题、各自
 * 联网取证、各自写报告、各自过出口对账，同时跑、同时显示、各自计时（2026-08-25 起，
 * `TKOS_DR_V2=0` 才走）。
 *
 * **2026-08-26 起默认走的是七步链那一支，它按活分槽位，不按链路分**：
 *
 * · `pro`：N0 主体卡、N2 检索计划。
 * · `flash`：N3 一页一次的抽取。调用次数最多、每次最便宜（2026-08-27 之前是 `seed`）。
 * · `alt`：N1 草稿、N5 排结构与每一节与收口 —— **整份报告的字都是它写的**，所以这一版里
 *   它的 token 量比别的槽位高一个量级不是异常，是分工。
 * · `synth`：N4 逐条对账，以及 N6 那几次锚点相关性检查（500 tokens 一次）。
 *
 * **N4 归 `synth` 是这张表上唯一一处「非要换个人不可」的地方**：它判的是 `alt` 写的那份
 * 草稿站不站得住。2026-08-27 之前它也在 `alt` 上 —— 那时整条链从草稿到成稿到复核都是同一个
 * 模型，没有一步是别人核的，而屏幕上仍旧写着「已对账」。这正是下一节那条不变量说的事。
 *
 * 判断板的主源仍旧按上面那一段走。这几段过期的样子不是报错：是照着它去查用量，
 * 然后把「分工如此」读成「有一条链路挂了」。
 *
 * **N3 抽取用同家族的 `flash` 是有意的，不要「修」成别的家族。** 下一节那条不变量管的是
 * **判断**：谁写、谁复核、谁摆立场，那几件事同家族会一起犯错。抽取不是判断，它是「把这一页
 * 里的数字和引句照抄出来」，抄错了 N4 逐条对账那一步会拿原文比出来。押在 `flash` 上的理由
 * 是它便宜、方舟侧自动命中缓存（Bedrock 侧一次都不命中），而抽取是整条链调用次数最多的一步。
 *
 * ## 不变量：深研那几条链路（`pro` / `alt` / `synth`）互不同家族
 *
 * 理由不是「要用不同厂商」，是**自己判自己会通过自己的失败模式**。alt 退化成和 pro 同一个
 * 模型，那两条链路会稳定放过同一类错误，而「两条链路都这么说」这句话反而更有说服力 —— 从
 * 指标上看不出来。几条链路同家族更糟：它们会一起漏掉同一个来源，而屏幕上仍然摆着几栏，看
 * 起来像是几份互相印证过。
 */
import {
  MODELS,
  type ModelAlias,
  type Provider,
  arkKey,
  baseUrlFor,
  getModel,
  maxOutputFor,
} from "./registry";

/**
 * 槽位。**新增一个槽位是有代价的**：`SLOT_ALIAS` 是全映射，`complete.ts` 里的
 * `SLOT_BY_ALIAS` 也是 —— 少补一行编译不过。这是有意的：一个别名对不上任何槽位，
 * 表现是运行到那一步才抛「没有可用出口」。
 */
export type Slot = "pro" | "flash" | "alt" | "synth";

export type ModelConfig = {
  slot: Slot;
  /** 注册表别名；DeepSeek 直连回落时是模型名本身。 */
  alias: string;
  baseUrl: string;
  apiKey: string;
  /** 真正发给服务端的 model 字段。 */
  model: string;
  /** 照哪一套方言拼请求体（见 `complete.ts`）。 */
  provider: Provider;
  family: string;
  acceptsEffort: boolean;
  sampling: boolean;
  /**
   * 这一次最多能让它输出多少 token。**请求里报的额度会被这个数压一次**
   * （`complete.ts` 那道 clamp）—— 超上限在方舟和 Bedrock 上是 400，不是被截短。
   *
   * 已经算过 `TKOS_MAX_OUTPUT_TOKENS` 覆盖（`maxOutputFor`），所以下游直接用，
   * 不要再去读那个变量。
   */
  maxOutput: number;
  /** 认不认 `verbosity`。见 `ModelSpec.acceptsVerbosity`。 */
  acceptsVerbosity: boolean;
  /** 401 / 未开通时要报出「该补哪一把」。 */
  keyEnv: string;
};

/**
 * 槽位到别名的映射。写死在这里而不是再开几个环境变量：换模型 id 已经有
 * `ARK_MODEL_*` / `WANGSU_MODEL_*` 可以覆盖，再加一层「槽位配别名」只是多一处
 * 能配歪的地方。
 *
 * `alt` 取 Bedrock 上的 Claude Opus 5、`synth` 取 Bedrock 上的 GPT-5.6：和 pro/flash 的
 * deepseek 凑成三个家族。alt/synth 共用一把 key、pro/flash 共用另一把（见文件头），所以
 * 「不同家族」这条不变量是靠模型本身撑的，不是靠「一条链路一把 key」撑的 —— 后者早就
 * 不成立了。
 */
export const SLOT_ALIAS: Record<Slot, ModelAlias> = {
  pro: "deepseek-pro",
  flash: "deepseek-flash",
  alt: "claude-opus-5",
  synth: "gpt-5.6",
};

const DEEPSEEK_BASE = "https://api.deepseek.com/v1";
const trimSlash = (s: string) => s.replace(/\/+$/, "");

/**
 * 从模型名猜家族。够用就行 —— 它只服务一件事：判断两次调用是不是「独立」的。
 * 猜不出来时返回模型名本身，宁可把两个同家族的判成不同（漏报），
 * 也不要把两个不同的判成同一个（误报会让交叉校验被误停）。
 */
export function familyOf(model: string): string {
  const m = model.toLowerCase();
  for (const f of [
    "deepseek", "doubao", "kimi", "moonshot", "qwen", "glm",
    "ernie", "step", "minimax", "gpt", "claude", "gemini",
  ]) {
    if (m.includes(f)) return f === "moonshot" ? "kimi" : f;
  }
  return m;
}

/**
 * 解析一个槽位。**这把 key 配了就用它**；没配的话，pro / flash 还有一条 DeepSeek
 * 官方直连的回落，深研那两条（alt / synth）没有 —— 它们的全部意义是
 * 「另一个家族」，回落到 deepseek 就等于把这件事悄悄取消掉。
 *
 * 返回 null 是正常结果，不是故障：那一条链路这一轮不跑，页签上少那一栏，深研照跑。
 * 调用方照这个判断，不要自己去读环境变量。
 *
 * 回落那条**不进注册表**：`.env.local` 里 `DEEPSEEK_*` 当前是注释掉的，为一条
 * 没启用的路径加两个 `ModelSpec` 只是多两处要维护的地方。留着它是因为删掉属于
 * 与本轮无关的行为变更。
 */
export function resolveModel(slot: Slot): ModelConfig | null {
  // 走 getModel 而不是直接读 MODELS：只有它会读 `ARK_MODEL_*` / `WANGSU_MODEL_*` 覆盖。
  const spec = getModel(SLOT_ALIAS[slot]);
  const key = arkKey(spec.keyEnv);
  if (key) {
    return {
      slot,
      alias: spec.alias,
      baseUrl: baseUrlFor(spec),
      apiKey: key,
      model: spec.providerModelId,
      provider: spec.provider,
      family: spec.family,
      acceptsEffort: spec.acceptsEffort,
      sampling: spec.sampling,
      maxOutput: maxOutputFor(spec),
      acceptsVerbosity: spec.acceptsVerbosity,
      keyEnv: spec.keyEnv,
    };
  }

  const dsKey = (process.env.DEEPSEEK_API_KEY ?? "").trim();
  if (dsKey && (slot === "pro" || slot === "flash")) {
    const model =
      slot === "pro"
        ? (process.env.DEEPSEEK_MODEL_PRO ?? "deepseek-v4-pro")
        : (process.env.DEEPSEEK_MODEL ?? "deepseek-v4-flash");
    return {
      slot,
      alias: model,
      baseUrl: trimSlash(process.env.DEEPSEEK_BASE_URL ?? DEEPSEEK_BASE),
      apiKey: dsKey,
      model,
      provider: "deepseek",
      family: familyOf(model),
      acceptsEffort: false,
      sampling: true,
      /*
       * 这条回落不在注册表上（见上面那段），所以这两个值只能写在这里。8192 比表上那几个
       * 更保守：官方直连的单次上限没查过，而这条路只在方舟那把 key 缺了的时候才走 —— 那时
       * 出稿写不长的代价比整条挂掉小。真要用它出长稿就配 `TKOS_MAX_OUTPUT_TOKENS`。
       */
      maxOutput: maxOutputFor({ maxOutput: 8192 }),
      acceptsVerbosity: false,
      keyEnv: "DEEPSEEK_API_KEY",
    };
  }
  return null;
}

/**
 * 两个配置是不是「独立」的。交叉 judge 与双源对照在动手前问这一句。
 * 同家族 → 不独立，因为它们大概率共享同一批失败模式。
 */
export const areIndependent = (a: ModelConfig, b: ModelConfig): boolean => a.family !== b.family;

let warned = false;

/**
 * 深研那几条链路的槽位，按屏幕上从左到右的顺序 —— 告警文案里报的就是这几个中文名。
 *
 * `flash` 不在里面：它不是链路，缺了也不会少一栏 —— 而且它和 `pro` 同一把 key、同一个家族，
 * 摆进去会让下面那道家族撞车自检每次启动都报一句假警。它在七步链里干 N3 抽取，那一步缺了
 * 的表现是「取证一页都没抽出来」，不是「少一栏」。第一条（`pro`）单独判，因为它缺了是整轮
 * 都跑不了。
 */
const LANE_SLOTS: { slot: Slot; label: string }[] = [
  { slot: "pro", label: "DeepSeek" },
  { slot: "alt", label: "Claude" },
  { slot: "synth", label: "ChatGPT" },
];

/**
 * 启动期自检。**只告警不阻断。**
 *
 * pro 那条是真故障：接不上模型，每条链路都跑不了。别的槽位缺了是「这一轮深研会少一栏」
 * —— 报得出「少哪一栏、补哪把 key」就够了，措辞不要写成故障。
 *
 * alt 与 synth 共用一把 key，所以两条都缺时**合成一句**说：分开两句会把同一个变量名报两遍，
 * 读的人会以为要补两把，去控制台找第二把不存在的 key。
 */
export function assertSlotSanity(): void {
  if (warned) return;
  warned = true;
  const pro = resolveModel("pro");
  const alt = resolveModel("alt");
  const synth = resolveModel("synth");
  const altKeyEnv = MODELS[SLOT_ALIAS.alt].keyEnv;
  const synthKeyEnv = MODELS[SLOT_ALIAS.synth].keyEnv;

  if (!pro) {
    console.warn(
      `[tkos:models] 没有可用的 pro 槽位 —— 对话与研究都接不上模型。` +
        `补 ${MODELS[SLOT_ALIAS.pro].keyEnv}。`
    );
    return;
  }
  if (!alt && !synth && altKeyEnv === synthKeyEnv) {
    console.warn(
      `[tkos:models] 没配 ${altKeyEnv} —— 深研的「Claude」和「ChatGPT」两条链路一起没有。` +
        `剩下几条照跑，而**判断板的主源本来是 ChatGPT 那一份** —— ` +
        `主源顺位会落到 DeepSeek，屏幕上和这一轮的运行记录里都会写明换了谁。`
    );
  } else {
    if (!alt) {
      console.warn(
        `[tkos:models] 没配 ALT 槽位（缺 ${altKeyEnv}）。` +
          `深研照跑，只是少「Claude」那一条链路 —— 剩下几条各自照旧编命题、取证、写报告。`
      );
    }
    if (!synth) {
      console.warn(
        `[tkos:models] 没配 SYNTH 槽位（缺 ${synthKeyEnv}）。` +
          `深研照跑，但少「ChatGPT」那一条链路，而**判断板的主源本来是它** —— ` +
          `主源顺位会落到 DeepSeek 那一条，屏幕上和这一轮的运行记录里都会写明换了谁。`
      );
    }
  }
  /*
   * **这里没有 `flash` 那一句，别补。** N3 抽取押在它上面（见文件头），所以它缺了确实要紧，
   * 但走到这一行它不可能是 null：`resolveModel` 对 pro 与 flash 用的是同一个条件（方舟那把，
   * 否则 DeepSeek 直连那把），而 pro 为 null 时上面已经 return 了。补一句只是永不触发的死码。
   */
  /*
   * 家族撞车逐条报。只跟 pro 比不够：alt 与 synth 同家族一样是「两栏说同一句话」，
   * 而那两栏在屏幕上摆得最开，看起来最像互相印证过。
   */
  const lanes = LANE_SLOTS.map((l) => ({ ...l, cfg: resolveModel(l.slot) })).filter(
    (l): l is { slot: Slot; label: string; cfg: ModelConfig } => l.cfg !== null
  );
  for (let i = 0; i < lanes.length; i += 1) {
    for (let j = i + 1; j < lanes.length; j += 1) {
      const a = lanes[i];
      const b = lanes[j];
      if (!areIndependent(a.cfg, b.cfg)) {
        console.warn(
          `[tkos:models] 「${a.label}」(${a.cfg.model}) 与 「${b.label}」(${b.cfg.model}) 是` +
            `同一家族「${a.cfg.family}」。那两条链路会一起犯同一类错，而屏幕上看着是` +
            `「两条链路都这么说」。换一个不同家族的模型。`
        );
      }
    }
  }
  const line = lanes.map((l) => `${l.cfg.slot}=${l.cfg.alias}(${l.cfg.family})`).join("  ");
  const families = new Set(lanes.map((l) => l.cfg.family));
  const allLive = lanes.length === LANE_SLOTS.length && families.size === LANE_SLOTS.length;
  console.log(
    `[tkos:models] ${line}` + (allLive ? `  ✓ ${LANE_SLOTS.length} 条深研链路互不同家族` : "")
  );
}
