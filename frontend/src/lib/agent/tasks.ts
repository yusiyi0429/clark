/**
 * 进程内异步任务表。
 *
 * 不上消息队列，理由和落盘选 JSON 快照一样：单副本部署、任务量是个位数/天。
 * 真需要多副本时换掉这个文件，接口就这几个函数。
 *
 * 代价说清楚：**进程重启后正在跑的任务会丢**，状态回到 idle。这是对的 ——
 * 一个「跑了一半、没人在跑」的 running 状态比 idle 更糟，它会让前端一直转圈。
 * 重启后重新触发即可，预研本来就是幂等的。
 */
import { readPin, writePin } from "@/lib/dev-pin";
import { bumpRevision } from "@/lib/data/revision";
import type { DraftReport, ResearchStep } from "@/lib/data/types";

export type TaskStatus = "idle" | "queued" | "running" | "done" | "failed";

export type TaskState = {
  status: TaskStatus;
  /**
   * 前面还有几轮。**只在 `queued` 时有值**，而且**在跑的那一轮也算一个** —— 屏幕上那句
   * 「前面还有 1 轮」问的是「还要等几轮」，正在跑的那一轮当然要等。
   *
   * 不给的话，排队和「正在跑但一步都还没上报」在屏幕上长得一模一样 —— 而那两者之间差着
   * 十五分钟。
   */
  queuePosition?: number;
  startedAt?: string;
  finishedAt?: string;
  /** 失败原因。要给运营台看，所以是人能读的一句话，不是堆栈。 */
  error?: string;
  /** 第几次尝试。质量门打回重生成也算在里面。 */
  attempts?: number;
  /**
   * 这一轮此刻在哪一步。**只在 `running` 时有值** —— 结算时下面那两个回调把它抹掉。
   *
   * 为什么挂在任务状态上、不另开一张进度表：那张表要和这张表在同一时刻被清掉，而
   * 同一个生命周期的两张表迟早会漂开一格 —— 屏幕上于是留着一句「正在写正式报告」，
   * 压在一条已经挂了的任务下面。
   *
   * 只有主动上报的链路有值（见 `Harness` 的 `progress` 初始化项）。没上报的链路
   * 留空，屏幕照旧只说「在跑」——**不许拿「第 1 步」当兜底**，那是编的。
   */
  step?: ResearchStep;
  /**
   * 这一轮**已经写完**的那几份报告原件，以及还在写的那一栏（见 `DraftReport`）。
   * 和 `step` 一样只在 `running` 时有值 —— 结算之后报告已经落库，读库那一份。
   *
   * 挂在这张表上而不另开一张：它和 `step` 是同一个生命周期里的同一件事（「这一轮此刻
   * 到哪了」），而同一个生命周期的两张表迟早会漂开一格 —— 那时屏幕上会摆着两份已经写完
   * 的原件，压在一条已经挂了的任务下面。
   */
  reports?: DraftReport[];
};

/**
 * 这张表、它的身份、以及那个旁听席，合成一份**钉在进程上**的东西（见 `lib/dev-pin.ts`）。
 *
 * 三样钉在一起而不是各钉各的：它们是同一个生命周期里的同一件事 —— 表在、身份就该还是
 * 那一个、写完的那几份报告就该还有人接着抄。分开钉的话，重编译之后可以出现「表还在、
 * 旁听席没了」这种组合，而那种组合的样子是：一轮深研照旧在跑，写完的原件一份都没落库。
 */
type TaskHold = {
  tasks: Map<string, TaskState>;
  /** 见下面 `TASK_TABLE_ID`。 */
  id: string;
  /** 见下面 `onTaskReports`。 */
  sink: ((kind: string, id: string, reports: DraftReport[]) => void) | null;
  /**
   * 每条道此刻在飞几个、后面排着谁。见 `runTask` 的 `lane`。
   *
   * 和表钉在一起（不另开一份）：它和任务表是同一个生命周期里的同一件事。分开钉的话，一次
   * 重编译之后可以出现「表是新的、队是旧的」——那时队里那几个的 `kind:id` 在新表里查不到，
   * 起出来就是一轮没人认领的深研。
   */
  lanes: Map<string, LaneState>;
  /**
   * 队里那几条各自「真起跑」的那个闭包。存到轮到它的那一刻才叫。
   *
   * **必须和队钉在同一份上。** 分开的话，一次重编译会留下「队还在、闭包没了」这种组合：
   * `pumpLane` 轮到那一条时找不到人起，于是它被静默丢掉，而表上它永远写着「排队中」——
   * 屏幕转一整天，没有任何一处会报错。
   */
  starters: Map<string, () => void>;
};

/** 一条道。`running` 数的是**真的在跑**的那几个，不是队里排着的。 */
type LaneState = { running: number; queue: string[] };

const hold: TaskHold =
  readPin<TaskHold>("tasks") ??
  writePin("tasks", {
    tasks: new Map<string, TaskState>(),
    /*
     * 取的是进程号加这一份被造出来的时刻（微秒）：同一个进程里两份表不可能在同一微秒里
     * 造出来，而跨进程有进程号分开。不用随机数，是为了让它在日志里读得出「哪一份、什么
     * 时候」。
     */
    id: `${process.pid}.${Math.round(performance.now() * 1000).toString(36)}`,
    sink: null,
    lanes: new Map<string, LaneState>(),
    starters: new Map<string, () => void>(),
  });

const tasks = hold.tasks;

/**
 * **这一份任务表的身份。** 每造一份新表就换一个值。
 *
 * 为什么需要一个身份：这张表在进程里（见文件头），而「在进程里」这句话在 `next dev` 下
 * 比听起来弱得多 —— 改一个服务端文件就重编译，而重编译**不保证**整张模块图一起换新：
 * 库那一份（`store.ts`）可能活着、这张表已经是新的一份了。那时库里那条「这一轮在跑」的
 * 记录还没有收场原话（跑它的那一份表还在跑，只是不是这一份），而这一份表里查不到它 ——
 * 于是 `ensureDeepResearch` 眼里是「没人跑过，起一轮吧」，又开一轮真花钱的深研。
 * 每次重编译都再来一次，就是 2026-08-27 一号位撞到的那个无限循环（ISS-112）。
 *
 * 所以库里那条记录要**盖上开跑时这张表的身份**（`UnfinishedResearchRound.runner`）：
 * 身份对不上就说明跑它的那张表不是这一份，那一轮的下场这一份答不出来 —— 唯一安全的
 * 答案是「不许自动重开」（见 `deepRoundState`）。
 *
 * **开发期这张表现在是钉住的**（`hold`），所以那种组合不再出现，这个身份也就不再每次
 * 重编译换一次。它没有因此变得多余：真的重启一次进程，它照旧是新的一份，而库里那些
 * 盖着上一程身份的记录照旧要被认出来。上面那几段讲的是这道闩为什么存在 —— 闩留着，
 * 只是不再天天被撞响。
 */
export const TASK_TABLE_ID = hold.id;

const key = (kind: string, id: string) => `${kind}:${id}`;

export const taskState = (kind: string, id: string): TaskState =>
  tasks.get(key(kind, id)) ?? { status: "idle" };

/**
 * 这条道的默认上限。不给 `concurrency` 时用它 —— 一条道存在的默认理由就是「一次只跑一个」。
 */
const LANE_DEFAULT = 1;

const laneOf = (name: string): LaneState => {
  let l = hold.lanes.get(name);
  if (!l) {
    l = { running: 0, queue: [] };
    hold.lanes.set(name, l);
  }
  return l;
};

/**
 * 队里那几条各自的号次刷一遍。**每次进出队都要刷**，否则屏幕上那句「前面还有 N 轮」会
 * 停在入队那一刻的数上 —— 前面那一轮跑完了，它还写着「前面还有 1 轮」。
 */
function renumber(lane: LaneState): void {
  lane.queue.forEach((k, i) => {
    const st = tasks.get(k);
    // 在飞的那几轮也要等，所以从 `running` 数起，不从 0 数起。
    if (st?.status === "queued") tasks.set(k, { ...st, queuePosition: lane.running + i });
  });
}

/**
 * 这条道上有位子就起下一个。前一个**结束**（done / failed 都算）时叫一次。
 *
 * failed 也放行是这里唯一一处需要写下来的判断：一轮深研挂掉之后队里那几条照旧要跑 ——
 * 卡住的话，屏幕上剩下的每一条都会一直写着「排队中」，而前面那一轮早就没了，谁也不会来
 * 推它一把。
 */
function pumpLane(name: string): void {
  const lane = laneOf(name);
  while (lane.queue.length && lane.running < laneLimit(name)) {
    const k = lane.queue.shift();
    if (!k) break;
    const start = hold.starters.get(k);
    hold.starters.delete(k);
    if (!start) continue;
    lane.running += 1;
    start();
  }
  renumber(lane);
}

/**
 * 这条道此刻的上限。**在取用时读**，改了不用重启（同 `models/gate.ts` 那几个限额）。
 *
 * 只有深研排队（`TKOS_DEEP_CONCURRENCY`，默认 1）。别的都不排：预研、A5、对谈要么几十秒，
 * 要么就是他此刻正在等的那一句话 —— 把那些排在一轮十五分钟的深研后面，屏幕上会出现一个
 * 「在想」但十五分钟不动的对话框。
 */
function laneLimit(name: string): number {
  const raw = name === "deep" ? (process.env.TKOS_DEEP_CONCURRENCY ?? "").trim() : "";
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : LANE_DEFAULT;
}

/**
 * 触发一次任务。**同一个 key 正在跑（或者正排着队）就直接返回，不重复起。**
 *
 * 不重复起是有意的：前端会轮询，轮询触发重复调用是常态。少判 `queued` 那一档的表现是
 * 一次误触变成十次真实的模型调用 —— 排队那一档尤其危险，因为它在表上不是 `running`。
 *
 * ## `lane`：同一条道上一次只跑几个
 *
 * 不给 `lane` = 不排队，和从前一模一样。给了的话，这条道上在飞的数到了上限，新来的进队列
 * （状态 `queued`，屏幕上写「排队中 · 前面还有 N 轮」），前一个结束时按先来后到起下一个。
 *
 * 为什么深研要排：两轮并跑实测把取证从 5 分 43 秒拖到 13 分钟（ISS-235 vs 236/237）——
 * 两轮共用同一批出口，抢的是同一份限额。排起来之后总时长几乎不变，而屏幕上能说出「前面
 * 还有几轮、大概什么时候轮到」，比两个都在转圈但都变慢好读得多。
 *
 * 这一层管的是**轮次**，`models/gate.ts` 管的是**单次调用**。两层都要：只有队列的话，一轮
 * 之内四条取证链照旧会把出口打满；只有限速器的话，两轮并跑各自都在门口排长队，屏幕上两个
 * 都写着「正在取证」而谁也不动。
 */
export function runTask(
  kind: string,
  id: string,
  fn: () => Promise<{ attempts?: number }>,
  opts: { lane?: string } = {}
): TaskState {
  const k = key(kind, id);
  const cur = tasks.get(k);
  if (cur?.status === "running" || cur?.status === "queued") return cur;

  /*
   * 真起这一轮。摆成一个闭包是因为它有两个起点：此刻就有位子（下面那一句），或者前面
   * 那一轮结束之后由 `pumpLane` 叫（那时才写 `startedAt` —— 排队那一段不算「跑了多久」，
   * 算进去的话屏幕上会写出「已 15 分钟」而它一步都还没走）。
   */
  const begin = () => {
    const state: TaskState = { status: "running", startedAt: new Date().toISOString() };
    tasks.set(k, state);
    // 「起了一轮」本身就是屏幕上的一句话（「正在深研」），所以起的时候也报一声。
    bumpRevision();

    // 故意不 await —— 调用方要立刻拿到 running 然后去轮询。
    //
    // 两个回调都**重建**整个 TaskState 而不是改 running 那个对象，所以 `step` 在这里
    // 自然消失 —— 这正是要的：结算之后那一步已经过去了，把它留在屏幕上等于说「还在
    // 写正式报告」，而报告早就写完（或者那一轮已经挂了）。
    void fn()
      .then((r) => {
        tasks.set(k, {
          status: "done",
          startedAt: state.startedAt,
          finishedAt: new Date().toISOString(),
          attempts: r?.attempts,
        });
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[tkos:task] ${k} 失败：`, msg);
        tasks.set(k, {
          status: "failed",
          startedAt: state.startedAt,
          finishedAt: new Date().toISOString(),
          error: msg,
        });
      })
      /*
       * 落完状态再报一声「库改过了」，成败都报。
       *
       * 任务表在 store 之外，所以状态翻面这件事**不经过 `persistSoon()`** —— 光靠那一处
       * 的通知，一轮跑挂了的深研在屏幕上会一直写着「正在深研」，因为失败没写任何库。
       * 这一下补的就是那种情况。
       *
       * 摆在 `.then`/`.catch` 之后而不是各写一遍：`bumpRevision` 自己会合并同一小段
       * 时间里的多次调用，而任务体里最后那一次 `persistSoon()` 就在几微秒之前 ——
       * 两者合成一帧推出去，屏幕只重问一轮。
       */
      .finally(() => {
        /*
         * 位子还给这条道，再起下一个。**摆在 `bumpRevision` 之前**：出队会把下一条从
         * `queued` 翻成 `running`，那也是屏幕上的一件事，两件事合成一帧推出去。
         */
        if (opts.lane) {
          const lane = laneOf(opts.lane);
          lane.running = Math.max(0, lane.running - 1);
          pumpLane(opts.lane);
        }
        bumpRevision();
      });
  };

  if (!opts.lane) {
    begin();
    return taskState(kind, id);
  }

  const lane = laneOf(opts.lane);
  if (lane.running < laneLimit(opts.lane)) {
    lane.running += 1;
    begin();
    return taskState(kind, id);
  }

  /*
   * 排上。**入队也报一声 `bumpRevision`**：屏幕上多了一句「排队中」，不报的话它要等下一次
   * 轮询（五秒）才出现，而他此刻刚按下去正盯着。
   */
  hold.starters.set(k, begin);
  lane.queue.push(k);
  const state: TaskState = {
    status: "queued",
    queuePosition: lane.running + lane.queue.length - 1,
  };
  tasks.set(k, state);
  bumpRevision();
  return state;
}

/**
 * 上报「这一轮走到第几步了」。**只写正在跑的那一条。**
 *
 * 不排除已结算的那一条是不行的：一次慢的收尾（`.then` 已经跑过，链路里还有一句
 * `h.step()` 没走完）会把一个 done 的任务改回带步骤的样子，而屏幕按「有 step」
 * 判它在跑。所以这里判 `running`，不判「存在」。
 *
 * 由 `Harness.step()` / `substep()` 调，链路自己不直接碰这个函数 —— 步骤名和序号
 * 要跟模型调用在同一处发生，隔开就会漂（序号加了、调用没发出去）。
 */
export function taskStep(kind: string, id: string, step: ResearchStep): void {
  const k = key(kind, id);
  const cur = tasks.get(k);
  if (cur?.status !== "running") return;
  tasks.set(k, { ...cur, step });
}

/**
 * 「这几栏又换了个样子」的旁听席。**给要落盘的那一侧用。**
 *
 * 这张表在进程里（见文件头），所以上面那几份原件跟着进程走 —— 而它们是真花过钱的东西：
 * 一条链路跑十几分钟写出一份报告，`next dev` 改一个服务端文件就重编译一次，这张表随之
 * 清空（2026-08-26 的 ISS-110 就这么丢了一份）。所以要有人在它变的那一刻把它抄进库。
 *
 * 用回调而不是让这张表自己 `import` 数据层：这个文件被数据层 import，反过来再 import
 * 回去就成了环，而这张表不该认识库。只留**一个**旁听席（后来的盖掉前面的）—— 要两个的
 * 时候再说，多留一个位置等于现在就替一个还不存在的需求排好了顺序。
 */
type ReportsSink = (kind: string, id: string, reports: DraftReport[]) => void;

export function onTaskReports(fn: ReportsSink): void {
  hold.sink = fn;
}

/**
 * 上报「这几条链路此刻各是什么样子」。**只写正在跑的那一条**，理由同 `taskStep`。
 *
 * 每次给的是**整份清单**，不是往上追加：同一轮里这份清单一直在变（三条链路各走一步就换一
 * 次样子 —— 排队、走到第几步、写完换成正文、或者挂了），而增量接口没法表达「那一栏不再是
 * 占位了」，更没法表达「那一栏退回成一句失败原话」。
 *
 * 和 `taskStep` 不一样的是这里报一声 `bumpRevision`：页签行上多一栏、或者某一栏从占位变成
 * 能读的正文，是屏幕上的一件事；而步骤那行小字有各屏自己的轮询兜着。不报的话，那几栏要等
 * 下一次轮询（五秒）才动，而他此刻正盯着那一排页签在等哪一条先出来。
 */
export function taskReports(kind: string, id: string, reports: DraftReport[]): void {
  const k = key(kind, id);
  const cur = tasks.get(k);
  if (cur?.status !== "running") return;
  tasks.set(k, { ...cur, reports });
  hold.sink?.(kind, id, reports);
  bumpRevision();
}

/**
 * 把一个任务的状态抹掉，让它能被重新起一轮。**正在跑的不动**（返回 false）——
 * 抹掉一个 running 会让同一件事同时跑两轮，两轮都往同一个地方写。
 *
 * 存在的理由：`failed` 是**故意**不自动重开的（重试烧钱，而且会把失败藏起来），
 * 于是「他明确要求再来一次」这个动作必须有地方把那道闩打开 —— 否则屏幕上写着
 * 「打回重研」，按下去什么也不会发生（`store.ts` 的 `startDeepResearch`）。
 */
export function clearTask(kind: string, id: string): boolean {
  const k = key(kind, id);
  const st = tasks.get(k)?.status;
  // 排着队的那一条同样不能抹：抹掉之后它照旧会被 `pumpLane` 起出来，而表上已经没有它了 ——
  // 于是屏幕上是「还没开始」，后台正在跑一轮真花钱的深研。
  if (st === "running" || st === "queued") return false;
  return tasks.delete(k);
}

/** 运营台用：现在有哪些任务在跑 / 失败了。 */
export const allTasks = (): Record<string, TaskState> => Object.fromEntries(tasks);
