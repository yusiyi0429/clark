import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import {
  LOCAL_RUNNER_SYNC_PATH, LocalSyncBatchResponse,
  type TLocalSyncItem, type TLocalOutboxStatus, type TLocalSyncBatchRequest,
} from "@warmap/contracts";
import { readJson, writeJsonAtomic, nowIso } from "./store.js";

interface Entry { item: TLocalSyncItem; attempts: number; nextAt: number }
interface State { entries: Entry[]; lastSyncedAt: string | null; lastError: string | null }

export interface CloudTarget { apiBaseUrl: string; token: string }

const MAX_BATCH_ITEMS = 50;
const MAX_BATCH_BYTES = 12 * 1024 * 1024;
const MAX_BACKOFF_MS = 5 * 60_000;

/**
 * 发件箱：本机 → 云端单向。先落盘再发，断网、云端出错、本机重启都不丢；按幂等键去重，重复发也无妨。
 * 云端回 accepted 的出队；rejected 的记一笔后出队（不再重试）；其余（超时、5xx、没回）退避重试。
 */
export class Outbox {
  private readonly file: string;
  private state: State;
  private timer: NodeJS.Timeout | null = null;
  private flushing: Promise<void> | null = null;

  constructor(
    dataDir: string,
    private readonly target: () => Promise<CloudTarget | null>,
    private readonly meta: { deviceId: string; runnerVersion: string },
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly now = () => Date.now(),
  ) {
    this.file = join(dataDir, "outbox.json");
    this.state = readJson<State>(this.file, { entries: [], lastSyncedAt: null, lastError: null });
  }

  private save() { writeJsonAtomic(this.file, this.state); }

  enqueue(item: TLocalSyncItem): void {
    if (this.state.entries.some((e) => e.item.key === item.key)) return;
    this.state.entries.push({ item, attempts: 0, nextAt: 0 });
    this.save();
    this.schedule(300);
  }

  status(): TLocalOutboxStatus {
    return { pending: this.state.entries.length, lastSyncedAt: this.state.lastSyncedAt, lastError: this.state.lastError };
  }

  /** 网络恢复、刚关联云端时立即再试一次，不等退避。 */
  kick(): void {
    for (const e of this.state.entries) e.nextAt = 0;
    this.schedule(0);
  }

  schedule(delayMs: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, delayMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  flush(): Promise<void> {
    if (!this.flushing) this.flushing = this.flushOnce().finally(() => { this.flushing = null; });
    return this.flushing;
  }

  private async flushOnce(): Promise<void> {
    const target = await this.target();
    if (!target) return;
    const t = this.now();
    const due = this.state.entries.filter((e) => e.nextAt <= t);
    if (!due.length) { this.scheduleNext(); return; }
    const batch: Entry[] = [];
    let bytes = 0;
    for (const e of due) {
      const size = JSON.stringify(e.item).length;
      if (batch.length && (batch.length >= MAX_BATCH_ITEMS || bytes + size > MAX_BATCH_BYTES)) break;
      batch.push(e);
      bytes += size;
    }
    const body: TLocalSyncBatchRequest = { deviceId: this.meta.deviceId, runnerVersion: this.meta.runnerVersion, items: batch.map((e) => e.item) };
    let error: string | null = null;
    try {
      const res = await this.fetchImpl(new URL(LOCAL_RUNNER_SYNC_PATH, target.apiBaseUrl), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${target.token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok) throw new Error(res.status === 401 ? "云端令牌无效，请在天枢网页里重新连接本机" : `云端返回 ${res.status}`);
      const parsed = (await res.json()) as unknown;
      if (!Value.Check(LocalSyncBatchResponse, parsed)) throw new Error("云端回执格式不对");
      const done = new Set([...parsed.accepted, ...parsed.rejected.map((r) => r.key)]);
      this.state.entries = this.state.entries.filter((e) => !done.has(e.item.key));
      this.state.lastSyncedAt = nowIso();
      if (parsed.rejected.length) error = `云端拒收 ${parsed.rejected.length} 条：${parsed.rejected[0]!.message}`;
      for (const e of batch) if (!done.has(e.item.key)) this.backoff(e);
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      for (const entry of batch) this.backoff(entry);
    }
    this.state.lastError = error;
    this.save();
    if (!error && this.state.entries.some((e) => e.nextAt <= this.now())) this.schedule(0);
    else this.scheduleNext();
  }

  private backoff(e: Entry) {
    e.attempts += 1;
    e.nextAt = this.now() + Math.min(MAX_BACKOFF_MS, 1_000 * 2 ** Math.min(e.attempts, 9));
  }

  private scheduleNext() {
    if (!this.state.entries.length) return;
    const next = Math.min(...this.state.entries.map((e) => e.nextAt));
    this.schedule(Math.max(1_000, next - this.now()));
  }
}
