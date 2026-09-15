/**
 * 录音这条路上的两个动作：重试、结束并转写。
 *
 * ## 为什么这两个不走 `api`（`lib/data/client.ts`）
 *
 * 那个 `api` 上每个方法都是 `POST /api/data` 的一层壳，而这两件事**改完状态之后还差
 * 一步**：把转写流水线叫起来。通用那条 RPC 路由不知道要叫，于是 `api.retryRecording()`
 * 会返回 ok、状态真的翻回「排队中」，然后永远停在那儿 —— 没有报错、没有进度，看起来
 * 就像在排队（2026-08-31 实测）。两条专用路由补上了那一句，理由写在
 * `app/api/recordings/_handoff.ts`。
 *
 * 所以这里是屏幕上按这两颗键的**唯一**入口。签名和抛的东西都照 `api` 那一套来
 * （失败一律 `ApiError`），视图层的 `e instanceof ApiError` 分支照旧命中。
 */
import { ApiError } from "@/lib/data/shared";

/** 重跑一份失败的录音。抛 `ApiError`，`message` 是服务端那句原话。 */
export const retryRecording = (id: string): Promise<void> =>
  post(`/api/recordings/${encodeURIComponent(id)}/retry`, "重试");

/** 给一份停在「录音中」的孤儿收尾，然后开始转写。 */
export const finishRecording = (id: string): Promise<void> =>
  post(`/api/recordings/${encodeURIComponent(id)}/finish`, "结束并转写");

/**
 * 这两条路由的返回都一样：成了 `{ ok: true }`，没成 `{ error: "一句中文" }`。
 *
 * 错误处理照 `lib/data/client.ts` 那一套抄，一条不少：连不上时英文的 `Failed to fetch`
 * 进 console 不上屏；服务端那句原话原样带出来（它已经是写给读的人的中文）；
 * 连 JSON 都不是的时候把 HTTP 码写进去 —— 那种情况多半是路由压根没起来。
 */
async function post(path: string, what: string): Promise<void> {
  let res: Response;
  try {
    res = await fetch(path, { method: "POST", cache: "no-store" });
  } catch (err) {
    console.error(`[recording] ${what} 连不上服务：`, err);
    throw new ApiError(`连不上服务，这一下没有发出去（${what}）。`);
  }

  if (res.ok) return;

  let said: string | undefined;
  try {
    said = ((await res.json()) as { error?: string }).error;
  } catch {
    /* 不是 JSON —— 下面那句会把 HTTP 码带上。 */
  }
  throw new ApiError(said ?? `这一下服务端没有接受（${what}，HTTP ${res.status}）。`);
}
