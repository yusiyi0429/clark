/**
 * 对话里说的模型要求落到派活单上（设计第 69 条）：本人原话（CardDraftView.modelWords，如「这几件用本机的 Opus，思考开高」）和这台电脑连着的来源、模型、思考程度对。
 * 不靠模型，只认说法：
 * - 来源：这台电脑上各来源给人看的名字（Claude 订阅、Codex 订阅、TokenHub、加进来的来源名），「订阅」指订阅那几个；「本机」「本地」「这台电脑」认得但不限定（都在本机）。
 * - 模型：模型目录里给人看的名字（Opus 5.5、GPT-6.1-Sol、deepseek-v4.1-flash），和常见的系列简称（Opus、Sonnet、Haiku、GPT、DeepSeek…，可带版本号）。
 * - 思考：低 / 中 / 高 / 超高 / 最高 / 极限，要跟「档」「思考」连着说；英文档位 low / medium / high / xhigh / max / ultra。
 * 认出几样用几样，没认出的那一样照派活单原来的（null）。三样一样都没认出算没对上；说了这台电脑没有的来源、模型，或同一样说了两个（两个模型、两个来源、两档思考），也算没对上，不猜。
 */
import type { TLocalEffort, TLocalModelProfile } from "@warmap/contracts";
import { sourceIdOf } from "./modelPanel";
import { plainSource, profileModel, profileSourceName, sourceName } from "./runModel";

export type ModelWordsMatch = { matched: false } | { matched: true; /** 预选的模型配置；没说模型、来源时为 null（照原来的）。 */ modelId: string | null; /** 预选的思考；没说为 null。 */ effort: TLocalEffort | null };

const NO = { matched: false } as const;
const norm = (text: string) => text.toLowerCase().replace(/[\s\-_·.]+/g, "");

/** 常见的模型系列（说了、这台电脑却没有时算没对上）。 */
const FAMILIES = ["opus", "sonnet", "haiku", "fable", "gpt", "deepseek", "qwen", "kimi", "glm", "gemini", "doubao"];
/** 常见的来源说法（说了、这台电脑却没连时算没对上）。 */
const KNOWN_SOURCES = ["claude订阅", "codex订阅", "tokenhub"];
/** 订阅两家的别的叫法。 */
const SUBSCRIPTION_ALIASES: Record<string, string[]> = { "claude-subscription": ["claudecode订阅", "cc订阅"], codex: ["chatgpt订阅"] };
const LOCAL_WORDS = ["本机", "本地", "这台电脑"];

const EFFORT_ZH: Record<string, TLocalEffort> = { 超高: "xhigh", 最高: "max", 极限: "ultra", 低: "low", 中: "medium", 高: "high" };
const EFFORT_EN: Record<string, TLocalEffort> = { low: "low", medium: "medium", high: "high", xhigh: "xhigh", max: "max", ultra: "ultra" };

/** 原话里说的思考档：一档都没说为 null，说了两档不一样为 "conflict"。 */
function effortIn(words: string): TLocalEffort | null | "conflict" {
  const found = new Set<TLocalEffort>();
  for (const match of words.matchAll(/(超高|最高|极限|低|中|高)\s*(?:档|思考)/g)) found.add(EFFORT_ZH[match[1]!]!);
  for (const match of words.matchAll(/思考(?:程度)?\s*(?:开|用|调到|调成|设为|设成|给|要|是)?\s*(超高|最高|极限|低|中|高)/g)) found.add(EFFORT_ZH[match[1]!]!);
  for (const match of words.toLowerCase().matchAll(/(?<![a-z])(xhigh|low|medium|high|max|ultra)(?![a-z])/g)) found.add(EFFORT_EN[match[1]!]!);
  if (found.size > 1) return "conflict";
  return [...found][0] ?? null;
}

export function matchModelWords(words: string, models: readonly TLocalModelProfile[]): ModelWordsMatch {
  const said = norm(words);
  // 来源：按本机认出的归组，每个来源的几种叫法。
  const sources = new Map<string, { names: string[]; subscription: boolean }>();
  for (const profile of models) {
    const id = sourceIdOf(profile);
    const entry = sources.get(id) ?? { names: [], subscription: profile.source === "subscription" };
    const full = plainSource(profileSourceName(profile));
    entry.names.push(norm(full), norm(sourceName(full) ?? full), ...(profile.origin ? [norm(profile.origin.provider)] : []), ...(SUBSCRIPTION_ALIASES[id] ?? []));
    sources.set(id, entry);
  }
  const named = [...sources].filter(([, entry]) => entry.names.some((name) => name && said.includes(name))).map(([id]) => id);
  if (named.length > 1) return NO;
  const missingSource = KNOWN_SOURCES.some((name) => said.includes(name)) && !named.length;
  if (missingSource) return NO;
  const subscriptions = [...sources].filter(([, entry]) => entry.subscription).map(([id]) => id);
  const sourcePool = named.length ? named : said.includes("订阅") ? subscriptions : null;
  if (sourcePool && !sourcePool.length) return NO;
  const local = LOCAL_WORDS.some((word) => words.includes(word));

  // 模型：先认目录里给人看的全名（多个名字都说到了是打架），没有再认系列简称（可带版本号）。
  const byName = models.filter((profile) => { const name = norm(profileModel(profile)); return name !== "自动" && name.length > 2 && said.includes(name); });
  let candidates = byName;
  if (new Set(byName.map((profile) => norm(profileModel(profile)))).size > 1) return NO;
  if (!candidates.length) {
    const lower = words.toLowerCase();
    const families = FAMILIES.filter((family) => new RegExp(`(?<![a-z])${family}`).test(lower));
    if (families.length > 1) return NO;
    const family = families[0];
    if (family) {
      const version = new RegExp(`(?<![a-z])${family}[\\s-]*v?(\\d+(?:\\.\\d+)?)`).exec(lower)?.[1] ?? null;
      candidates = models.filter((profile) => {
        const name = norm(`${profileModel(profile)} ${profile.model ?? ""}`);
        return name.includes(family) && (!version || name.includes(norm(version)));
      });
      if (!candidates.length) return NO;
    }
  }
  const effort = effortIn(words);
  if (effort === "conflict") return NO;

  let modelId: string | null = null;
  if (candidates.length) {
    const pool = sourcePool ? candidates.filter((profile) => sourcePool.includes(sourceIdOf(profile))) : candidates;
    if (!pool.length) return NO;
    const defaultSource = models.find((profile) => profile.isDefault);
    modelId = (pool.find((profile) => profile.isDefault) ?? pool.find((profile) => defaultSource && sourceIdOf(profile) === sourceIdOf(defaultSource)) ?? pool[0]!).id;
  } else if (sourcePool) {
    // 只说了来源：那个来源的默认模型（标了默认的，没有就第一个）；「订阅」两家都连着又没说模型，分不出是哪家。
    if (sourcePool.length > 1) return NO;
    const own = models.filter((profile) => sourceIdOf(profile) === sourcePool[0]);
    modelId = (own.find((profile) => profile.isDefault) ?? own[0])?.id ?? null;
  }
  if (!modelId && !effort && !local) return NO;
  return { matched: true, modelId, effort };
}
