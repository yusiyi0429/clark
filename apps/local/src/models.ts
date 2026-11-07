import { join } from "node:path";
import type { TLocalModelProfile, TLocalModelProfileUpsert, TLocalModelTier } from "@warmap/contracts";
import { readJson, writeJsonAtomic } from "./store.js";
import type { SecretStore } from "./secrets.js";

export const SUBSCRIPTION_ID = "subscription";

/** 拉起执行方时用的完整模型配置（含钥匙），只在本机进程里流转。 */
export interface ResolvedModel {
  profileId: string;
  label: string;
  source: "subscription" | "gateway";
  baseUrl: string | null;
  model: string | null;
  smallModel: string | null;
  webSearch: boolean;
  apiKey: string | null;
}

type Stored = Omit<TLocalModelProfile, "hasKey">;

const builtIn: Stored = {
  id: SUBSCRIPTION_ID, label: "我的 Claude 订阅", source: "subscription", agent: "claude-code",
  baseUrl: null, model: null, smallModel: null, webSearch: true, isDefault: true,
};

const keyName = (id: string) => `model:${id}`;
/** 档位怎么认模型：和网页（apps/web 的 modelForTier）同一套。 */
const TIER_MATCH: Record<TLocalModelTier, RegExp> = { strong: /opus/i, normal: /sonnet/i, light: /haiku|flash|mini|lite/i };

/**
 * 经网关实测会真的执行 Claude Code 自带联网搜索的模型（11/06，TokenHub 的 Anthropic 入口）。不在这里的网关模型默认关掉自带搜索：
 * 不支持的会静默不搜、凭记忆编结果。本人实测过别的模型能搜，可以在模型配置里手动打开。
 */
export const VERIFIED_SEARCH_MODELS = ["wangsu/claude-opus-5-5", "wangsu/deepseek-v4.1-flash"];
const searchDefault = (source: string, model: string | null) => source !== "gateway" || VERIFIED_SEARCH_MODELS.includes(model ?? "");

export class ModelProfiles {
  private readonly file: string;
  constructor(dataDir: string, private readonly secrets: SecretStore) { this.file = join(dataDir, "models.json"); }

  private stored(): Stored[] {
    const list = readJson<Stored[]>(this.file, []).filter((p) => p.id !== SUBSCRIPTION_ID);
    const hasDefault = list.some((p) => p.isDefault);
    return [{ ...builtIn, isDefault: !hasDefault }, ...list];
  }

  async list(): Promise<TLocalModelProfile[]> {
    const out: TLocalModelProfile[] = [];
    for (const p of this.stored()) out.push({ ...p, webSearch: p.webSearch ?? searchDefault(p.source, p.model), hasKey: p.source === "gateway" ? Boolean(await this.secrets.get(keyName(p.id))) : false });
    return out;
  }

  async upsert(id: string, body: TLocalModelProfileUpsert): Promise<TLocalModelProfile> {
    if (id === SUBSCRIPTION_ID) throw new Error("内置的订阅配置不能改");
    const gateway = body.source === "gateway";
    if (gateway && !body.baseUrl) throw new Error("网关模型要填地址");
    if (!gateway && (body.baseUrl || body.apiKey)) throw new Error("订阅模型不填地址和钥匙");
    let list = this.stored().slice(1);
    if (body.isDefault) list = list.map((p) => ({ ...p, isDefault: false }));
    const prev = list.find((p) => p.id === id);
    const next: Stored = {
      id, label: body.label, source: body.source, agent: body.agent ?? "claude-code",
      baseUrl: gateway ? body.baseUrl!.replace(/\/+$/, "") : null, model: body.model, smallModel: body.smallModel ?? null,
      webSearch: body.webSearch ?? searchDefault(body.source, body.model),
      isDefault: body.isDefault ?? prev?.isDefault ?? false,
    };
    list = prev ? list.map((p) => (p.id === id ? next : p)) : [...list, next];
    writeJsonAtomic(this.file, list);
    if (!gateway) await this.secrets.delete(keyName(id));
    else if (body.apiKey !== undefined) {
      if (body.apiKey === "") await this.secrets.delete(keyName(id));
      else await this.secrets.set(keyName(id), body.apiKey);
    } else if (prev && prev.baseUrl !== next.baseUrl) {
      // 地址变了却没给新钥匙：旧钥匙作废，免得被网页改个地址就把本人的钥匙发到别处。
      await this.secrets.delete(keyName(id));
    }
    return (await this.list()).find((p) => p.id === id)!;
  }

  async remove(id: string): Promise<boolean> {
    if (id === SUBSCRIPTION_ID) return false;
    const list = this.stored().slice(1);
    if (!list.some((p) => p.id === id)) return false;
    writeJsonAtomic(this.file, list.filter((p) => p.id !== id));
    await this.secrets.delete(keyName(id));
    return true;
  }

  /** 这个配置是订阅还是网关（没有这个配置为 null）：额度用完时只停订阅的卡。 */
  sourceOf(id: string): "subscription" | "gateway" | null {
    return this.stored().find((p) => p.id === id)?.source ?? null;
  }

  /** 按档位挑模型（验收员由本机自己起时用）：和网页一样按模型名和名字认，认不出用默认的。 */
  forTier(tier: TLocalModelTier): string {
    const all = this.stored();
    return (all.find((p) => TIER_MATCH[tier].test(`${p.model ?? ""} ${p.label}`)) ?? all.find((p) => p.isDefault) ?? all[0]!).id;
  }

  async resolve(id?: string): Promise<ResolvedModel | null> {
    const all = this.stored();
    const p = id ? all.find((x) => x.id === id) : all.find((x) => x.isDefault) ?? all[0];
    if (!p) return null;
    return {
      profileId: p.id, label: p.label, source: p.source,
      baseUrl: p.baseUrl, model: p.model, smallModel: p.smallModel, webSearch: p.webSearch ?? searchDefault(p.source, p.model),
      apiKey: p.source === "gateway" ? await this.secrets.get(keyName(p.id)) : null,
    };
  }
}
