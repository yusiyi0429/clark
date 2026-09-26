/**
 * 声纹：成员本人在 /me 录一段朗读 → 腾讯云说话人注册；会后按「说话人 N」从会议录音里截一段做 1:N，
 * 分数够高就把这个人预填进「确认每位说话人是谁」对话框。**只是建议，永远由人确认，不自动确认。**
 *
 * 声纹属于《个人信息保护法》所称的敏感个人信息（生物识别信息）：
 * - 只有本人在单独告知用途后明确同意才能注册（consented_at 必填，每次重录重新记一次）；
 * - 本人随时可以自己删除，删除时腾讯那边和库里一起删；
 * - 服务器不留声纹原始录音：注册用的上传和转码产物在请求结束时删掉，会后截出的片段用完即删。
 */
import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TPersonResult, TVoiceprintStatus } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";
import { logEvent } from "./observability.js";
import { MediaToolsMissing, PCM_BYTES_PER_SECOND, toVoiceprintPcm, type PcmSegment } from "./recordingMedia.js";
import { speakerLabels } from "./recordingTranscript.js";
import {
  createTencentVoiceprintApi,
  tencentVoiceprintConfig,
  VoiceprintMissing,
  VoiceprintNotConfigured,
  VoiceprintProviderError,
  voiceprintConfigured,
  type TencentVoiceprintApi,
} from "./tencentVoiceprint.js";
import type { SpeakerSuggestion } from "./transcriptCandidate.js";
import type { RecordingSpeaker, RecordingUtterance } from "./volcAsr.js";

/** 浏览器录 30 秒左右的 webm/opus 或 mp4 远小于此。 */
export const MAX_VOICEPRINT_UPLOAD_BYTES = 10 * 1024 * 1024;
/** 注册音频：腾讯单段上限 30 秒，超出的只取前 30 秒；少于 10 秒不收（声纹不稳）。 */
const ENROLL_MAX_SECONDS = 30;
const ENROLL_MIN_SECONDS = 10;
/** 会后 1:N：一个说话人合计开口不到 3 秒不比（分数不可靠），最多截 15 秒。 */
const MATCH_MIN_SPEECH_MS = 3_000;
const MATCH_CLIP_MS = 15_000;
/**
 * 文档建议 70 分以上认为是同一个人，但实测（合成语音）同一人 97.6、另一个中文女声 78.1：按 70 会把没录声纹的人预填成已录的人。
 * 先取 85；每次比对的分数都记在 voiceprint.match 日志里，有了真人数据再调。
 */
export const MATCH_THRESHOLD = 85;

/** 外部依赖边界（ffmpeg + 腾讯云 + 配置）：测试注入假实现，生产用 realVoiceprintDeps。 */
export type VoiceprintDeps = TencentVoiceprintApi & {
  configured(): boolean;
  /** 缺配时抛 VoiceprintNotConfigured（写明缺哪个变量，不含值）。 */
  requireConfig(): { groupId: string };
  toPcm(inputPath: string, outputPath: string, opts: { maxSeconds: number; segments?: PcmSegment[] }): Promise<void>;
};

export const realVoiceprintDeps: VoiceprintDeps = {
  ...createTencentVoiceprintApi(),
  configured: voiceprintConfigured,
  requireConfig: () => ({ groupId: tencentVoiceprintConfig().groupId }),
  toPcm: toVoiceprintPcm,
};

export type VoiceprintFailure = { ok: false; status: 400 | 502 | 503; code: string; message: string };

type VoiceprintRow = { provider_voiceprint_id: string; group_id: string; updated_at: Date };

const failure = (status: VoiceprintFailure["status"], code: string, message: string): VoiceprintFailure => ({ ok: false, status, code, message });

async function findRow(q: Query, personId: string): Promise<VoiceprintRow | null> {
  const result = await q("SELECT provider_voiceprint_id, group_id, updated_at FROM person_voiceprints WHERE person_id = $1", [personId]);
  return (result.rows[0] as VoiceprintRow | undefined) ?? null;
}

export async function voiceprintStatus(q: Query, deps: VoiceprintDeps, personId: string): Promise<TVoiceprintStatus> {
  const row = await findRow(q, personId);
  return { enrolled: Boolean(row), updatedAt: row?.updated_at.toISOString() ?? null, configured: deps.configured() };
}

function notConfigured(deps: VoiceprintDeps): VoiceprintFailure | { groupId: string } {
  try {
    return deps.requireConfig();
  } catch (err) {
    if (err instanceof VoiceprintNotConfigured) return failure(503, "VOICEPRINT_NOT_CONFIGURED", err.message);
    throw err;
  }
}

function providerFailure(err: unknown): VoiceprintFailure {
  if (err instanceof VoiceprintProviderError && err.code === "InvalidParameterValue.NoHumanVoice") {
    return failure(400, "VOICEPRINT_NO_VOICE", "这段录音里没听到清楚的人声，请在安静的地方靠近麦克风重录一次。");
  }
  const said = err instanceof Error ? err.message : String(err);
  return failure(502, "VOICEPRINT_PROVIDER_FAILED", `腾讯云声纹服务没办成这件事：${said}`.slice(0, 500));
}

/** 按腾讯的分组语义放进当前声纹组：同组就更新；换了组只能删掉重注册（更新不带分组，也没有「加入分组」接口）。 */
async function register(deps: VoiceprintDeps, existing: VoiceprintRow | null, groupId: string, pcm: Buffer): Promise<string> {
  if (existing && existing.group_id === groupId) {
    try {
      await deps.update({ voicePrintId: existing.provider_voiceprint_id, pcm });
      return existing.provider_voiceprint_id;
    } catch (err) {
      // 控制台里被删掉了：重新注册一条
      if (!(err instanceof VoiceprintMissing)) throw err;
    }
  } else if (existing) {
    await deps.remove(existing.provider_voiceprint_id);
  }
  return deps.enroll({ pcm, groupId });
}

/** 录入或重录本人声纹。顺序：配置 → 同意 → 音频 → 转码与时长 → 腾讯 → 落库。 */
export async function enrollVoiceprint(
  q: Query,
  deps: VoiceprintDeps,
  personId: string,
  input: { consent: boolean; audio: Buffer | null },
): Promise<{ ok: true; value: TVoiceprintStatus } | VoiceprintFailure> {
  const config = notConfigured(deps);
  if ("ok" in config) return config;
  if (!input.consent) {
    return failure(400, "VOICEPRINT_CONSENT_REQUIRED", "录入声纹前需要你本人明确同意（consent=true）：声纹只用于会后预填说话人，你可以随时删除。");
  }
  if (!input.audio?.length) return failure(400, "VOICEPRINT_AUDIO_REQUIRED", "没有收到录音：请把音频放在 audio 字段里上传。");

  // 上传和转码产物只在这个临时目录里活到请求结束
  const dir = await mkdtemp(join(tmpdir(), "warmap-voiceprint-"));
  let pcm: Buffer;
  try {
    const uploaded = join(dir, "upload");
    const converted = join(dir, "voiceprint.pcm");
    await writeFile(uploaded, input.audio, { mode: 0o600 });
    try {
      await deps.toPcm(uploaded, converted, { maxSeconds: ENROLL_MAX_SECONDS });
    } catch (err) {
      if (err instanceof MediaToolsMissing) return failure(503, "MEDIA_TOOLS_MISSING", err.message);
      return failure(400, "VOICEPRINT_AUDIO_INVALID", "这段录音解不开，换个浏览器或重录一次试试。");
    }
    pcm = await readFile(converted);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const seconds = pcm.length / PCM_BYTES_PER_SECOND;
  if (seconds < ENROLL_MIN_SECONDS) {
    return failure(400, "VOICEPRINT_TOO_SHORT", `录音只有约 ${Math.floor(seconds)} 秒，至少需要 ${ENROLL_MIN_SECONDS} 秒连续朗读（30 秒左右最好），请重录。`);
  }

  let voicePrintId: string;
  try {
    voicePrintId = await register(deps, await findRow(q, personId), config.groupId, pcm);
  } catch (err) {
    return providerFailure(err);
  }
  await q(
    `INSERT INTO person_voiceprints (person_id, provider_voiceprint_id, group_id, consented_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (person_id) DO UPDATE
       SET provider_voiceprint_id = EXCLUDED.provider_voiceprint_id, group_id = EXCLUDED.group_id,
           consented_at = EXCLUDED.consented_at, updated_at = now()`,
    [personId, voicePrintId, config.groupId],
  );
  return { ok: true, value: await voiceprintStatus(q, deps, personId) };
}

/** 本人删除：先删腾讯那边再删库里的行；没有声纹时直接算成功。缺配时不删行，免得腾讯那边留下一条没人管的声纹。 */
export async function deleteVoiceprint(q: Query, deps: VoiceprintDeps, personId: string): Promise<{ ok: true } | VoiceprintFailure> {
  const existing = await findRow(q, personId);
  if (!existing) return { ok: true };
  const config = notConfigured(deps);
  if ("ok" in config) return config;
  try {
    await deps.remove(existing.provider_voiceprint_id);
  } catch (err) {
    return providerFailure(err);
  }
  await q("DELETE FROM person_voiceprints WHERE person_id = $1", [personId]);
  return { ok: true };
}

/** 长句优先截满 15 秒（长句里夹着别人和句首句尾空白的比例小），再按时间排回去。合计不到 3 秒返回 null。 */
function pickClip(segments: PcmSegment[]): PcmSegment[] | null {
  const total = segments.reduce((sum, s) => sum + (s.endMs - s.startMs), 0);
  if (total < MATCH_MIN_SPEECH_MS) return null;
  const clip: PcmSegment[] = [];
  let left = MATCH_CLIP_MS;
  for (const s of [...segments].sort((a, b) => b.endMs - b.startMs - (a.endMs - a.startMs))) {
    if (left <= 0) break;
    const take = Math.min(s.endMs - s.startMs, left);
    clip.push({ startMs: s.startMs, endMs: s.startMs + take });
    left -= take;
  }
  return clip.sort((a, b) => a.startMs - b.startMs);
}

/**
 * 会后 1:N：每个「说话人 N」截一段去公司声纹组里取 top-1；分数 ≥ 阈值且是人员目录里的人才算建议。
 * 同一个人只给一个说话人（分数高的那个）。单个说话人出错只跳过它；返回 speakerName → 建议。
 */
export async function suggestSpeakersByVoiceprint({
  q,
  deps,
  mp3Path,
  workDir,
  utterances,
  speakers,
  people,
  objectRef,
}: {
  q: Query;
  deps: VoiceprintDeps;
  mp3Path: string;
  workDir: string;
  utterances: RecordingUtterance[];
  speakers: RecordingSpeaker[];
  people: TPersonResult[];
  objectRef: string;
}): Promise<Map<string, SpeakerSuggestion>> {
  const suggestions = new Map<string, SpeakerSuggestion>();
  if (!deps.configured()) return suggestions;
  const { groupId } = deps.requireConfig();
  const enrolled = await q("SELECT person_id, provider_voiceprint_id FROM person_voiceprints WHERE group_id = $1", [groupId]);
  // 组里一个人都没有：不花这几次调用
  if (!enrolled.rowCount) return suggestions;
  const personByVoiceprint = new Map((enrolled.rows as { person_id: string; provider_voiceprint_id: string }[]).map((r) => [r.provider_voiceprint_id, r.person_id]));
  const personById = new Map(people.map((p) => [p.personId, p]));

  const labels = speakerLabels(utterances, speakers);
  // 「未标注」混着好几个人，不比
  const unlabeled = new Set(speakers.filter((s) => s.displayName).map((s) => s.speakerId));
  const segmentsBySpeaker = new Map<string, PcmSegment[]>();
  for (const u of utterances) {
    if (unlabeled.has(u.speakerId) || u.endMs <= u.startMs) continue;
    const name = labels.get(u.speakerId)!;
    segmentsBySpeaker.set(name, [...(segmentsBySpeaker.get(name) ?? []), { startMs: u.startMs, endMs: u.endMs }]);
  }

  const best = new Map<string, { speakerName: string; score: number }>();
  const scores: { speakerName: string; score: number | null; personId: string | null; error?: string }[] = [];
  for (const [speakerName, segments] of segmentsBySpeaker) {
    const clip = pickClip(segments);
    if (!clip) continue;
    const clipPath = join(workDir, `voiceprint-${randomUUID()}.pcm`);
    let top: { voicePrintId: string; score: number } | undefined;
    try {
      await deps.toPcm(mp3Path, clipPath, { maxSeconds: MATCH_CLIP_MS / 1000, segments: clip });
      [top] = await deps.groupVerify({ pcm: await readFile(clipPath), groupId, topN: 1 });
    } catch (err) {
      scores.push({ speakerName, score: null, personId: null, error: err instanceof Error ? err.message.slice(0, 300) : String(err) });
      continue;
    } finally {
      await rm(clipPath, { force: true });
    }
    const personId = top ? (personByVoiceprint.get(top.voicePrintId) ?? null) : null;
    scores.push({ speakerName, score: top?.score ?? null, personId });
    if (!top || top.score < MATCH_THRESHOLD || !personId || !personById.has(personId)) continue;
    const prev = best.get(personId);
    if (!prev || top.score > prev.score) best.set(personId, { speakerName, score: top.score });
  }
  logEvent({ event: "voiceprint.match", objectRef, threshold: MATCH_THRESHOLD, scores });
  for (const [personId, { speakerName, score }] of best) {
    suggestions.set(speakerName, { personId, displayName: personById.get(personId)!.displayName, score });
  }
  return suggestions;
}
