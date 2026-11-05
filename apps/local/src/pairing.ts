import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import type { TLocalPairingStartResponse, TLocalPairingStatusResponse, TLocalPairingStatus } from "@warmap/contracts";
import { readJson, writeJsonAtomic, nowIso } from "./store.js";

interface StoredToken { id: string; hash: string; origin: string; label: string; createdAt: string }

const sha256 = (s: string) => createHash("sha256").update(s).digest();

/** 配对口令：明文只交给网页一次，本机只存哈希。 */
export class TokenStore {
  private readonly file: string;
  private tokens: StoredToken[];

  constructor(dataDir: string) {
    this.file = join(dataDir, "tokens.json");
    this.tokens = readJson<StoredToken[]>(this.file, []);
  }

  issue(origin: string, label: string): string {
    const token = randomBytes(32).toString("hex");
    this.tokens.push({ id: randomBytes(6).toString("hex"), hash: sha256(token).toString("hex"), origin, label, createdAt: nowIso() });
    writeJsonAtomic(this.file, this.tokens);
    return token;
  }

  /** 口令按来源绑定：在 A 来源配的口令拿到 B 来源用无效。 */
  verify(token: string | undefined, origin: string): boolean {
    if (!token) return false;
    const h = sha256(token);
    let ok = false;
    for (const t of this.tokens) if (t.origin === origin && timingSafeEqual(h, Buffer.from(t.hash, "hex"))) ok = true;
    return ok;
  }

  revoke(token: string): void {
    const h = sha256(token).toString("hex");
    this.tokens = this.tokens.filter((t) => t.hash !== h);
    writeJsonAtomic(this.file, this.tokens);
  }

  revokeAll(): void {
    this.tokens = [];
    writeJsonAtomic(this.file, this.tokens);
  }

  count(): number {
    return this.tokens.length;
  }
}

interface Pending { id: string; code: string; origin: string; expiresAt: number; status: TLocalPairingStatus; token?: string }

export type ConfirmPairing = (p: { code: string; origin: string; label: string }) => Promise<boolean>;

const TTL_MS = 2 * 60_000;
const MAX_PENDING = 3;

/** 网页发起 → 本机确认框显示同一个四位码 → 本人点允许才发口令。防同一来源的页面悄悄配上。 */
export class Pairings {
  private readonly pending = new Map<string, Pending>();

  constructor(private readonly tokens: TokenStore, private readonly confirm: ConfirmPairing, private readonly now = () => Date.now()) {}

  start(origin: string, label: string): TLocalPairingStartResponse | null {
    this.sweep();
    if ([...this.pending.values()].filter((p) => p.status === "pending").length >= MAX_PENDING) return null;
    const p: Pending = {
      id: randomBytes(12).toString("hex"),
      code: String(randomInt(0, 10_000)).padStart(4, "0"),
      origin,
      expiresAt: this.now() + TTL_MS,
      status: "pending",
    };
    this.pending.set(p.id, p);
    void this.confirm({ code: p.code, origin, label }).then(
      (ok) => this.settle(p, ok),
      () => this.settle(p, false),
    );
    return { pairingId: p.id, code: p.code, expiresAt: new Date(p.expiresAt).toISOString() };
  }

  /** 只有发起配对的那个来源能取口令；口令取一次就清掉。 */
  status(id: string, origin: string): TLocalPairingStatusResponse | null {
    this.sweep();
    const p = this.pending.get(id);
    if (!p || p.origin !== origin) return null;
    if (p.status === "approved" && p.token) {
      const token = p.token;
      delete p.token;
      return { status: "approved", token };
    }
    return { status: p.status };
  }

  private settle(p: Pending, ok: boolean): void {
    if (p.status !== "pending") return;
    if (this.now() > p.expiresAt) { p.status = "expired"; return; }
    p.status = ok ? "approved" : "denied";
    if (ok) p.token = this.tokens.issue(p.origin, "天枢网页");
  }

  private sweep(): void {
    const t = this.now();
    for (const [id, p] of this.pending) {
      if (p.status === "pending" && t > p.expiresAt) p.status = "expired";
      if (t > p.expiresAt + TTL_MS) this.pending.delete(id);
    }
  }
}
