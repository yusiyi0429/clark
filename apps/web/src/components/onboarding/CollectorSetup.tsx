"use client";

/**
 * 上手流程「安装本机采集器」与「后台扫描」两步（前端交互说明 10a 第 2、3 步）。
 * 安装：生成本人的采集器令牌 → 按系统复制一行命令到终端执行 → 采集器第一次心跳后自动变成「已连接」。
 * 扫描：采集器装好后第一次检查就带上本机清单；这一页轮询采集器状态，用步骤列表显示扫到了哪一步。
 */
import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { browserApi } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { StepList, type Step } from "@/components/steps/StepList";
import { CollectorConsentSwitch } from "./CollectorConsentSwitch";
import f from "./foundation.module.css";
import c from "./setup.module.css";

export type CollectorStatus = components["schemas"]["CollectorStatusResponse"];
export type CollectorOs = "windows" | "macos";

/** 轮询本人的采集器状态：在安装和扫描两步里每 3 秒读一次；离开这两步就停，保留最后一次的结果。 */
export function useCollectorStatus(active: boolean): CollectorStatus | null {
  const [status, setStatus] = useState<CollectorStatus | null>(null);
  useEffect(() => {
    if (!active) return;
    let alive = true;
    let timer: number | undefined;
    const tick = async () => {
      try {
        const { data } = await browserApi.GET("/api/me/collector/status");
        if (alive && data) setStatus(data);
      } catch { /* 网络抖动：下一轮再读 */ }
      if (alive) timer = window.setTimeout(() => void tick(), 3_000);
    };
    void tick();
    return () => { alive = false; window.clearTimeout(timer); };
  }, [active]);
  return status;
}

/** 一行安装命令：从天枢拉安装脚本执行，令牌只在参数里。Windows 用 PowerShell，macOS 用终端里的 sh。 */
export function collectorCommand(os: CollectorOs, origin: string, token: string): string {
  const server = origin.replace(/\/+$/, "");
  return os === "windows"
    ? `& ([scriptblock]::Create((irm '${server}/api/collector/install.ps1'))) -Server '${server}' -Token '${token}'`
    : `curl -fsSL '${server}/api/collector/install.sh' | sh -s -- --server '${server}' --token '${token}'`;
}

const detectOs = (): CollectorOs => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent) ? "macos" : "windows";

export function CollectorInstallPanel({ token, onToken, status }: {
  /** 本次上手里生成的令牌：留在上手流程里，前后翻页不丢、不重复生成。 */
  token: string | null;
  onToken: (token: string) => void;
  status: CollectorStatus | null;
}) {
  const [os, setOs] = useState<CollectorOs>("windows");
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { setOs(detectOs()); }, []);
  const device = status?.devices[0];
  const connected = Boolean(device);
  const command = token ? collectorCommand(os, typeof window === "undefined" ? "" : window.location.origin, token) : "";

  const generate = async () => {
    if (busy) return;
    setBusy(true); setError("");
    try {
      const { data, error: failure } = await browserApi.POST("/api/me/tokens", { body: { name: "本机采集器", client: "collector", expiresInDays: 90 } });
      if (!data) throw new Error(failure?.message ?? "没有生成，请重试");
      onToken(data.token);
    } catch (cause) { setError(cause instanceof Error ? cause.message : "没有生成，请重试"); }
    finally { setBusy(false); }
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(command); setCopied(true); }
    catch { setError("复制失败"); }
  };
  const pickOs = (next: CollectorOs) => { setOs(next); setCopied(false); };

  const tokenDone = Boolean(token) || connected;
  const runDone = connected || (Boolean(token) && copied);
  // 同意开关放在最上面（D-18）：同意之前采集器不盘点本机、不上传会话，先定这一项再装。
  return <div className={`${f.glass} ${c.panel}`}>
    <div className={c.consentTop}><CollectorConsentSwitch /></div>
    <div className={c.panelHead}>
      <div className={c.segmented} role="group" aria-label="系统">
        <button type="button" aria-pressed={os === "windows"} onClick={() => pickOs("windows")}>Windows</button>
        <button type="button" aria-pressed={os === "macos"} onClick={() => pickOs("macos")}>macOS</button>
      </div>
    </div>
    <ol className={c.steps}>
      <li data-state={tokenDone ? "done" : "current"}>
        <span className={c.marker} aria-hidden="true">{tokenDone ? <Check size={14} strokeWidth={3} /> : 1}</span>
        <span className={c.stepLabel}>采集器令牌</span>
        {token ? <span className={c.stepValue}>已生成</span>
          : connected ? <button type="button" className={c.ghost} onClick={() => void generate()} disabled={busy}>再装一台</button>
          : <button type="button" className={c.action} onClick={() => void generate()} disabled={busy}>{busy ? "生成中…" : "生成"}</button>}
      </li>
      <li data-state={runDone ? "done" : token ? "current" : "pending"}>
        <span className={c.marker} aria-hidden="true">{runDone ? <Check size={14} strokeWidth={3} /> : 2}</span>
        <span className={c.stepLabel}>{os === "windows" ? "在 PowerShell 里运行" : "在终端里运行"}</span>
        <span />
        {token ? <div className={c.command}>
          <code>{command}</code>
          <button type="button" className={c.copy} data-copied={copied} onClick={() => void copy()}>
            {copied ? <Check size={13} strokeWidth={3} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}{copied ? "已复制" : "复制"}
          </button>
        </div> : null}
      </li>
      <li data-state={connected ? "done" : token ? "current" : "pending"}>
        <span className={c.marker} aria-hidden="true">{connected ? <Check size={14} strokeWidth={3} /> : 3}</span>
        <span className={c.stepLabel}>连接</span>
        <span className={c.status} data-state={connected ? "on" : token ? "waiting" : "off"} role="status">
          <i aria-hidden="true" />{connected ? `已连接 · ${device!.name}` : "未连接"}
        </span>
      </li>
    </ol>
    {error && !connected ? <p className={c.error} role="alert">{error}</p> : null}
  </div>;
}

export type ScanLists = { basis: number; schedules: number };

/**
 * 扫描页的步骤（第 6 节第 2 条）：没连上采集器时前四步停住，只整理天枢里已有的；
 * 连上后等第一次盘点到达，三类清单一起打勾，再整理成最后一页的两份清单。
 */
export function scanSteps(status: CollectorStatus | null, lists: ScanLists | null, timedOut = false): Step[] {
  const connected = Boolean(status?.devices.length);
  const scanned = Boolean(status?.scannedAt);
  // 没同意采集（D-18）：采集器不盘点本机，这三步直接停在「未同意」。
  const declined = connected && status?.consent === false;
  const stopped = Boolean(status) && (!connected || declined || (!scanned && timedOut));
  const inventory = (id: string, label: string, result: string, index: number): Step => ({
    id, label,
    status: scanned && !declined ? "done" : stopped ? "stopped" : connected && index === 0 ? "active" : "pending",
    ...(scanned && !declined ? { result } : stopped ? { result: !connected ? "未连接" : declined ? "未同意" : "超时" } : {}),
  });
  return [
    { id: "connect", label: "连接采集器", status: connected ? "done" : status ? "stopped" : "active", ...(connected ? { result: status!.devices[0].name } : status ? { result: "未连接" } : {}) },
    inventory("tasks", "本机定时任务", `${status?.inventory.scheduledTasks ?? 0} 项`, 0),
    inventory("docs", "飞书文档", `${status?.inventory.feishuDocs ?? 0} 份`, 1),
    inventory("memory", "记忆文件", `${status?.inventory.memoryFiles ?? 0} 个`, 2),
    { id: "lists", label: "整理清单", status: lists ? "done" : scanned || stopped ? "active" : "pending",
      ...(lists ? { result: `依据 ${lists.basis} · 定时任务 ${lists.schedules}` } : {}) },
  ];
}

export function ScanProgress({ steps }: { steps: Step[] }) {
  return <div className={`${f.glass} ${c.scan}`} data-tone="light"><StepList steps={steps} /></div>;
}
