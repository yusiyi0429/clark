/**
 * 抓取作业推过来的那份 JSON → 数据层认识的记录。
 *
 * **这是跨仓库契约的这一半。** 另一半是 `tkos-lab/src/tkos_lab/deliver.py` 的
 * `build_payload`（形状见 `docs/superpowers/specs/2026-08-19-catching-signal-rollout-design.md`
 * §4.3）。改它要同时改两处，所以它得是一个能被单测钉住的纯函数，而不是埋在 HTTP
 * 处理里的十几行 —— 契约漂了之后，端点只会安静地少收几个字段。
 *
 * 蛇形转驼峰只在这个文件里发生一次。这里不 import store，也不认识 HTTP。
 */
import type { CrawledSignalInput, InboxSignal } from "./types";

/**
 * 正文留多长。落盘是**整个 store 序列化重写一遍**（见 `persist.ts`），一篇全文
 * 三五千字，两百条就是每次写盘都搬一兆。
 *
 * 截了不影响判断：研判在作业那边已经做完了，这一页只是让一号位扫一眼决定要不要
 * 开成议题；他要读全文，标题就是外链。
 */
export const INBOX_TEXT_MAX = 2000;

export type InboxParse =
  | { ok: true; runId: string; scannedAt: string; signals: CrawledSignalInput[] }
  | { ok: false; error: string };

const bad = (error: string): InboxParse => ({ ok: false, error });

const obj = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

/** 只用来显示的字段：给什么算什么，没给算空串。 */
const str = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

/** 日期字段归一化：解析不出来填空串，避免渲染时抛 RangeError 掀掉整页。 */
const dateStr = (v: unknown): string => {
  const s = str(v);
  return s && Number.isNaN(Date.parse(s)) ? "" : s;
};

const truncate = (text: string): string =>
  text.length > INBOX_TEXT_MAX ? `${text.slice(0, INBOX_TEXT_MAX)}…` : text;

/**
 * 解析一批。**一条不合规就整批拒收**，不做「跳过坏的那条、收下别的」。
 *
 * 部分接收是静默丢数据：作业那边看到 200，以为都进来了，而少的那条再也不会重投
 * （下一轮扫描它可能已经出了时间窗）。整批拒 + 非零退出码，作业重跑一次即可 ——
 * 幂等键保证重跑安全，这正是它存在的理由。
 *
 * 严格与宽松的分界：**身份与排序的字段缺了就拒**（`dedupe_key` 是主键，`title` /
 * `url` 是这条信号在屏幕上的全部，`score` 是排序键，`origin` 有下游分支），
 * **只用来显示的字段缺了填空串**（`why` / `kiq` / `text` / `published_at` /
 * `source` / `suggested_issue`）—— 模型偶尔漏一句话，不该让一整轮扫描白跑。
 */
export function parseInboxPayload(body: unknown): InboxParse {
  const root = obj(body);
  if (!root) return bad("请求体不是一个对象。");

  const runId = str(root.run_id);
  if (!runId) return bad("run_id 是空的 —— 每一批都要说清是哪次扫描产出的。");
  const scannedAt = str(root.scanned_at);
  if (!scannedAt) return bad("scanned_at 是空的。");
  if (!Array.isArray(root.signals)) return bad("signals 不是数组。");

  const signals: CrawledSignalInput[] = [];
  for (let i = 0; i < root.signals.length; i += 1) {
    const at = `signals[${i}]`;
    const raw = obj(root.signals[i]);
    if (!raw) return bad(`${at} 不是一个对象。`);

    const dedupeKey = str(raw.dedupe_key);
    if (!dedupeKey) {
      return bad(`${at}.dedupe_key 是空的 —— 幂等键缺了这条链路必然堆重复，整批拒收。`);
    }
    const title = str(raw.title);
    if (!title) return bad(`${at}.title 是空的。`);
    const url = str(raw.url);
    if (!url) return bad(`${at}.url 是空的 —— 一号位要点进去看原文。`);
    // 只收 http(s)，拒掉 javascript: / data: 等能在屏幕上留下可点链接的协议。
    try {
      const parsed = new URL(url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        return bad(`${at}.url 协议必须是 http 或 https，收到 ${parsed.protocol}`);
      }
    } catch {
      return bad(`${at}.url 不是合法的 URL：${url}`);
    }

    /*
     * 分数只校验「是个能排序的有限数」，**不校验区间**。1–5 是作业那边 rubric
     * 的事；在这里也钉一遍的话，实验台把 rubric 换成 1–10 的那一天，正式版会把
     * 整批拒掉，而两边谁都没觉得自己改了契约。
     */
    const score = raw.score;
    if (typeof score !== "number" || !Number.isFinite(score)) {
      return bad(`${at}.score 不是数字（收到 ${JSON.stringify(score)}）—— 它是排序键。`);
    }

    const origin = raw.origin;
    if (origin !== "pinned" && origin !== "discovered") {
      return bad(`${at}.origin 只能是 pinned 或 discovered，收到 ${JSON.stringify(origin)}。`);
    }

    const dims: Record<string, number> = {};
    if (raw.dimensions !== undefined && raw.dimensions !== null) {
      const src = obj(raw.dimensions);
      if (!src) return bad(`${at}.dimensions 不是一个对象。`);
      for (const [k, v] of Object.entries(src)) {
        if (typeof v !== "number" || !Number.isFinite(v)) {
          return bad(`${at}.dimensions.${k} 不是数字（收到 ${JSON.stringify(v)}）。`);
        }
        dims[k] = v;
      }
    }

    signals.push({
      kind: "crawled",
      dedupeKey,
      title,
      url,
      text: truncate(str(raw.text)),
      publishedAt: dateStr(raw.published_at),
      source: str(raw.source),
      origin,
      score,
      dimensions: dims,
      kiq: str(raw.kiq),
      why: str(raw.why),
      suggestedIssue: str(raw.suggested_issue),
      runId,
      scannedAt,
    });
  }

  return { ok: true, runId, scannedAt, signals };
}

/**
 * 超了上限该丢哪几条。**先丢已处置的，都按收件时间老的先走。**
 *
 * 已处置的优先，是因为它的账已经记下了（`disposedAs` 就是那份标注）；未处置的
 * 一丢，这条链路唯一的产出就没了，而屏幕上看不出任何区别 —— 这一页本来就只是
 * 「机器捞回来的一批」，少一条谁也不知道。调用方发现返回里有未处置的，要 warn。
 *
 * 纯函数，不碰 store：上限行为是这一层唯一会静默丢数据的地方，得能被直接钉住。
 */
export function inboxEvictees(signals: InboxSignal[], cap: number): InboxSignal[] {
  const over = signals.length - cap;
  if (over <= 0) return [];
  const oldest = [...signals].sort((a, b) => a.receivedAt.localeCompare(b.receivedAt));
  return [...oldest.filter((s) => s.disposedAs), ...oldest.filter((s) => !s.disposedAs)].slice(0, over);
}
