/**
 * A1a 的触发与轮询。
 *
 * 为什么是独立 route 而不是 `api` 上的一个方法：`store.ts` 已经 import 了
 * `a3/run` 和 `a4/run`；A1a 的写回要碰数据层，如果触发也放进 `api`，就成了
 * `store → a1a/run → a1a/apply → store` 的循环 import。
 *
 * **立刻返回状态，不等它跑完** —— 一次带上下文的 A1a 要两次模型调用，把请求挂
 * 在那里等于让屏幕卡死。同一张卡正在跑就直接返回 running，不排队：前端是轮询
 * 的，排队会把一次误触变成十次真实的模型调用。
 */
import { runA1a } from "@/lib/agent/a1a/run";
import { applyA1aResult } from "@/lib/agent/a1a/apply";
import { AgentRunFailed } from "@/lib/agent/harness";
import { agentRunPut, agentSignalInput } from "@/lib/data/store";
import { runTask, taskState } from "@/lib/agent/tasks";
import type { AgentRunRecord } from "@/lib/data/types";

export const dynamic = "force-dynamic";

const fail = (status: number, message: string) => Response.json({ error: message }, { status });

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "请求体不是 JSON。");
  }
  const cardId = (body as { cardId?: unknown })?.cardId;
  const depth = (body as { depth?: unknown })?.depth;
  if (typeof cardId !== "string" || !cardId) return fail(400, "要给 cardId。");

  const found = agentSignalInput(cardId);
  if (!found) return fail(404, `没有这条信号：${cardId}`);
  const { card } = found;

  // `runTask` 是**同步**的：它立刻返回 running，后台自己跑（别加 await，
  // 那会让 eslint 的 await-thenable 报错，而且读起来像在等它跑完）。
  // 回调必须返回 `{ attempts?: number }` —— `runTask` 用它填 TaskState.attempts。
  const state = runTask("a1a", cardId, async () => {
    let run: AgentRunRecord;
    try {
      run = await runA1a(
        {
          cardId,
          headline: card.headline,
          source: sourceLabel(card.source),
          body: card.what.map((x) => x.text).join("\n"),
          // `Card.source.kind === "ceo"` 不改变判断，只改变写回：判为噪音时卡仍留在
          // 列表里（见 apply.ts）。所以这里不需要往 prompt 里塞「这是 CEO 给的」——
          // 那会变成一个诱导模型别判噪音的暗示，而三条路里恰好有一条就是为这种
          // 「声量很大甚至来自 CEO」的信号准备的。
        },
        { depth: typeof depth === "string" ? depth : undefined }
      );
    } catch (e) {
      // 就地失败也要在台账上留一条，然后原样再抛 —— 这次运行**没有**跑成。
      if (e instanceof AgentRunFailed) agentRunPut(e.run);
      throw e;
    }
    agentRunPut(run);
    // 写回失败不该把 Run 记录也一起吞掉 —— 记录已经落了，产出可见可评分。
    try {
      const applied = applyA1aResult(run, cardId);
      console.log(`[tkos:a1a] ${run.id} ${run.status} → ${applied.applied}`);
    } catch (e) {
      console.warn(`[tkos:a1a] ${run.id} 已落库，但写回未接通：${e instanceof Error ? e.message : e}`);
    }
    if (run.status === "failed") throw new Error(run.error ?? "A1a 失败");
    return { attempts: 1 };
  });

  return Response.json(state);
}

export async function GET(req: Request) {
  const cardId = new URL(req.url).searchParams.get("cardId");
  if (!cardId) return fail(400, "要给 cardId。");
  return Response.json(taskState("a1a", cardId));
}

function sourceLabel(source: { kind: string; by?: string; title?: string }): string {
  if (source.kind === "dri") return `DRI ${source.by ?? ""}`.trim();
  if (source.kind === "ceo") return "一号位自己递上来的";
  if (source.kind === "probe") return `研讨衍生 · ${source.title ?? ""}`.trim();
  return "雷达";
}
