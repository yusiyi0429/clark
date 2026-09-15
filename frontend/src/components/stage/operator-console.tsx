"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";

import { AGENDA } from "@/lib/demo/agenda";
import type { BusMessage } from "@/lib/stage/bus";
import { LINES } from "@/lib/tts/lines";
import { cn } from "@/lib/utils";

/**
 * 秘书控制台。
 *
 * 这是这场 demo 的兜底方案，不是调试工具。主线压在模型身上，而会议室的网、供应商的额度、
 * 模型的脾气三件事没有一件是我能保证的 —— 所以必须有一条**完全不经过模型**的路，能把该
 * 出现的东西推到屏幕上。
 *
 * 两条设计上的硬规矩：
 *
 * 1. **每个功能都是一个能点的按钮**，热键只是加速器。第二台设备很可能是手机，手机上没有
 *    键盘 —— 一个只有热键的控制台在会议室里等于没有控制台。
 * 2. **每一次推送都要有回执**，写清楚推给了几块屏。推给 0 块屏的那一下必须当场看得见，
 *    否则秘书会以为按下去了，而屏幕上什么都没发生。
 *
 * 热键一律是裸键，不带 ⌘/Ctrl：Chrome 拦不住 ⌘W 和 Ctrl+数字，会上按错一下就是关掉标签页。
 */

/** 证据卡按平铺顺序编号：第 1 件的四张是 1–4，第 2 件的三张接着 5–7，以此类推。 */
const EVIDENCE = AGENDA.items.flatMap((item, at) =>
  item.evidence.map((e) => ({
    id: e.id,
    itemAt: at + 1,
    quote: e.quote,
    source: e.source,
  })),
);

/** `1`…`9` 打前九张，`0` 打第十张。够这一场用了。 */
const KEYS = ["1", "2", "3", "4", "5", "6", "7", "8", "9", "0"];

/**
 * 备好的台词，`Shift` + 数字。
 *
 * 为什么不是裸数字：裸的 1–9 已经是证据卡了，而证据卡是会上按得最多的一组，不能让位。
 * `Shift` + 数字用 `e.code` 判（按住 Shift 的时候 `e.key` 是 `!` 不是 `1`），前九条覆盖
 * 开场、三件口播、收尾，加上最常用的四句过渡语 —— 也就是拔了网线之后走完一场会需要的那些。
 */
const AUDIO_KEYS = LINES.slice(0, 9).map((line, at) => ({ line, code: `Digit${at + 1}` }));

/*
 * 口令存在 `sessionStorage`，不是 `localStorage`：会散场之后那台设备上不该还留着能推屏幕
 * 的东西。
 *
 * 读法照 `lib/mode.ts` 那一套 —— `useSyncExternalStore` 加一个自定义事件，服务端快照是
 * `null`。不能用 `useState(() => sessionStorage…)`：服务端没有 sessionStorage，那样写
 * 首屏渲染出来的是口令门、水合之后变成控制台，中间必然报一次不一致。
 */
const TOKEN_KEY = "clark.operator.token";
const TOKEN_EVENT = "clark:operator-token";

const readToken = (): string | null => {
  if (typeof window === "undefined") return null;
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
};

function writeToken(token: string | null) {
  try {
    if (token === null) sessionStorage.removeItem(TOKEN_KEY);
    else sessionStorage.setItem(TOKEN_KEY, token);
  } catch {
    /* 存不住也能用，只是刷新要再输一次。 */
  }
  window.dispatchEvent(new Event(TOKEN_EVENT));
}

const subscribeToken = (cb: () => void) => {
  window.addEventListener(TOKEN_EVENT, cb);
  return () => window.removeEventListener(TOKEN_EVENT, cb);
};

export function OperatorConsole() {
  const token = useSyncExternalStore(subscribeToken, readToken, () => null);
  const [screens, setScreens] = useState<number | null>(null);
  /** 最后一次推送的回执。一行字，秘书扫一眼就知道刚才那一下有没有到。 */
  const [receipt, setReceipt] = useState<{ text: string; ok: boolean } | null>(null);
  const takeover = useRef<HTMLInputElement>(null);

  /*
   * 屏幕接上了没有。每 4 秒问一次，用 `?probe=1` —— 不订阅，所以控制台自己不会被算成
   * 一块屏。这个数字是秘书按键之前唯一的依据。
   */
  useEffect(() => {
    let live = true;
    const ask = async () => {
      try {
        const res = await fetch("/api/stage?probe=1", { cache: "no-store" });
        const data = (await res.json()) as { screens?: number };
        if (live) setScreens(typeof data.screens === "number" ? data.screens : null);
      } catch {
        if (live) setScreens(null);
      }
    };
    void ask();
    const t = setInterval(ask, 4000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);

  const push = useCallback(
    async (message: BusMessage, label: string) => {
      if (!token) return;
      try {
        const res = await fetch("/api/stage", {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-operator-token": token },
          body: JSON.stringify(message),
        });
        const data = (await res.json().catch(() => null)) as
          | { screens?: number; error?: string }
          | null;

        if (res.status === 401) {
          writeToken(null);
          setReceipt({ text: "口令不对，重新输入。", ok: false });
          return;
        }
        if (!res.ok) {
          setReceipt({ text: data?.error ?? `推不出去（HTTP ${res.status}）`, ok: false });
          return;
        }

        const n = data?.screens ?? 0;
        setScreens(n);
        setReceipt(
          n > 0
            ? { text: `${label} → 已上屏`, ok: true }
            : { text: `${label} → 没有屏幕在听`, ok: false },
        );
      } catch {
        setReceipt({ text: `${label} → 连不上服务`, ok: false });
      }
    },
    [token],
  );

  /* 热键。焦点在输入框里的时候一个都不接 —— 秘书正在替他打字。 */
  useEffect(() => {
    if (!token) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA")) return;

      // Shift + 数字：放一条备好的台词。放在裸数字之前判，两组键不会互相吃掉。
      if (e.shiftKey) {
        const audio = AUDIO_KEYS.find((a) => a.code === e.code);
        if (audio) {
          e.preventDefault();
          void push({ kind: "play", lineId: audio.line.id }, `播 ${audio.line.label}`);
          return;
        }
        /*
         * ⇧X 开麦。关麦是裸 `x`。
         *
         * 两个方向故意不对称：关麦是急事（有人在旁边说话、识别开始乱认），必须一下就到；
         * 开麦不急，而且它本来就不保证成 —— 浏览器要一次真实手势才给麦克风，屏幕那台机器
         * 上没人点过的话，这一下会以「没权限」收场。让它多按一个 Shift，是不想让秘书误触
         * 之后以为麦克风开着。
         */
        if (e.code === "KeyX") {
          e.preventDefault();
          void push({ kind: "mic", on: true }, "开麦");
        }
        return;
      }

      const at = KEYS.indexOf(e.key);
      if (at >= 0 && EVIDENCE[at]) {
        e.preventDefault();
        void push(
          { kind: "event", event: { type: "SHOW_EVIDENCE", evidenceId: EVIDENCE[at].id } },
          `证据 ${EVIDENCE[at].id}`,
        );
        return;
      }

      switch (e.key) {
        case "j":
        case "ArrowRight":
          e.preventDefault();
          void push({ kind: "advance", delta: 1 }, "下一件");
          break;
        case "k":
        case "ArrowLeft":
          e.preventDefault();
          void push({ kind: "advance", delta: -1 }, "上一件");
          break;
        case "e":
          e.preventDefault();
          void push({ kind: "explore" }, "刚问的那句 → 探索卡");
          break;
        case "s":
          e.preventDefault();
          void push({ kind: "stop" }, "停止播报");
          break;
        case "r":
          e.preventDefault();
          void push({ kind: "replay" }, "重播当前段");
          break;
        case "w":
          e.preventDefault();
          void push({ kind: "wake" }, "唤醒声音");
          break;
        case "x":
          e.preventDefault();
          void push({ kind: "mic", on: false }, "关麦");
          break;
        case "a":
          e.preventDefault();
          void push({ kind: "event", event: { type: "SHOW_AGENDA" } }, "议程");
          break;
        case "m":
          e.preventDefault();
          void push({ kind: "event", event: { type: "SHOW_MAP" } }, "目标与产出");
          break;
        case "z":
          e.preventDefault();
          void push({ kind: "event", event: { type: "SHOW_SUMMARY" } }, "收尾");
          break;
        case "/":
        case "t":
          e.preventDefault();
          takeover.current?.focus();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [token, push]);

  if (token === null) return <Gate />;

  return (
    <div className="scroll-slim h-full overflow-y-auto bg-paper px-5 py-6">
      <div className="mx-auto flex w-full max-w-xl flex-col gap-6">
        <header className="flex items-baseline justify-between gap-4">
          <h1 className="text-lg font-medium text-ink">控制台</h1>
          <span className="meta flex items-center gap-2 text-ink-muted">
            <span
              className={cn(
                "size-2 rounded-full",
                screens === null ? "bg-ink-faint" : screens > 0 ? "bg-confirmed" : "bg-counter",
              )}
            />
            {screens === null
              ? "问不到服务"
              : screens > 0
                ? `${screens} 块屏在听`
                : "没有屏幕在听"}
          </span>
        </header>

        {/* 回执常驻一行，不做浮层：会上没人有空去追一个 2 秒后消失的提示。 */}
        <p
          aria-live="polite"
          className={cn(
            "meta min-h-5",
            receipt ? (receipt.ok ? "text-confirmed" : "text-counter") : "text-ink-faint",
          )}
        >
          {receipt?.text}
        </p>

        <Group title="走流程">
          <Key label="上一件" hint="k" onClick={() => push({ kind: "advance", delta: -1 }, "上一件")} />
          <Key label="下一件" hint="j" onClick={() => push({ kind: "advance", delta: 1 }, "下一件")} wide />
        </Group>

        <Group title="兜底">
          <Key
            label="停止播报"
            hint="s"
            tone="warn"
            onClick={() => push({ kind: "stop" }, "停止播报")}
          />
          <Key
            label="刚问的 → 探索卡"
            hint="e"
            onClick={() => push({ kind: "explore" }, "刚问的那句 → 探索卡")}
            wide
          />
        </Group>

        <Group title="声音">
          <Key label="唤醒声音" hint="w" onClick={() => push({ kind: "wake" }, "唤醒声音")} />
          <Key label="重播当前段" hint="r" onClick={() => push({ kind: "replay" }, "重播当前段")} wide />
        </Group>

        {/*
         * 麦克风。
         *
         * 关麦是急事，所以它在左边、是 warn 色、裸键就能到：会议室里第三个人开始说话、空调
         * 忽然转大、识别开始把噪音认成句子 —— 这些都要能在**他不动任何东西**的情况下掐掉，
         * 剩下的用下面接管输入走完。让他自己去点屏幕上那个按钮，等于当着客户承认这套不好用。
         *
         * 开麦不保证成：浏览器要一次真实手势才给麦克风权限。第一次还是得在屏幕那台机器上
         * 点一下语音条右边那个图标，之后这里才收得回来。
         */}
        <Group title="麦克风">
          <Key
            label="关麦"
            hint="x"
            tone="warn"
            onClick={() => push({ kind: "mic", on: false }, "关麦")}
          />
          <Key label="开麦" hint="⇧X" onClick={() => push({ kind: "mic", on: true }, "开麦")} wide />
        </Group>

        <Group title="整屏">
          <Key label="议程" hint="a" onClick={() => push({ kind: "event", event: { type: "SHOW_AGENDA" } }, "议程")} />
          <Key label="目标与产出" hint="m" onClick={() => push({ kind: "event", event: { type: "SHOW_MAP" } }, "目标与产出")} />
          <Key label="收尾" hint="z" onClick={() => push({ kind: "event", event: { type: "SHOW_SUMMARY" } }, "收尾")} />
        </Group>

        {/*
         * 备好的证据卡。
         *
         * 引文原文写在按钮上，不只写编号 —— 秘书是听着他讲话按键的，她需要认的是「他正在
         * 说的那句话」，而不是记住 e6 是哪一张。
         */}
        <section>
          <h2 className="meta mb-2 text-ink-faint">备好的证据 · {EVIDENCE.length} 张</h2>
          <ul className="flex flex-col gap-1.5">
            {EVIDENCE.map((e, at) => (
              <li key={e.id}>
                <button
                  type="button"
                  onClick={() =>
                    push(
                      { kind: "event", event: { type: "SHOW_EVIDENCE", evidenceId: e.id } },
                      `证据 ${e.id}`,
                    )
                  }
                  className="flex w-full items-baseline gap-3 rounded-lg border border-hairline bg-surface px-3 py-2.5 text-left transition-colors duration-fast ease-swift hover:border-hairline-strong hover:bg-neutral-wash"
                >
                  <span className="meta w-6 shrink-0 text-center text-ink-faint">
                    {KEYS[at] ?? "·"}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-sm text-ink">{e.quote}</span>
                    <span className="meta block truncate text-ink-faint">
                      第 {e.itemAt} 件 · {e.source}
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        {/*
         * 备好的台词。
         *
         * 这一组是**拔了网线也能走完一场会**的那条路：每一条都是磁盘上的一个音频文件，按下去
         * 一步都不经过模型和厂商。所以它排在接管输入之前 —— 主线全灭的时候，秘书是照着这个
         * 列表往下按的。
         */}
        <Canned token={token} onPlay={(id, label) => push({ kind: "play", lineId: id }, `播 ${label}`)} />

        {/*
         * 接管输入。
         *
         * 这一格推上去的话，屏幕会当成**他说的**塞进 Agent 那一轮 —— 语音识别一挂，秘书
         * 在这里替他打一句，会就能接着往下开。它是最后一道兜底，所以它不依赖任何别的东西
         * 能不能用。
         */}
        <Takeover inputRef={takeover} onSend={(text) => push({ kind: "say", text }, "接管输入")} />

        <p className="meta text-ink-faint">
          热键：j 下一件 · k 上一件 · 1–9/0 证据 · ⇧1–9 台词 · e 探索卡 · s 停 · r 重播 · w 唤醒声音 ·
          x 关麦 · ⇧X 开麦 · a 议程 · m 图谱 · z 收尾 · / 输入
        </p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * 口令那一道门。
 *
 * 很浅：环境变量里一个 token，控制台带在请求头上。它挡的是「同一个网段里有人误开了
 * 这一页」，不是攻击者：这条路由只在会议室这台机器上活着。
 */
function Gate() {
  const [text, setText] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    writeToken(t);
  };

  return (
    <div className="flex h-full items-center justify-center bg-paper px-6">
      <form onSubmit={submit} className="flex w-full max-w-xs flex-col gap-3">
        <label className="meta text-ink-faint" htmlFor="op-token">
          控制台口令
        </label>
        <input
          id="op-token"
          type="password"
          autoFocus
          value={text}
          onChange={(e) => setText(e.target.value)}
          className="rounded-lg border border-hairline bg-surface px-3 py-2.5 text-base text-ink outline-none focus:border-hairline-strong"
        />
        <button
          type="submit"
          className="rounded-lg bg-solid px-3 py-2.5 text-base text-solid-fg transition-opacity duration-fast hover:opacity-90"
        >
          进去
        </button>
        <p className="meta text-ink-faint">和服务端 OPERATOR_TOKEN 一致。</p>
      </form>
    </div>
  );
}

function Group({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="meta mb-2 text-ink-faint">{title}</h2>
      <div className="flex gap-2">{children}</div>
    </section>
  );
}

/**
 * 一个键。
 *
 * `py-4` 是给手指定的，不是给鼠标定的 —— 秘书在昏暗的会议室里用手机按这些键，一个
 * 32px 高的按钮会按错到旁边那一个。
 */
function Key({
  label,
  hint,
  onClick,
  wide,
  tone,
}: {
  label: string;
  hint: string;
  onClick: () => void;
  wide?: boolean;
  tone?: "warn";
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center justify-center gap-2 rounded-lg border px-4 py-4 text-base transition-colors duration-fast ease-swift",
        wide ? "flex-[2]" : "flex-1",
        tone === "warn"
          ? "border-counter/40 bg-counter-wash text-counter hover:border-counter"
          : "border-hairline bg-surface text-ink hover:border-hairline-strong hover:bg-neutral-wash",
      )}
    >
      {label}
      <span className="meta text-ink-faint">{hint}</span>
    </button>
  );
}

/**
 * 问一次「哪几条已经合好了」。
 *
 * 只回数据，不碰 state —— 挂载时那一次要判组件还在不在（`live`），按完「全部重合」那一次
 * 不需要判。把 setState 留给这两个调用点各自决定，比塞一个 `refresh` 回调进 effect 干净。
 */
interface Readiness {
  ready: string[];
  stale: boolean;
  /** 现合成那条路通不通（服务端配了 key 没有）。 */
  why: string | null;
}

async function askReady(token: string): Promise<Readiness> {
  try {
    const res = await fetch("/api/tts/pregen", {
      cache: "no-store",
      headers: { "x-operator-token": token },
    });
    if (!res.ok) return { ready: [], stale: false, why: null };
    const data = (await res.json()) as {
      ready?: string[];
      stale?: boolean;
      configured?: boolean;
      why?: string | null;
    };
    return {
      ready: Array.isArray(data.ready) ? data.ready : [],
      stale: Boolean(data.stale),
      why: data.configured === false ? (data.why ?? "现合成用不了。") : null,
    };
  } catch {
    return { ready: [], stale: false, why: null };
  }
}

/**
 * 备好的台词那一组。
 *
 * 这里有两件事：**放**和**合**。
 *
 * 放是会上用的：按一下，屏幕那边从 `demo/audio/` 里取文件出声，一步不经过网络之外的任何服务。
 * 合是会前用的：那个按钮跑一次批量合成。它做在控制台上而不是只有命令行，是因为会前十一点
 * 改了一句口播之后，最需要的是「在手边按一下就重合完」——那时候没人想再开一个终端。
 */
function Canned({
  token,
  onPlay,
}: {
  token: string;
  onPlay: (id: string, label: string) => void;
}) {
  const [ready, setReady] = useState<string[] | null>(null);
  const [stale, setStale] = useState(false);
  const [why, setWhy] = useState<string | null>(null);
  const [job, setJob] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    const ask = async () => {
      const r = await askReady(token);
      if (live) {
        setReady(r.ready);
        setStale(r.stale);
        setWhy(r.why);
      }
    };
    void ask();
    return () => {
      live = false;
    };
  }, [token]);

  const pregen = async () => {
    setJob("正在合成……这一步要走一趟厂商，十几条大约一分钟。");
    try {
      const res = await fetch("/api/tts/pregen", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-operator-token": token },
        body: JSON.stringify({ mode: "lines" }),
      });
      const data = (await res.json().catch(() => null)) as
        | { ok?: number; failed?: number; error?: string; results?: { id: string; error?: string }[] }
        | null;
      if (!res.ok) {
        setJob(data?.error ?? `合成没跑起来（HTTP ${res.status}）。`);
        return;
      }
      // 失败的那几条要把厂商原话写出来 —— 音色 id 打错是最常见的一种，错误信息里就写着。
      const first = data?.results?.find((r) => r.error);
      setJob(
        `合成完成：成功 ${data?.ok ?? 0} 条，失败 ${data?.failed ?? 0} 条。` +
          (first ? `第一条失败：${first.id} —— ${first.error}` : ""),
      );
      const r = await askReady(token);
      setReady(r.ready);
      setStale(r.stale);
      setWhy(r.why);
    } catch {
      setJob("合成连不上服务。");
    }
  };

  const have = (id: string) => ready?.includes(id) ?? false;

  return (
    <section>
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="meta text-ink-faint">
          备好的台词 ·{" "}
          {ready === null
            ? "查询中"
            : `已预合成 ${LINES.filter((l) => have(l.id)).length}/${LINES.length}`}
          {stale && " · 音色和配置不一致"}
        </h2>
        <button
          type="button"
          onClick={() => void pregen()}
          className="meta rounded-md border border-hairline px-2.5 py-1 text-ink-muted transition-colors duration-fast ease-swift hover:border-hairline-strong hover:text-ink"
        >
          全部重合
        </button>
      </div>

      {/*
       * 现合成用不了的时候，这一行是唯一的告知。
       *
       * 它写成 counter 色而不是一句灰字：这时候整场会的声音只能靠下面这张表里「已备好」的
       * 那几条，秘书必须在会前就知道这件事，而不是在会上按了第一个键之后才发现。
       */}
      {why && <p className="meta mb-2 text-counter">{why} 现在只有「已备好」的那几条能出声。</p>}

      {job && <p className="meta mb-2 text-ink-muted">{job}</p>}

      <ul className="flex flex-col gap-1.5">
        {LINES.map((line, at) => (
          <li key={line.id}>
            <button
              type="button"
              onClick={() => onPlay(line.id, line.label)}
              className="flex w-full items-baseline gap-3 rounded-lg border border-hairline bg-surface px-3 py-2.5 text-left transition-colors duration-fast ease-swift hover:border-hairline-strong hover:bg-neutral-wash"
            >
              <span className="meta w-8 shrink-0 text-center text-ink-faint">
                {at < 9 ? `⇧${at + 1}` : "·"}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm text-ink">{line.label}</span>
                <span className="meta block truncate text-ink-faint">
                  {/* 没有文件也能按 —— 只是会现合成，慢一点。这一行让秘书知道快慢。 */}
                  {have(line.id) ? "已备好" : "现合成"}
                  {/* 过渡语的按钮上写的就是那句话本身，副行不用再重复一遍。 */}
                  {line.label === line.text ? "" : ` · ${line.text}`}
                </span>
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function Takeover({
  inputRef,
  onSend,
}: {
  inputRef: React.RefObject<HTMLInputElement | null>;
  onSend: (text: string) => void;
}) {
  const [text, setText] = useState("");

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const said = text.trim();
    if (!said) return;
    setText("");
    onSend(said);
  };

  return (
    <form onSubmit={submit} className="flex flex-col gap-2">
      <label className="meta text-ink-faint" htmlFor="op-say">
        接管输入
      </label>
      <div className="flex gap-2">
        <input
          id="op-say"
          ref={inputRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") e.currentTarget.blur();
          }}
          placeholder="替他说一句"
          className="min-w-0 flex-1 rounded-lg border border-hairline bg-surface px-3 py-3 text-base text-ink outline-none placeholder:text-ink-faint focus:border-hairline-strong"
        />
        <button
          type="submit"
          disabled={!text.trim()}
          className="rounded-lg bg-solid px-5 text-base text-solid-fg transition-opacity duration-fast hover:opacity-90 disabled:bg-neutral-wash disabled:text-ink-faint"
        >
          发
        </button>
      </div>
    </form>
  );
}
