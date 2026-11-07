import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import { LOCAL_RUNNER_ATTACHMENT_PATH, LOCAL_RUNNER_VERIFY_BRIEF_PATH, LocalVerifyBriefResponse, type TLocalCloudLinkView, type TLocalSettings, type TLocalSettingsPatch, type TLocalVerifyBriefResponse } from "@warmap/contracts";
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

  private meta() { return readJson<{ apiBaseUrl?: string; personName?: string | null; personId?: string | null }>(this.file, {}); }

  /** 云端地址必须和允许直连的网页同源，免得被指到别处把结果送出去。 */
  originAllowed(apiBaseUrl: string): boolean {
    try { return this.allowedOrigins.includes(new URL(apiBaseUrl).origin); } catch { return false; }
  }

  async link(apiBaseUrl: string, token: string, person: { personName?: string; personId?: string }): Promise<void> {
    await this.secrets.set(TOKEN_KEY, token);
    writeJsonAtomic(this.file, { apiBaseUrl: new URL(apiBaseUrl).toString(), personName: person.personName ?? null, personId: person.personId ?? null });
    this.outbox?.kick();
  }

  async unlink(): Promise<void> {
    await this.secrets.delete(TOKEN_KEY);
    writeJsonAtomic(this.file, {});
  }

  /** 同步说这个令牌被拒（401）：还是它就当成没关联（网页会自己重新关联），发件箱留着；网页已经换了新令牌就不动。 */
  async rejected(token: string): Promise<void> {
    if ((await this.secrets.get(TOKEN_KEY)) === token) await this.unlink();
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
      personId: m.personId ?? null,
      outbox: this.outbox?.status() ?? { pending: 0, lastSyncedAt: null, lastError: null },
    };
  }
}

/** 取验收交代的结果：ok 拿到了；not_linked 还没连天枢；gone 天枢上没有这次交回（404）；done 这次交回已有结论（409）。 */
export type VerifyBrief = { kind: "ok"; brief: TLocalVerifyBriefResponse } | { kind: "not_linked" } | { kind: "gone" } | { kind: "done" };

/** 向天枢取一次交回的验收交代。连不上、5xx、格式不对时抛错，由调用方稍后再试。 */
export async function fetchVerifyBrief(target: CloudTarget | null, handbackKey: string, fetchImpl: typeof fetch): Promise<VerifyBrief> {
  if (!target) return { kind: "not_linked" };
  const url = new URL(LOCAL_RUNNER_VERIFY_BRIEF_PATH, target.apiBaseUrl);
  url.searchParams.set("handbackKey", handbackKey);
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${target.token}` }, signal: AbortSignal.timeout(30_000) });
  if (res.status === 404) return { kind: "gone" };
  if (res.status === 409) return { kind: "done" };
  if (!res.ok) throw new Error(res.status === 401 ? "云端令牌无效，请在天枢网页里重新连接本机" : `天枢返回 ${res.status}`);
  const body = (await res.json()) as unknown;
  if (!Value.Check(LocalVerifyBriefResponse, body)) throw new Error("天枢的验收交代格式不对");
  return { kind: "ok", brief: body };
}

/**
 * 从天枢取回一句话的一个附件（新首页设计 14.5，B 的 334f1ade）：GET <apiBaseUrl>/api/local-runner/attachments/:id，带本机的令牌，回文件原文。
 * 说了超过 30 MB 的不往下读。sha256 由调用方按开工请求里的核对。
 */
export async function fetchAttachment(target: CloudTarget | null, id: string, fetchImpl: typeof fetch, maxBytes: number): Promise<{ bytes: Buffer; mimeType: string | null } | { tooLarge: true }> {
  if (!target) throw new Error("没连天枢");
  const url = new URL(LOCAL_RUNNER_ATTACHMENT_PATH.replace(":id", encodeURIComponent(id)), target.apiBaseUrl);
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${target.token}` }, signal: AbortSignal.timeout(120_000) });
  if (res.status === 404) throw new Error("天枢上没有这个附件");
  if (!res.ok) throw new Error(res.status === 401 ? "云端令牌无效，请在天枢网页里重新连接本机" : `天枢返回 ${res.status}`);
  if (Number(res.headers.get("content-length") ?? 0) > maxBytes) return { tooLarge: true };
  return { bytes: Buffer.from(await res.arrayBuffer()), mimeType: res.headers.get("content-type") };
}

export class Settings {
  private readonly file: string;
  constructor(dataDir: string, private readonly allowedOrigins: readonly string[]) { this.file = join(dataDir, "settings.json"); }
  get(): TLocalSettings {
    const s = readJson<Partial<TLocalSettings>>(this.file, {});
    return {
      includePersonalConfigByDefault: s.includePersonalConfigByDefault ?? false, paused: s.paused ?? false, allowedOrigins: [...this.allowedOrigins],
      maxConcurrent: s.maxConcurrent ?? 3, autoMerge: s.autoMerge ?? true,
    };
  }
  patch(p: TLocalSettingsPatch): TLocalSettings {
    const cur = this.get();
    const next = {
      includePersonalConfigByDefault: p.includePersonalConfigByDefault ?? cur.includePersonalConfigByDefault, paused: p.paused ?? cur.paused,
      maxConcurrent: p.maxConcurrent ?? cur.maxConcurrent, autoMerge: p.autoMerge ?? cur.autoMerge,
    };
    writeJsonAtomic(this.file, next);
    return this.get();
  }
}
