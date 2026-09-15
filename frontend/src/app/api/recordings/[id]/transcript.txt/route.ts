/**
 * 逐字稿导出成纯文本。
 *
 * ## 为什么是一条路由而不是前端自己拼
 *
 * 前端已经有全部句子了，拼一份文本不难。但那样会有两份格式规则 —— 屏幕上「复制文本」
 * 那颗按钮一份、这里一份，而两份迟早会漂开一格（比如谁在前端加了「合并同一个人的
 * 连续发言」）。于是同一场会复制出来的和下载下来的不是同一份东西。
 *
 * 所以格式只有一处：`lib/recording/transcript.ts` 的 `toPlainText`。前端那颗按钮也拿它
 * 的规则拼（它是纯函数，两边都能用）。
 */
import { recordingsTable } from "@/lib/data/store";
import * as rec from "@/lib/recording/registry";
import { readTranscript, toPlainText } from "@/lib/recording/transcript";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const r = rec.find(recordingsTable(), id);
  if (!r) return new Response("这份录音不在了。", { status: 404 });

  const t = readTranscript(id);
  if (!t) return new Response("这一份还没有逐字稿。", { status: 404 });

  /*
   * 文件名用会议标题。**要过一道清洗** —— 标题是他自己敲的，里面可能有 `/`、`:`、
   * 换行，而这几个字符会让下载下来的文件名在 Windows 上变成一串乱码或者直接存不下。
   *
   * `filename*=UTF-8''` 那一份是给中文标题用的：只写 `filename=` 的话，中文在
   * 一部分浏览器上会变成问号。两份都写，认哪个由浏览器挑。
   */
  const safe = r.title.replace(/[\/:*?"<>|\r\n]+/g, "_").slice(0, 80) || id;
  return new Response(toPlainText(t), {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "content-disposition":
        `attachment; filename="${id}.txt"; ` +
        `filename*=UTF-8''${encodeURIComponent(safe)}.txt`,
      "cache-control": "no-store",
    },
  });
}
