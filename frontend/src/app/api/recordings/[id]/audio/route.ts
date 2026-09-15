/**
 * 详情页那个 `<audio>` 的源。**302 到一条现签的预签名 URL，不把 URL 交给前端。**
 *
 * 为什么是重定向而不是在详情数据里回一条 URL：预签名 URL 有有效期。放进详情数据的话，
 * 他开着页面听一小时，中途那条 URL 过期 —— 表现是拖动进度条突然放不出声，而页面上
 * 一切正常。走重定向的话，浏览器每次要音频都重新问一次，签的永远是新的。
 *
 * 代价是每次播放多一跳。那一跳只是签个名，不下载音频（对象存储直接把字节发给浏览器）。
 */
import { NextResponse } from "next/server";

import { recordingsTable } from "@/lib/data/store";
import { RecordingNotConfigured } from "@/lib/recording/config";
import * as rec from "@/lib/recording/registry";
import { presignGet } from "@/lib/recording/tos";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/** 签一小时。够听完一场会，过期了浏览器自己会再来问一次。 */
const TTL_SECONDS = 3600;

export async function GET(
  _req: Request,
  ctx: { params: Promise<{ id: string }> },
): Promise<Response> {
  const { id } = await ctx.params;
  const r = rec.find(recordingsTable(), id);
  if (!r) return new NextResponse("这份录音不在了。", { status: 404 });
  if (!r.audioKey) {
    /*
     * 还没传上去（正在转码，或者转码就倒了）。**404 而不是 500** —— `<audio>` 拿到
     * 500 会在控制台里红一片，而这只是「还没到那一步」。
     */
    return new NextResponse("这份录音还没处理完，暂时没有可播的音频。", { status: 404 });
  }

  try {
    const url = presignGet(r.audioKey, TTL_SECONDS);
    /*
     * 307 而不是 302：302 允许把方法改成 GET，而这里本来就是 GET —— 但浏览器对
     * range 请求（拖进度条）的重定向处理，307 的语义「原样重发」更明确。
     * 不缓存这一跳：缓存住的话下一次拿到的是同一条已经过期的 URL。
     */
    return NextResponse.redirect(url, {
      status: 307,
      headers: { "cache-control": "no-store" },
    });
  } catch (err) {
    if (err instanceof RecordingNotConfigured) {
      return new NextResponse(err.message, { status: 503 });
    }
    console.error(`[api/recordings] ${id} 签音频地址失败：`, err);
    return new NextResponse("签音频地址时出错了，原因写进了服务端日志。", { status: 502 });
  }
}
