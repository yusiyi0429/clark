/**
 * 逐字稿正文的落盘。一份录音一个文件，`.data/recordings/<id>.json`。
 *
 * ## 为什么正文不进对象库快照
 *
 * 对象库那份快照是**整份重写**的（`lib/data/persist.ts`：`JSON.stringify` 整个 state
 * 再 rename）。一小时的会有一两千条句子，几场会之后每一次落盘——哪怕改的只是某件议题
 * 的一行标题——都在把几 MB 跟这次改动无关的句子重新序列化一遍再写一遍盘。而这些句子
 * 转出来之后就再也不变了，是整个库里最不该被反复搬运的东西。
 *
 * 所以切在这里：`Recording` 那点元数据（状态、时长、说话人数）进 store，正文按录音分
 * 文件、按需读。列表页翻一百场会一条句子都不用读。
 *
 * ## 代价
 *
 * 两份东西会对不上：store 说这一场 `done`，文件却不在（手工清过 .data、拷贝部署时漏
 * 了这个目录、盘满了那一次写没成）。这不是异常，是这个设计换来的常态，所以读的那一侧
 * 把「文件不在」当**合法答案**返回 `null` 而不是抛——一份逐字稿丢了不该让整个录音页
 * 打不开，屏幕上该看见的是「这一场的正文没了」。
 *
 * 另一个代价：没有事务。写正文和改 store 里的状态是两次独立的落盘，中间崩了就是上面
 * 那个对不上的状态。真要一致得把两者塞回一个库，那就回到了整份重写。
 *
 * ## 关于 Windows
 *
 * 原子写用 `renameSync` 覆盖目标文件。这在 Windows 上是可以的（Node 走 `MoveFileEx`
 * 带 `REPLACE_EXISTING`），不像某些人记忆里的 POSIX-only 假设。但有一条 POSIX 上没有
 * 的失败：目标文件正被别的进程打开时会 `EPERM`——杀毒软件扫描、编辑器开着那个 json、
 * 另一个 node 进程在读，都算。这时候写会抛，而我们**故意让它抛**：一次没存下去的逐字
 * 稿如果悄悄咽掉，用户改完说话人名字看着像成了，刷新之后名字没了。
 */
import { existsSync, mkdirSync, renameSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { RecordingSpeaker, RecordingTranscript } from "./types";

/**
 * 根目录跟对象库同一个（`lib/data/persist.ts` 里是同一行表达式），下面开 `recordings/`。
 *
 * 每次调用重新读环境变量，不像 persist.ts 那样在模块加载时算成常量：那边整个进程只有
 * 一份 store，加载即定型没问题；这边被单测反复指到不同的临时目录，算成常量的话
 * `TKOS_DATA_DIR` 就必须在 import 之前设好——一个只在测试里踩、错法还很隐蔽的坑
 * （测试之间互相污染，单跑绿、全量跑红）。多几次字符串拼接换掉它，划算。
 */
const dataDir = (): string => process.env.TKOS_DATA_DIR || join(process.cwd(), ".data");

/**
 * 只允许 `[A-Za-z0-9_-]`。**这不是洁癖，是这个 id 从 URL 参数一路走到 `unlinkSync`。**
 *
 * `deleteTranscript("../../store")` 拼出来的路径正好落在对象库那份快照上，一次「删掉这
 * 段录音」会把整个库删掉。白名单而不是黑名单：黑名单要同时想到 `..`、`%2e%2e`、反斜杠、
 * 绝对路径、盘符（`C:`）、NTFS 数据流（`a:b`）、Windows 保留名（`CON`、`NUL`），漏一个
 * 就白做；白名单漏掉的只是一个本来也不该出现的 id。
 *
 * 现在的 id 形如 `REC-20260831-a1b2c3`，全在白名单里。
 */
const ID_RE = /^[A-Za-z0-9_-]+$/;

function assertId(recordingId: string): string {
  if (!ID_RE.test(recordingId)) {
    throw new Error(`[tkos:transcript] 非法的 recordingId：${JSON.stringify(recordingId)}`);
  }
  return recordingId;
}

/** 一份逐字稿落在哪。`.data/recordings/<id>.json`，根目录跟对象库同一个。 */
export function transcriptPath(recordingId: string): string {
  return join(dataDir(), "recordings", `${assertId(recordingId)}.json`);
}

/**
 * 原子写：先写 `<file>.tmp` 再 rename。
 *
 * 理由和 persist.ts 一样，而且在这里更要命：写一半断电留下的半个 JSON **比没有更糟**。
 * 没有的话读那一侧返回 null，屏幕上说「正文没了」，还能重跑一次转写；半个 JSON 解析失败
 * 也是 null，但它占着位置，看起来像「已经有了」。
 *
 * 临时文件名固定不带随机后缀：同一份逐字稿并发写就会撞。这和 persist.ts 一样是单写者
 * 假设——一份逐字稿的写入方只有转写完成那一下和改说话人名字那一下，都在同一个进程里
 * 顺序发生。
 */
export function writeTranscript(t: RecordingTranscript): void {
  const file = transcriptPath(t.recordingId);
  const tmp = `${file}.tmp`;
  mkdirSync(join(dataDir(), "recordings"), { recursive: true });
  writeFileSync(tmp, JSON.stringify(t), "utf8");
  renameSync(tmp, file);
}

/**
 * 读回。文件不在返回 `null`，不抛——见文件头，这是这个设计换来的常态。
 *
 * 内容损坏（JSON 解析失败）也返回 `null`，但要 `console.error` 一声：它和「文件不在」在
 * 调用方看来一样，可对运维不一样。文件不在多半是没转过或者被清过；解析失败说明有一次
 * 写坏了或者盘出问题了，那是要去看的。
 *
 * 但 id 非法照样抛。「文件不在」是数据的事，「这个 id 不合法」是调用方的事——悄悄返回
 * null 会把一次路径穿越尝试变成一次「没找到」，日志里一个字都不剩。
 */
export function readTranscript(recordingId: string): RecordingTranscript | null {
  const file = transcriptPath(recordingId);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8")) as RecordingTranscript;
  } catch (err) {
    console.error(`[tkos:transcript] ${file} 解析失败，当成没有：`, err);
    return null;
  }
}

/**
 * 改一个说话人的名字。文件不在返回 `false`。
 *
 * **改一个不在 `speakers[]` 里、但在句子里出现过的 speakerId：补一条再改，返回 true。**
 * 这不是容错，是常态：`speakers[]` 由映射那一层填，而厂商在某些返回里只在句子上带
 * `speaker` 字段、不单独给说话人列表。这时候屏幕上明明列着「说话人 3」（那是从句子里
 * 数出来的），改名却失败，讲不通。
 *
 * **改一个哪里都没出现过的 speakerId：不动文件，返回 `false`。**
 * 这种只可能是调用方的 bug（打错了、或者拿着上一份逐字稿的 id）。这时候顺手补一条进
 * `speakers[]` 是最坏的选择：库里从此多一个没有任何一句话属于它的说话人，它会一直显示
 * 在说话人列表上，而且没有任何入口能删掉——一个静默的、只增不减的脏数据。返回 false
 * 让这次调用当场就是错的。
 */
export function renameSpeaker(recordingId: string, speakerId: string, displayName: string): boolean {
  const t = readTranscript(recordingId);
  if (!t) return false;

  const speakers: RecordingSpeaker[] = t.speakers ?? [];
  const hit = speakers.find((s) => s.speakerId === speakerId);
  if (hit) {
    hit.displayName = displayName;
  } else if (t.utterances?.some((u) => u.speakerId === speakerId)) {
    speakers.push({ speakerId, displayName });
  } else {
    return false;
  }

  writeTranscript({ ...t, speakers });
  return true;
}

/** 删掉一份（录音被删时）。不存在也不抛——重复删和删一个从来没转过的录音都是正常路径。 */
export function deleteTranscript(recordingId: string): void {
  const file = transcriptPath(recordingId);
  try {
    if (existsSync(file)) unlinkSync(file);
  } catch (err) {
    // existsSync 到 unlinkSync 之间还有一条缝（别处刚好删掉了）。缝里的 ENOENT 正是我们想要的结果。
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * 说话人在这份逐字稿里的次序，从 1 起。
 *
 * **不能用厂商给的编号。** 它可能从 0 起（于是屏幕上出现「说话人 0」，没有人这样数人），
 * 也可能压根不是数字（`speaker_2`、`spk-A`），直接拿来拼字符串就是一句乱码。所以按
 * 「在这份逐字稿里第一次开口的先后」重新编号：谁先说话谁是 1。
 *
 * 按 `idx` 排而不是按数组下标：数组顺序是写文件时的顺序，通常就是 idx 序，但那是约定不是
 * 保证；而「谁先开口」这件事的定义在 idx 上，不在存储顺序上。
 *
 * 一句话都没说、只在 `speakers[]` 里挂着的（改过名又被重转掉的残留），排在所有开口过的
 * 人后面，按 `speakers[]` 的顺序——它们没有「第一次开口」可言，但也不能没有编号。
 */
function speakerOrder(t: RecordingTranscript): Map<string, number> {
  const order = new Map<string, number>();
  const byIdx = [...(t.utterances ?? [])].sort((a, b) => a.idx - b.idx);
  for (const u of byIdx) if (!order.has(u.speakerId)) order.set(u.speakerId, order.size + 1);
  for (const s of t.speakers ?? []) if (!order.has(s.speakerId)) order.set(s.speakerId, order.size + 1);
  return order;
}

/**
 * `HH:MM:SS`。超过一小时正常进位（`01:23:45`），不满一小时也留 `00:` 前缀。
 *
 * 留前缀是为了导出的纯文本每一行等宽——一屏几百行，时间列参差不齐时眼睛没法顺着扫。
 * 代价是十分钟的会里每行多两个没信息量的字符，换的是整列能对齐。
 */
function hms(ms: number): string {
  const total = Math.max(0, Math.floor(ms / 1000));
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(Math.floor(total / 3600))}:${pad(Math.floor(total / 60) % 60)}:${pad(total % 60)}`;
}

/** 展示名。人改过就用人改的，没改过按开口次序拼「说话人 N」。 */
function labelFrom(order: Map<string, number>, speakers: RecordingSpeaker[], speakerId: string): string {
  const named = speakers.find((s) => s.speakerId === speakerId)?.displayName;
  if (named) return named;
  const n = order.get(speakerId);
  /*
   * 这个 id 在这份逐字稿里根本不存在，给不出次序。不拿 id 去拼——那正好是这个函数要防的
   * 「说话人 0」。给一个明显不是编号的占位，屏幕上一眼看出是数据对不上，不是真有这么个人。
   */
  return n === undefined ? "说话人 ?" : `说话人 ${n}`;
}

/**
 * 一个说话人在屏幕上该显示什么。`displayName` 有就用它，没有就「说话人 N」。
 *
 * N 是这个 speakerId 在这份逐字稿里**第一次开口的次序**（从 1 起），不是厂商给的编号。
 */
export function speakerLabel(t: RecordingTranscript, speakerId: string): string {
  return labelFrom(speakerOrder(t), t.speakers ?? [], speakerId);
}

/**
 * 拼成纯文本导出：`[00:03:12] 王总：这一版先不改。`
 *
 * 一句一行，按 `idx` 序，**不合并连续同人的句子**。合并会丢掉句与句之间那个间隔（是停顿
 * 三秒还是接着说），而这份文本常常是拿去给人读的，那个节奏有意义。
 *
 * 结尾带换行：这是要落成 `.txt` 给人下载的，少一个结尾换行会让追加内容时两行黏在一起。
 *
 * 说话人名单只算一次（`speakerOrder` 要排序），否则一两千行就是一两千次排序。
 */
export function toPlainText(t: RecordingTranscript): string {
  const order = speakerOrder(t);
  const speakers = t.speakers ?? [];
  const byIdx = [...(t.utterances ?? [])].sort((a, b) => a.idx - b.idx);
  return byIdx
    .map((u) => `[${hms(u.startMs)}] ${labelFrom(order, speakers, u.speakerId)}：${u.text}\n`)
    .join("");
}
