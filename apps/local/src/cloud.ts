import { join } from "node:path";
import type { TLocalCloudLinkView, TLocalSettings, TLocalSettingsPatch } from "@warmap/contracts";
import { readJson, writeJsonAtomic } from "./store.js";
import type { SecretStore } from "./secrets.js";
import type { CloudTarget, Outbox } from "./outbox.js";

const TOKEN_KEY = "cloud:token";

/** 和天枢云端的关联：地址、本人名字放 cloud.json，令牌放系统凭据库。 */
export class CloudLink {
  private readonly file: string;
  outbox: Outbox | null = null;

  constructor(dataDir: string, private readonly secrets: SecretStore, private readonly allowedOrigins: readonly string[]) {
    this.file = join(dataDir, "cloud.json");
  }

  private meta() { return readJson<{ apiBaseUrl?: string; personName?: string }>(this.file, {}); }

  /** 云端地址必须和允许直连的网页同源，免得被指到别处把结果送出去。 */
  originAllowed(apiBaseUrl: string): boolean {
    try { return this.allowedOrigins.includes(new URL(apiBaseUrl).origin); } catch { return false; }
  }

  async link(apiBaseUrl: string, token: string, personName?: string): Promise<void> {
    await this.secrets.set(TOKEN_KEY, token);
    writeJsonAtomic(this.file, { apiBaseUrl: new URL(apiBaseUrl).toString(), personName: personName ?? null });
    this.outbox?.kick();
  }

  async unlink(): Promise<void> {
    await this.secrets.delete(TOKEN_KEY);
    writeJsonAtomic(this.file, {});
  }

  async target(): Promise<CloudTarget | null> {
    const m = this.meta();
    if (!m.apiBaseUrl) return null;
    const token = await this.secrets.get(TOKEN_KEY);
    return token ? { apiBaseUrl: m.apiBaseUrl, token } : null;
  }

  view(): TLocalCloudLinkView {
    const m = this.meta();
    return {
      linked: Boolean(m.apiBaseUrl),
      apiBaseUrl: m.apiBaseUrl ?? null,
      personName: m.personName ?? null,
      outbox: this.outbox?.status() ?? { pending: 0, lastSyncedAt: null, lastError: null },
    };
  }
}

export class Settings {
  private readonly file: string;
  constructor(dataDir: string, private readonly allowedOrigins: readonly string[]) { this.file = join(dataDir, "settings.json"); }
  get(): TLocalSettings {
    const s = readJson<Partial<TLocalSettings>>(this.file, {});
    return {
      includePersonalConfigByDefault: s.includePersonalConfigByDefault ?? false, paused: s.paused ?? false, allowedOrigins: [...this.allowedOrigins],
      maxConcurrent: s.maxConcurrent ?? 3,
    };
  }
  patch(p: TLocalSettingsPatch): TLocalSettings {
    const cur = this.get();
    const next = {
      includePersonalConfigByDefault: p.includePersonalConfigByDefault ?? cur.includePersonalConfigByDefault, paused: p.paused ?? cur.paused,
      maxConcurrent: p.maxConcurrent ?? cur.maxConcurrent,
    };
    writeJsonAtomic(this.file, next);
    return this.get();
  }
}
