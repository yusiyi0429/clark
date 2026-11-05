import { join } from "node:path";
import type { TLocalModelProfile, TLocalModelProfileUpsert } from "@warmap/contracts";
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
  apiKey: string | null;
}

type Stored = Omit<TLocalModelProfile, "hasKey">;

const builtIn: Stored = {
  id: SUBSCRIPTION_ID, label: "我的 Claude 订阅", source: "subscription", agent: "claude-code",
  baseUrl: null, model: null, smallModel: null, isDefault: true,
};

const keyName = (id: string) => `model:${id}`;

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
    for (const p of this.stored()) out.push({ ...p, hasKey: p.source === "gateway" ? Boolean(await this.secrets.get(keyName(p.id))) : false });
    return out;
  }

  async upsert(id: string, body: TLocalModelProfileUpsert): Promise<TLocalModelProfile> {
    if (id === SUBSCRIPTION_ID) throw new Error("内置的订阅配置不能改");
    let list = this.stored().slice(1);
    if (body.isDefault) list = list.map((p) => ({ ...p, isDefault: false }));
    const prev = list.find((p) => p.id === id);
    const next: Stored = {
      id, label: body.label, source: "gateway", agent: body.agent ?? "claude-code",
      baseUrl: body.baseUrl.replace(/\/+$/, ""), model: body.model, smallModel: body.smallModel ?? null,
      isDefault: body.isDefault ?? prev?.isDefault ?? false,
    };
    list = prev ? list.map((p) => (p.id === id ? next : p)) : [...list, next];
    writeJsonAtomic(this.file, list);
    if (body.apiKey !== undefined) {
      if (body.apiKey === "") await this.secrets.delete(keyName(id));
      else await this.secrets.set(keyName(id), body.apiKey);
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

  async resolve(id?: string): Promise<ResolvedModel | null> {
    const all = this.stored();
    const p = id ? all.find((x) => x.id === id) : all.find((x) => x.isDefault) ?? all[0];
    if (!p) return null;
    return {
      profileId: p.id, label: p.label, source: p.source,
      baseUrl: p.baseUrl, model: p.model, smallModel: p.smallModel,
      apiKey: p.source === "gateway" ? await this.secrets.get(keyName(p.id)) : null,
    };
  }
}
