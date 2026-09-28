/**
 * 输入框语音转文字：浏览器录一小段 → 这里转成 mp3 → 火山「录音文件极速版」一次拿回文字。
 *
 * 只转文字、不落库：上传和转码产物只活在请求期间的临时目录里，请求结束就删。
 * 凭据与资源 id 都和会议录音共用 VOLC_ASR_*（recordingConfig.ts），不用另外开通。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RecordingNotConfigured, volcAsrConfig } from "./recordingConfig.js";
import { MediaToolsMissing, transcodeToMp3 } from "./recordingMedia.js";
import { AsrRejected, recognizeFlash } from "./volcAsr.js";

/** 浏览器 webm/opus 大约 4 KB/秒：10 MB 够说半小时，一句话远小于此。 */
export const MAX_DICTATION_UPLOAD_BYTES = 10 * 1024 * 1024;

/** 外部依赖边界（配置 + ffmpeg + 火山）：测试注入假实现。 */
export type DictationDeps = {
  /** 缺配时抛 RecordingNotConfigured（写明缺哪个变量，不含值）。 */
  requireConfig(): void;
  toMp3(inputPath: string, outputPath: string): Promise<string>;
  recognize(mp3: Buffer): Promise<string>;
};

export const realDictationDeps: DictationDeps = {
  requireConfig: () => void volcAsrConfig(),
  toMp3: (inputPath, outputPath) => transcodeToMp3(inputPath, outputPath),
  recognize: recognizeFlash,
};

export type DictationFailure = { ok: false; status: 400 | 502 | 503; code: string; message: string };

const failure = (status: DictationFailure["status"], code: string, message: string): DictationFailure => ({ ok: false, status, code, message });

/** 一段录音转成文字。没听到人声时是空串（不是失败），由前端提示「没听清」。 */
export async function dictate(deps: DictationDeps, audio: Buffer | null): Promise<{ ok: true; text: string } | DictationFailure> {
  try {
    deps.requireConfig();
  } catch (err) {
    if (err instanceof RecordingNotConfigured) return failure(503, "DICTATION_NOT_CONFIGURED", err.message);
    throw err;
  }
  if (!audio?.length) return failure(400, "DICTATION_AUDIO_REQUIRED", "没有收到录音：请把音频放在 audio 字段里上传。");

  const dir = await mkdtemp(join(tmpdir(), "warmap-dictation-"));
  try {
    const uploaded = join(dir, "upload");
    await writeFile(uploaded, audio, { mode: 0o600 });
    let mp3: Buffer;
    try {
      mp3 = await readFile(await deps.toMp3(uploaded, join(dir, "dictation.mp3")));
    } catch (err) {
      if (err instanceof MediaToolsMissing) return failure(503, "MEDIA_TOOLS_MISSING", err.message);
      return failure(400, "DICTATION_AUDIO_INVALID", "这段录音解不开，换个浏览器或重说一次试试。");
    }
    try {
      return { ok: true, text: await deps.recognize(mp3) };
    } catch (err) {
      const said = err instanceof Error ? err.message : String(err);
      return err instanceof AsrRejected
        ? failure(400, "DICTATION_REJECTED", said.slice(0, 500))
        : failure(502, "DICTATION_PROVIDER_FAILED", `语音转文字没成功：${said}`.slice(0, 500));
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
