/**
 * 会后：交一份录音（或者一份已经转好的文字）进来，转写 + 按议题提炼。
 *
 * ## 为什么不走 `/api/data`
 *
 * 那条是 JSON-RPC，而这里要收的是一个文件。把音频 base64 塞进 JSON 白涨三分之一体积，
 * 还要在 RPC 那一层给它开一条不像 RPC 的口子。
 *
 * ## 这条请求只管到「收下」
 *
 * 转写在这里做完，**判材料和按议题提炼挪进了后台任务**（见 `store.ts` 的
 * `ingestMeetingNotes`）：那一块要留在议题栏原地不动地跑，屏幕得在他松手那一刻就拿到
 * 状态。所以这条路上还会当场失败的只有两段 —— 转写（格式不对、key 没配、网络断）和收下
 * 之前那几句判断（这场会不存在、记录太短、这场会上没有议题）。每一句错都带着**是哪一段
 * 没成**，屏幕据此决定要不要给重试；后台那两段跑成什么样，问 `slotIntakeState`。
 *
 * ## 转写这一段可能要几分钟
 *
 * 一小时的会按 20 倍速推大约三分钟（`transcribe-file.ts`）。这条路因此是长连接的普通
 * POST，不做流式进度 —— 屏幕上那一段等待由上传那颗按钮自己说（同 `PasteTopic` 的做法：
 * 说清此刻在等什么，不编进度条）。
 */
import { ASRNotConfigured } from "@/lib/asr";
import { transcribePcm } from "@/lib/asr/transcribe-file";
import { decodeWav, WavNotSupported } from "@/lib/asr/wav";
import { runAsActor } from "@/lib/data/actor";
import { ApiError } from "@/lib/data/shared";
import { CEO_ACTOR, api } from "@/lib/data/store";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";
/**
 * 一小时的会转下来三分钟出头，再加提炼那一次调用。给到十分钟。
 *
 * 自托管（Docker）跑的时候这个值不生效，那边由反向代理的读超时说了算 —— 写在这里是为了
 * 哪天挪上托管平台不至于在 60 秒被砍断，而砍断的表现是「传到一半没了」。
 */
export const maxDuration = 600;

/** 一份录音最大多少字节。一小时 16 k 单声道 WAV 大约 115 MB，给到 200 MB。 */
const MAX_BYTES = 200 * 1024 * 1024;

/** 直接当文字收的那几种后缀。他手上可能已经有一份转写了 —— 那就不用再转一遍。 */
const TEXT_EXT = /\.(txt|md|srt|vtt)$/i;

const fail = (status: number, message: string, stage: "upload" | "transcribe" | "extract") =>
  Response.json({ error: message, stage }, { status });

export async function POST(req: Request): Promise<Response> {
  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail(400, "这次上传没收全。", "upload");
  }

  const slotId = String(form.get("slotId") ?? "").trim();
  if (!slotId) return fail(400, "要说清是哪一场会。", "upload");

  const pasted = String(form.get("transcript") ?? "").trim();
  const file = form.get("file");
  const hasFile = file instanceof File && file.size > 0;
  if (!pasted && !hasFile) return fail(400, "要么传一份录音，要么贴一份会议记录。", "upload");

  let transcript = pasted;
  let sourceName: string | undefined;

  if (hasFile) {
    const f = file as File;
    sourceName = f.name;
    if (f.size > MAX_BYTES) {
      return fail(413, `这份文件 ${Math.round(f.size / 1024 / 1024)} MB，超过 200 MB 了。`, "upload");
    }

    if (TEXT_EXT.test(f.name)) {
      // 已经是文字了。**不再过一遍识别** —— 那一遍除了花时间什么都不会改变。
      transcript = (await f.text()).trim();
    } else {
      let pcm: Uint8Array;
      let seconds: number;
      try {
        ({ pcm, seconds } = decodeWav(await f.arrayBuffer()));
      } catch (err) {
        if (err instanceof WavNotSupported) {
          /*
           * 拒的这句话必须把**另一条路**说出来。只说「只认 WAV」的话，他手上那份 m4a
           * 就成了死路；而他多半已经有一份转写，或者能在别处导一份出来。
           */
          return fail(
            415,
            `${err.message} 现在只认 WAV（16/24 位 PCM 或 32 位浮点）。` +
              "别的格式可以先转成 WAV，或者直接把会议记录的文字贴进来 —— 提炼那一步是一样的。",
            "upload",
          );
        }
        throw err;
      }
      console.warn(`[api/meeting/audio] ${slotId} 收到 ${f.name}，${Math.round(seconds)} 秒，开始转写。`);
      try {
        transcript = await transcribePcm(pcm, { sessionId: `meeting-${slotId}` });
      } catch (err) {
        if (err instanceof ASRNotConfigured) {
          /*
           * **这句话在这里重写一遍，不用 `err.message`。**
           *
           * 那一句是给语音条写的（「语音条那个输入框还能用」）—— 而这一屏上没有语音条，
           * 他刚做的事是传一份录音。把一句指着别处的话原样搬过来，读的人会去找一个这一屏
           * 上不存在的东西。缺的那把 key 是同一把，所以名字照写。
           */
          return fail(
            503,
            "还没配语音识别的 key（DASHSCOPE_API_KEY），这份录音转不成文字。" +
              "先把会议记录的文字贴进来 —— 后面提炼要点和待办那一步是一样的。",
            "transcribe",
          );
        }
        console.error(`[api/meeting/audio] ${slotId} 转写失败：`, err);
        return fail(
          502,
          `这份录音没转成文字：${err instanceof Error ? err.message : String(err)}`,
          "transcribe",
        );
      }
    }
  }

  try {
    /*
     * 收下就返回。**提炼不在这条请求里跑了** —— 判材料和按议题提炼都挪进了后台任务
     * （见 `ingestMeetingNotes`），因为那一块要留在议题栏原地不动地跑，屏幕得在他松手
     * 那一刻就拿到「正在判」。这里回的是那一刻的状态，之后由屏幕问 `slotIntakeState`。
     */
    const intake = await runAsActor(CEO_ACTOR, () =>
      api.ingestMeetingNotes(slotId, transcript, sourceName),
    );
    return Response.json({
      slotId,
      /* 转写全文一起回给屏幕：他要能核对「提炼是从哪几句里出来的」。 */
      transcript,
      intake,
    });
  } catch (err) {
    // 业务性失败（这场会不存在、记录太短、这场会上没有议题）—— 原话可以直接上屏。
    if (err instanceof ApiError) return fail(409, err.message, "extract");
    console.error(`[api/meeting/audio] ${slotId} 提炼失败：`, err);
    return fail(500, "这一段在服务端出错了，原因写进了服务端日志。", "extract");
  }
}
