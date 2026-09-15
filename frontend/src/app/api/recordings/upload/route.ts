/**
 * 交一份已有的录音进来（腾讯会议导出、手机里录的那一段、别人发来的 mp3）。
 *
 * ## 为什么不走 `/api/data`
 *
 * 那条是 JSON-RPC，而这里要收的是一个文件 —— 可能几百 MB。base64 塞进 JSON 白涨
 * 三分之一体积，还要在 RPC 那一层给它开一条不像 RPC 的口子。这条规矩
 * `/api/meeting/audio` 已经立过，照它。
 *
 * ## 这条请求只管到「收下」
 *
 * 转码、上传对象存储、提交识别、轮询结果全在后台（`lib/recording/pipeline.ts`），
 * 加起来几分钟到几十分钟。屏幕在他松手那一刻就拿到一个 id 跳去详情页，之后靠轮询
 * 看状态 —— 而不是对着一个转圈的上传按钮等二十分钟，中间断一次网就全没了。
 *
 * 所以这条路上会当场失败的只有「收不下」这一类：没选文件、太大、磁盘写不进去。
 * 后面每一段各自失败各自记，见 `Recording.failStage`。
 */
import { mkdirSync, createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline as streamPipeline } from "node:stream/promises";
import { extname, join } from "node:path";

import { runAsActor } from "@/lib/data/actor";
import { CEO_ACTOR, persistSoon, recordingsTable } from "@/lib/data/store";
import { rawDir } from "@/lib/recording/config";
import { kick } from "@/lib/recording/pipeline";
import * as rec from "@/lib/recording/registry";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/**
 * 只管收下，所以不需要给转写留时间。给到十分钟是为了**大文件本身**：会议室网络上传
 * 一个 500 MB 的 mp4 可以传很久，而砍断的表现是「传到一半没了」。
 */
export const maxDuration = 600;

/** 一份录音最大多少字节。腾讯会议导出的一小时 mp4 大约 300 MB，给到 1 GB。 */
const MAX_BYTES = 1024 * 1024 * 1024;

/**
 * 认得出的后缀。**认不出的一律照收** —— 判断格式是 ffmpeg 的事，它认得的东西比这张
 * 表长得多，而在这里拦一道的唯一效果是把一份本来转得动的录音挡在门外。这张表只用来
 * 给落盘的文件挑个后缀。
 */
const KNOWN_EXT = /\.(webm|m4a|mp3|wav|mp4|mov|aac|ogg|opus|flac|wma|amr|mkv|avi)$/i;

const fail = (status: number, message: string) =>
  Response.json({ error: message }, { status });

export async function POST(req: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail(400, "这次上传没收全。");
  }

  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) {
    return fail(400, "没有选文件，或者选的那个是空的。");
  }
  if (file.size > MAX_BYTES) {
    return fail(
      413,
      `这份文件 ${Math.round(file.size / 1024 / 1024)} MB，超过 1 GB 了。` +
        `先用会议软件导出成音频，或者自己转成 mp3 再传。`,
    );
  }

  const title = String(form.get("title") ?? "").trim() || undefined;
  /*
   * 参会人前端传的是一串逗号分隔。中英文逗号、顿号都切 —— 他手上那份名单是从别处
   * 复制过来的，用哪个逗号取决于当时的输入法，而这件事不值得让他重打一遍。
   */
  const participants = String(form.get("participants") ?? "")
    .split(/[,，、]/)
    .map((s) => s.trim())
    .filter(Boolean);

  const ext = KNOWN_EXT.test(file.name) ? extname(file.name).toLowerCase() : ".bin";

  /*
   * 先建记录再落文件：反过来的话，写盘写到一半崩了会在磁盘上留一个谁都不知道的文件，
   * 而且没有任何东西指着它。这样倒过来最坏的结果是库里一条 `uploaded`、文件不在 ——
   * 流水线第一步就会说「原始音频不在了」，那句话至少指得出是哪一份。
   */
  const created = await runAsActor(CEO_ACTOR, async () =>
    rec.create(recordingsTable(), {
      now: new Date(),
      source: "upload",
      title: title ?? stripExt(file.name),
      participants,
    }),
  );
  const path = join(rawDir(), `${created.id}${ext}`);

  try {
    mkdirSync(rawDir(), { recursive: true });
    /*
     * 流式写盘，**不 `await file.arrayBuffer()`**。那一句会把整份文件读进内存 ——
     * 一个 500 MB 的 mp4 就是 500 MB 常驻堆，而这台机器同时还在跑深研。
     */
    await streamPipeline(
      Readable.fromWeb(file.stream() as unknown as Parameters<typeof Readable.fromWeb>[0]),
      createWriteStream(path),
    );
  } catch (err) {
    console.error(`[api/recordings] ${created.id} 落盘失败：`, err);
    rec.fail(
      recordingsTable(),
      created.id,
      "transcode",
      `这份文件没能存下来：${err instanceof Error ? err.message : String(err)}`,
      new Date(),
    );
    persistSoon();
    return fail(500, "这份文件没能存下来，原因写进了服务端日志。");
  }

  rec.patch(recordingsTable(), created.id, { rawAudioPath: path }, new Date());
  persistSoon();
  /* 后台开跑。**不 await** —— 这条请求的活到收下为止。 */
  kick();

  return Response.json({ id: created.id });
}

/** `2026-08-30 战略会.mp4` → `2026-08-30 战略会`。去后缀，不去别的。 */
const stripExt = (name: string): string => {
  const e = extname(name);
  const base = e ? name.slice(0, -e.length) : name;
  return base.trim() || name;
};
