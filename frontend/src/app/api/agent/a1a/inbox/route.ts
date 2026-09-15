/**
 * 「开成议题」：拿一条待挑的信号去跑现有的 A1a。**A1a 本身一个字不改。**
 *
 * 为什么不复用 `../route.ts`：那一条按 `cardId` 取输入（`agentSignalInput` 要求这条
 * 信号已经是提请台里的一张卡、并且挂在某个议题下）。待挑的信号两样都没有 —— 它就是
 * 一段外部原文，恰好是 A1a 纯外部那条路的输入。而 `runA1a` 的 `cardId` **只进类型不进
 * 函数体**（锚点是 `openContext("S01", input.headline)` 拿 headline 去图谱里查的），
 * 所以这里把 `dedupeKey` 填进去就够，不用给 A1a 加任何分支。
 *
 * **走 `applyA1aInbox` 而不是 `applyA1aResult`**：后者按 `cardId` 走 —— 它的 `ignore`
 * 那支要去 `markCardAgentVerdict` 标注一张卡，而待挑的信号根本没有卡，那次标注只会
 * 落在一个不存在的 id 上；`new_issue` / `update_issue` 两条在它那边至今抛 `NotWiredYet`。
 * `applyA1aInbox` 三条路都接通了：判为值得的那两条**真的在池子里开出一条 Candidate
 * 议题**（连卡、连今天这一批、连一轮预研），新议题的 id 再记回这条信号的
 * `judged.issueId` 上，待挑页那一行于是能直接点进去。
 *
 * **口令**：不要把这条路加进 `src/proxy.ts` 的 `PUBLIC_PATHS` —— 点它的是浏览器里的
 * 一号位，走访问 cookie 那道门。只有作业推的那一条是机器路。
 */
import { applyA1aInbox } from "@/lib/agent/a1a/apply";
import { runA1a } from "@/lib/agent/a1a/run";
import { AgentRunFailed } from "@/lib/agent/harness";
import { runTask, taskState } from "@/lib/agent/tasks";
import {
  agentRunPut,
  inboxSignalDispose,
  inboxSignalGet,
  inboxSignalJudged,
} from "@/lib/data/store";
import type { AgentRunRecord } from "@/lib/data/types";

export const dynamic = "force-dynamic";

/** 任务表里的分类。和按 cardId 的那条分开，否则两种 id 会撞在同一个 key 上。 */
const KIND = "a1a-inbox";

const fail = (status: number, message: string) => Response.json({ error: message }, { status });

export async function POST(req: Request) {
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail(400, "请求体不是 JSON。");
  }
  const key = (body as { key?: unknown })?.key;
  const depth = (body as { depth?: unknown })?.depth;
  if (typeof key !== "string" || !key) return fail(400, "要给 key。");

  const sig = inboxSignalGet(key);
  if (!sig) return fail(404, `没有这条信号：${key}`);

  /*
   * **先记处置，再跑。** 「他挑了这一条」是这条链路真正要留的数据（rollout §7：
   * 处置是阈值的免费标注），跟 A1a 这次跑成没跑成是两件事 —— 跑挂了就把处置也丢掉的
   * 话，这份标注会系统性地偏向「顺利的那些」，而它将来要用来算 precision。
   */
  inboxSignalDispose(key, "issue");

  // `runTask` 是**同步**的：立刻返回 running，后台自己跑（别加 await）。
  // 同一个 key 正在跑就直接返回 running，不排队 —— 前端是轮询的。
  const state = runTask(KIND, key, async () => {
    let run: AgentRunRecord;
    try {
      run = await runA1a(
        {
          cardId: key,
          headline: sig.title,
          source: sig.source || "抓取作业",
          body: sig.text,
        },
        { depth: typeof depth === "string" ? depth : undefined }
      );
    } catch (e) {
      // 就地失败也要留账：台账一条，信号上一条 —— 两边说的话必须一致。
      if (e instanceof AgentRunFailed) {
        agentRunPut(e.run);
        inboxSignalJudged(key, {
          runId: e.run.id,
          status: e.run.status,
          route: e.run.route,
          at: e.run.finishedAt,
        });
      }
      throw e;
    }
    agentRunPut(run);
    /*
     * **先建议题，再记 `judged`。** 反过来的话 `judged.issueId` 会有一瞬间指向一条
     * 还没落库的 id —— 而待挑页每两秒问一次 GET，那一瞬间足够它渲染出一条点不开的链接。
     */
    const { applied, issueId } = applyA1aInbox(run, sig);
    inboxSignalJudged(key, {
      runId: run.id,
      status: run.status,
      route: run.route,
      at: run.finishedAt,
      ...(issueId ? { issueId } : {}),
    });
    // `applied` 也进这行日志：实跑时它是唯一能看见「写回到底做了什么」的地方。
    console.log(
      `[tkos:inbox] ${key} → A1a ${run.id} ${run.status}${run.route ? ` · ${run.route}` : ""} · ${applied}`
    );
    if (run.status === "failed") throw new Error(run.error ?? "A1a 失败");
    return { attempts: 1 };
  });

  return Response.json(state);
}

export async function GET(req: Request) {
  const key = new URL(req.url).searchParams.get("key");
  if (!key) return fail(400, "要给 key。");
  const state = taskState(KIND, key);
  const sig = inboxSignalGet(key);
  const judged = sig?.judged?.status;
  // 开出来的那条议题的 id。**开不出来就没有**（见 `InboxSignalMeta.judged.issueId`）——
  // 待挑页拿它决定那一行要不要给一条点得进去的链接。
  return Response.json({ ...state, judged, issueId: sig?.judged?.issueId });
}
