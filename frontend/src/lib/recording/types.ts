/**
 * 录音与逐字稿。**这一层只管「把一场会变成带说话人和时间戳的文字」，不做提炼。**
 *
 * ## 为什么另起一套，而不是塞进 `Meeting` / `MeetingSlot`
 *
 * 那两个都被占了，而且含义都不是这件事：`Meeting` 是一个域一场的战略会（带准备→进行→
 * 开完的状态机），`MeetingSlot` 是一号位在排会面板上排出来的时间槽。这里这个东西的身份
 * 是**一份音频**——它可能压根不对应任何一场排过的会（手机里翻出来的一段录音也要能转），
 * 所以它有自己的 id、自己的生命周期。`issueId` 留着但暂时不填，等以后要把一份录音挂回
 * 某件议题时再用。
 *
 * ## 为什么正文不在这里
 *
 * `RecordingUtterance` 一小时会有一两千条。它们不进对象库快照——那份快照是**整份重写**
 * 的（`persist.ts`），几场会就能让每一次落盘都在搬几 MB 跟这次改动无关的句子。所以
 * `Recording` 是元数据、进 store；句子和说话人落 `.data/recordings/<id>.json`，由
 * `transcript.ts` 单独读写。
 *
 * 代价说清楚：这两份东西可能对不上（store 说 done、文件不在）。所以读那一侧
 * （`readTranscript`）把「文件不在」当成一个合法答案返回空，而不是抛——一份逐字稿丢了
 * 不该让整个录音页打不开，屏幕上要能看见「这一场的正文没了」。
 */

/**
 * 一份录音此刻走到哪一步。**这几档是分开的，不合并成一个「处理中」。**
 *
 * 每一档卡住的原因完全不同，而且要给的下一步动作也不同：`transcoding` 卡住多半是
 * ffmpeg 不在或者这个格式它啃不动（本机问题，重试没用）；`uploading` 卡住是 TOS 那把
 * 凭据或者网（重试有用）；`transcribing` 卡住是厂商那边在排队（只能等）。合成一档的话，
 * 屏幕上那三种情况长得一模一样，而它们该说的话是三句。
 */
export type RecordingStatus =
  | "recording"
  | "uploaded"
  | "transcoding"
  | "uploading"
  | "transcribing"
  | "done"
  | "failed";

/** 这一份音频是怎么来的。上传的那些没有 `startedAt` 之外的现场信息。 */
export type RecordingSource = "live" | "upload";

/**
 * 失败发生在哪一段。**和 `RecordingStatus` 不是同一件事** —— 状态说的是「此刻在哪」，
 * 这个说的是「倒在哪」。倒下之后状态是 `failed`，那一格就答不出是哪一段倒的了，而
 * 「要不要给重试按钮」恰好由它决定：本机没装 ffmpeg 重试一万次也是同一个结果。
 */
export type RecordingFailStage = "transcode" | "upload" | "transcribe" | "parse";

export interface Recording {
  /** `REC-<yyyymmdd>-<6 位>`。生成时带上日期，运维在 .data 目录里能直接看出是哪天的。 */
  id: string;
  /**
   * 以后要把这一份挂回某件战略议题时填。**现在一律为空**。
   *
   * 先留着这一格而不是等要用时再加：这张表会真的落盘，事后加字段意味着所有旧记录
   * 都没有它，而「没有这个字段」和「有但是空」在读的那一侧要写两套判断。
   */
  issueId?: string;
  /** 默认 `会议 YYYY-MM-DD HH:mm`，可改。 */
  title: string;
  source: RecordingSource;
  status: RecordingStatus;
  /** 倒在哪一段。只在 `status === "failed"` 时有值。 */
  failStage?: RecordingFailStage;
  /**
   * 失败原因，**照抄原话，不改写成「处理失败」**。
   *
   * 「ffmpeg 不在 PATH 上」和「TOS 拒绝了这次上传：403」指向两条完全不同的排查路径，
   * 而「处理失败」两条都不指。厂商返回的错误码原样带进来。
   */
  error?: string;
  startedAt: string;
  endedAt?: string;
  /** ffprobe 探出来的时长。转码之前不知道，所以可空。 */
  durationMs?: number;
  /**
   * 本机那份原始音频的路径（拼好的 webm，或上传进来的原文件）。
   *
   * 存绝对路径而不是只存文件名：`TKOS_DATA_DIR` 可以被改，而一份存了半年的记录里
   * 那个相对名字要靠「当时那个环境变量是什么」才解得开。
   */
  rawAudioPath?: string;
  /** 规整后那份 mp3 在 TOS 上的 key。留着是为了以后能重跑而不用重传。 */
  audioKey?: string;
  /** 火山那边的任务 id。重启之后靠它接着轮询，而不是重新提交一次（那是重新计一次费）。 */
  asrTaskId?: string;
  /**
   * 参会人。喂给热词用，也给屏幕上改说话人名时做候选。
   *
   * **不做自动对名** —— 谁是谁要人来认。这里有名字不等于逐字稿里的说话人就叫这个。
   */
  participants: string[];
  /** live 那一路收到的最后一个分片序号。断线重连时靠它判断该从哪一片续。 */
  lastChunkSeq?: number;
  createdAt: string;
  updatedAt: string;
}

/**
 * 一句话。**按厂商原始分句存，一句不合并。**
 *
 * 合并要丢东西：连续两句同一个人说的话之间那个间隔，是「他停顿了三秒」还是「接着说」，
 * 合并之后就没了。展示层把连续同人的句子并成一段是展示层的事，库里留着原样——反过来
 * 做不到。
 */
export interface RecordingUtterance {
  /** 顺序号，从 0 起。厂商返回的次序就是它。 */
  idx: number;
  /** 厂商给的说话人编号，**原样存字符串**。它可能是 `1`、可能是 `speaker_1`，不揣测。 */
  speakerId: string;
  /** 毫秒。厂商用秒的话在映射那一层换算掉，库里只有一种单位。 */
  startMs: number;
  endMs: number;
  text: string;
}

/** 说话人。只有一件事：这个编号，人给它起了什么名字。 */
export interface RecordingSpeaker {
  speakerId: string;
  /** 人改过的名字。没改过就是空，屏幕上显示「说话人 1」这类由展示层拼。 */
  displayName?: string;
}

/** 落在 `.data/recordings/<id>.json` 里的那一份。 */
export interface RecordingTranscript {
  recordingId: string;
  utterances: RecordingUtterance[];
  speakers: RecordingSpeaker[];
  /**
   * 厂商返回的原文，**整个存下来一个字不改**。
   *
   * 存它是因为映射那一层一定会出错：某个字段名猜错了、某一档单位是秒不是毫秒、
   * 某种情况下 `speaker` 字段压根不出现。这些都要等真数据到手才发现，而那时候
   * 如果只存了映射后的结果，唯一的办法是重新花一次钱转一遍。
   */
  raw: unknown;
}

/** 列表页一行要的东西。正文不进列表——那是一两千条句子乘以行数。 */
export interface RecordingSummary {
  id: string;
  title: string;
  source: RecordingSource;
  status: RecordingStatus;
  failStage?: RecordingFailStage;
  error?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  /** 认出来几个说话人。列表上一眼看出「这一场只认出一个人」——那多半是麦克风的事。 */
  speakerCount?: number;
  utteranceCount?: number;
}

/** 详情页一次要齐的东西。音频不在里面，那是 `/api/recordings/<id>/audio` 那条。 */
export interface RecordingDetail {
  recording: Recording;
  utterances: RecordingUtterance[];
  speakers: RecordingSpeaker[];
}
