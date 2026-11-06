import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TLocalSessionEvent } from "@warmap/contracts";

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
/** 适配器产出的事件：还没编号，由事件日志补上 seq、at、sessionId。 */
export type EventBody = DistributiveOmit<TLocalSessionEvent, "seq" | "at" | "sessionId">;
type Listener = (e: TLocalSessionEvent) => void;

/**
 * 每个会话一份 JSONL 事件日志（<dataDir>/sessions/<id>/events.jsonl），序号从 1 递增。
 * 网页断线重连按 Last-Event-ID 从这里补发；本机程序重启后序号接着往下排。
 */
export class EventLog {
  private readonly cache = new Map<string, TLocalSessionEvent[]>();
  private readonly listeners = new Map<string, Set<Listener>>();

  constructor(private readonly sessionsDir: string) {}

  private file(sessionId: string): string {
    return join(this.sessionsDir, sessionId, "events.jsonl");
  }

  private load(sessionId: string): TLocalSessionEvent[] {
    let events = this.cache.get(sessionId);
    if (!events) {
      events = [];
      try {
        const text = readFileSync(this.file(sessionId), "utf8");
        for (const line of text.split("\n")) {
          if (!line.trim()) continue;
          try { events.push(JSON.parse(line) as TLocalSessionEvent); } catch { /* 断电留下的半行，跳过 */ }
        }
        // 断电留下的半行没有换行：先补一个，下一条事件才不会拼在它后面一起丢掉。
        if (text.length && !text.endsWith("\n")) appendFileSync(this.file(sessionId), "\n");
      } catch { /* 新会话还没有日志 */ }
      this.cache.set(sessionId, events);
    }
    return events;
  }

  append(sessionId: string, body: EventBody): TLocalSessionEvent {
    const events = this.load(sessionId);
    const event = { seq: (events.at(-1)?.seq ?? 0) + 1, at: new Date().toISOString(), sessionId, ...body } as TLocalSessionEvent;
    mkdirSync(join(this.sessionsDir, sessionId), { recursive: true });
    appendFileSync(this.file(sessionId), JSON.stringify(event) + "\n");
    events.push(event);
    for (const fn of this.listeners.get(sessionId) ?? []) fn(event);
    return event;
  }

  after(sessionId: string, seq: number): TLocalSessionEvent[] {
    return this.load(sessionId).filter((e) => e.seq > seq);
  }

  lastSeq(sessionId: string): number {
    return this.load(sessionId).at(-1)?.seq ?? 0;
  }

  subscribe(sessionId: string, fn: Listener): () => void {
    const set = this.listeners.get(sessionId) ?? new Set<Listener>();
    set.add(fn);
    this.listeners.set(sessionId, set);
    return () => set.delete(fn);
  }

  /** 会话结束后释放内存里的副本，要补发时再从文件读。 */
  evict(sessionId: string): void {
    if (!this.listeners.get(sessionId)?.size) this.cache.delete(sessionId);
  }
}
