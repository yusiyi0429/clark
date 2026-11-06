import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import {
  LOCAL_RUNNER_SYNC_PATH, LocalSyncBatchResponse, LocalSyncItem,
  type TLocalSyncItem, type TLocalOutboxStatus, type TLocalSyncBatchRequest, type TLocalSlots,
} from "@warmap/contracts";
import { readJson, writeJsonAtomic, nowIso } from "./store.js";

/** 队里的一条。产出物原文另存一个文件（blob），队列文件里只留空串，免得每次入队都整份重写几 MB。 */
interface Entry { item: TLocalSyncItem; attempts: number; nextAt: number; blob?: string; solo?: boolean }
interface State { entries: Entry[]; lastSyncedAt: string | null; lastError: string | null }

export interface CloudTarget { apiBaseUrl: string; token: string }

const MAX_BATCH_ITEMS = 50;
const MAX_BATCH_BYTES = 12 * 1024 * 1024;
const MAX_BACKOFF_MS = 5 * 60_000;
/** 这些 4xx 说明条目本身不合格：整批被拒时拆开逐条发，单条再被拒就丢掉，不让一条坏的卡住后面所有的。 */
const isItemRejection = (status: number) => status >= 400 && status < 500 && ![401, 403, 408, 429].includes(status);

/**
 * 发件箱：本机 → 云端单向。先落盘再发，断网、云端出错、本机重启都不丢；按幂等键去重，重复发也无妨。
 * 云端回 accepted 的出队；rejected 的记一笔后出队（不再重试）；其余（超时、5xx、没回）退避重试。
 */
export class Outbox {
  private readonly file: string;
  private readonly blobDir: string;
  /** 发每一批时带上本机的位置数（app 接好会话管理后替换）。 */
  slots: () => TLocalSlots = () => ({ max: 3, running: 0, queued: 0 });
  /** 有条目出队（云端收下或拒收）以后调：交回送到了，本机才去取验收交代。 */
  onSent: () => void = () => {};
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
    this.blobDir = join(dataDir, "outbox-blobs");
    this.state = readJson<State>(this.file, { entries: [], lastSyncedAt: null, lastError: null });
  }

  private save() { writeJsonAtomic(this.file, this.state); }

  /** 不合契约的条目不进队（只记错），保证发出去的每一条云端都能收。 */
  enqueue(item: TLocalSyncItem): void {
    if (!Value.Check(LocalSyncItem, item)) {
      const first = [...Value.Errors(LocalSyncItem, item)][0];
      this.state.lastError = `本机有一条 ${(item as { type?: string }).type} 不合格，没发：${first ? `${first.path} ${first.message}` : ""}`;
      this.save();
      return;
    }
    if (this.state.entries.some((e) => e.item.key === item.key)) return;
    const entry: Entry = { item, attempts: 0, nextAt: 0 };
    if (item.type === "artifact") {
      mkdirSync(this.blobDir, { recursive: true });
      entry.blob = createHash("sha256").update(item.key).digest("hex");
      writeFileSync(join(this.blobDir, entry.blob), item.data.contentBase64, { mode: 0o600 });
      entry.item = { ...item, data: { ...item.data, contentBase64: "" } };
    }
    this.state.entries.push(entry);
    this.save();
    this.schedule(300);
  }

  /** 这一条还在队里（云端还没收下）。 */
  has(key: string): boolean {
    return this.state.entries.some((e) => e.item.key === key);
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

  /** 从不抛错：常驻进程里一次发送失败（比如钥匙解不开）不能带走整个程序。 */
  flush(): Promise<void> {
    if (!this.flushing) {
      this.flushing = this.flushOnce()
        .catch((e) => {
          this.state.lastError = e instanceof Error ? e.message : String(e);
          this.schedule(60_000);
        })
        .finally(() => { this.flushing = null; });
    }
    return this.flushing;
  }

  private withBlob(e: Entry): TLocalSyncItem {
    if (!e.blob || e.item.type !== "artifact") return e.item;
    return { ...e.item, data: { ...e.item.data, contentBase64: readFileSync(join(this.blobDir, e.blob), "utf8") } };
  }

  private remove(keys: Set<string>) {
    for (const e of this.state.entries) if (keys.has(e.item.key) && e.blob) rmSync(join(this.blobDir, e.blob), { force: true });
    this.state.entries = this.state.entries.filter((e) => !keys.has(e.item.key));
  }

  private async flushOnce(): Promise<void> {
    const target = await this.target();
    if (!target) return;
    const t = this.now();
    const due = this.state.entries.filter((e) => e.nextAt <= t);
    if (!due.length) { this.scheduleNext(); return; }
    const batch: Entry[] = [];
    const items: TLocalSyncItem[] = [];
    let bytes = 0;
    for (const e of due) {
      const item = this.withBlob(e);
      const size = JSON.stringify(item).length;
      if (batch.length && (batch.length >= MAX_BATCH_ITEMS || bytes + size > MAX_BATCH_BYTES || e.solo || batch[0]!.solo)) break;
      batch.push(e);
      items.push(item);
      bytes += size;
    }
    const before = this.state.entries.length;
    const body: TLocalSyncBatchRequest = { deviceId: this.meta.deviceId, runnerVersion: this.meta.runnerVersion, slots: this.slots(), items };
    let error: string | null = null;
    let retryNow = false;
    try {
      const res = await this.fetchImpl(new URL(LOCAL_RUNNER_SYNC_PATH, target.apiBaseUrl), {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${target.token}` },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
      if (!res.ok && isItemRejection(res.status)) {
        const detail = (await res.text().catch(() => "")).slice(0, 200);
        if (batch.length > 1) {
          for (const e of batch) e.solo = true; // 拆开逐条重发，找出是哪一条
          retryNow = true;
          error = `云端整批拒收（${res.status}），改成逐条发`;
        } else {
          this.remove(new Set([batch[0]!.item.key]));
          error = `云端拒收一条 ${batch[0]!.item.type}（${res.status}）：${detail}`;
        }
      } else if (!res.ok) {
        throw new Error(res.status === 401 ? "云端令牌无效，请在天枢网页里重新连接本机" : `云端返回 ${res.status}`);
      } else {
        const parsed = (await res.json()) as unknown;
        if (!Value.Check(LocalSyncBatchResponse, parsed)) throw new Error("云端回执格式不对");
        const done = new Set([...parsed.accepted, ...parsed.rejected.map((r) => r.key)]);
        this.remove(done);
        this.state.lastSyncedAt = nowIso();
        if (parsed.rejected.length) error = `云端拒收 ${parsed.rejected.length} 条：${parsed.rejected[0]!.message}`;
        for (const e of batch) if (!done.has(e.item.key)) this.backoff(e);
      }
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      for (const entry of batch) this.backoff(entry);
    }
    this.state.lastError = error;
    const sent = this.state.entries.length < before;
    this.save();
    if (sent) this.onSent();
    if (retryNow || (!error && this.state.entries.some((e) => e.nextAt <= this.now()))) this.schedule(0);
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
