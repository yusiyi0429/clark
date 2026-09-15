/**
 * 秘书控制台 → 投影那块屏，一条进程内的总线。
 *
 * 为什么要有它：口述模式的主线压在模型身上，而会议室的网、供应商的额度、模型的脾气
 * 三件事没有一件是我能保证的。所以必须有一条**完全不经过模型**的路，能把该出现的东西
 * 推到屏幕上 —— 一个人坐在下面，手里一台设备，按数字键就能翻。这条路不是调试工具，
 * 它是这场 demo 的兜底方案。
 *
 * 它走的还是舞台事件那一套形状（`StageEvent`），所以屏幕那边不需要为它写第二套接收
 * 逻辑：热键推出来的证据卡和模型调工具打出来的证据卡，在 reducer 里是同一条 case。
 *
 * **一个诚实的限制**：这是进程内内存，没有 Redis 没有数据库。所以控制台和屏幕必须连到
 * 同一个 Node 进程。`next dev` 是单进程，会议室里那台笔记本也是单进程，这个条件成立。
 * 哪天部署成多实例（Vercel 的 serverless 是多实例），这条总线会静默失效 —— 到那时要换
 * 成一个真的外部总线，不是在这里打补丁。
 */

import type { StageEvent } from "./events";

/** 控制台按一下，屏幕收到的一条。 */
export type BusMessage =
  /** 直接改屏幕。热键推证据卡、翻页、打开图谱走这条。 */
  | { kind: "event"; event: StageEvent }
  /** 接管输入：把这句话当成他说的话塞进 Agent 那一轮。 */
  | { kind: "say"; text: string }
  /**
   * 下一件 / 上一件。
   *
   * 不带 `itemId`：控制台不该去猜屏幕上讲到第几件了。屏幕自己知道呈报过哪几件，它算
   * 得出「下一件」是哪一件 —— 两处各存一份进度，会上必然出现一处对一处错。
   */
  | { kind: "advance"; delta: number }
  /** 停止播报。掐在飞的模型流 + 清空播放队列。M3 的抢话共用这一条命令。 */
  | { kind: "stop" }
  /** 把他刚问的那句话变成一张探索卡。问的是什么只有屏幕自己知道，所以这条不带载荷。 */
  | { kind: "explore" }
  /**
   * 放一条会前备好的台词（`demo/audio/<lineId>.pcm`）。
   *
   * 这是拔了网线之后唯一还能出声的路：一步都不经过模型和厂商。所以它只带一个编号 ——
   * 编号表在 `lib/tts/lines.ts`，控制台和服务端读的是同一份，两处不会对不上。
   */
  | { kind: "play"; lineId: string }
  /** 重播刚才那一段。「这句再说一遍」。 */
  | { kind: "replay" }
  /**
   * 唤醒屏幕那边的声音。
   *
   * 浏览器不许没有用户手势就出声，而投影那块屏整场可能没人碰过 —— 那时候一声都不会响，
   * 还不报错。这条命令让秘书能从另一台设备上把它按醒。
   */
  | { kind: "wake" }
  /**
   * 开麦 / 关麦。
   *
   * 秘书那台设备上必须有这一下：识别一旦开始乱认（会议室有第三个人在旁边说话、空调忽然
   * 转大），要能在**他不动任何东西**的情况下把麦克风掐掉，剩下的用接管输入走完。让他自己
   * 去点屏幕上那个按钮，等于当着客户承认这套东西不好用。
   *
   * 只有关麦保证能成：开麦要浏览器的手势和权限，屏幕那边收到 `on` 之后可能仍然弹不出来 ——
   * 所以第一次开麦还是得他或者秘书在屏幕那台机器上点一下。
   */
  | { kind: "mic"; on: boolean };

type Listener = (message: BusMessage) => void;

/**
 * 一场会 = 一个 key。
 *
 * demo 只有一场，默认 `demo`，控制台和屏幕不用对口令就在同一场里。留这个参数是因为
 * 「两块屏连到同一场」这件事一旦要演两次（比如换个房间再来一遍），没有 key 就串台。
 */
export const DEFAULT_SESSION = "demo";

const rooms = new Map<string, Set<Listener>>();

export function publish(session: string, message: BusMessage): number {
  const room = rooms.get(session);
  if (!room) return 0;
  for (const listener of room) {
    try {
      listener(message);
    } catch {
      /* 一个订阅者炸了不该连坐另一个。 */
    }
  }
  return room.size;
}

export function subscribe(session: string, listener: Listener): () => void {
  let room = rooms.get(session);
  if (!room) {
    room = new Set();
    rooms.set(session, room);
  }
  room.add(listener);
  return () => {
    room?.delete(listener);
    if (room && room.size === 0) rooms.delete(session);
  };
}

/** 现在有几块屏连着。控制台上要显示这个数 —— 秘书必须看得见「屏幕接上了没有」。 */
export const listenerCount = (session: string): number => rooms.get(session)?.size ?? 0;
