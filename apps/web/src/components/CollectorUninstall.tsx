"use client";

/**
 * 设置 › 卸载本机采集器（spec 5.1：本机采集器整体下线，天枢不再在本机收东西）。只给装过的人看（采集器状态里有设备）：
 * 按系统复制一行命令到终端，停掉定时任务，删掉脚本、令牌、配置和水位线。命令不从天枢下载任何东西。
 */
import { useEffect, useState } from "react";
import { Check, Copy } from "lucide-react";
import { browserApi } from "@/lib/api/client";
import f from "@/components/onboarding/foundation.module.css";
import c from "@/components/onboarding/setup.module.css";

type Os = "windows" | "macos";

const COMMANDS: Record<Os, string> = {
  windows: `Unregister-ScheduledTask -TaskName TkosCollector -Confirm:$false -ErrorAction SilentlyContinue; Remove-Item -Recurse -Force -ErrorAction SilentlyContinue "$env:USERPROFILE\\.tkos-world\\collector", "$env:USERPROFILE\\.tkos-world\\collector.token", "$env:USERPROFILE\\.tkos-world\\collector.json", "$env:USERPROFILE\\.tkos-world\\daily-state.json"`,
  macos: `launchctl bootout "gui/$(id -u)/com.tokenkingos.tkos-collector" 2>/dev/null; rm -rf ~/.tkos-world/collector ~/Library/LaunchAgents/com.tokenkingos.tkos-collector.plist ~/.tkos-world/collector.token ~/.tkos-world/collector.json ~/.tkos-world/daily-state.json ~/.tkos-world/logs/collector.log`,
};

/** 本人装过采集器没有：读一次采集器状态，有设备就是装过；读不到当没装过。 */
export function useCollectorInstalled(): boolean {
  const [installed, setInstalled] = useState(false);
  useEffect(() => {
    let alive = true;
    void browserApi.GET("/api/me/collector/status").then(({ data }) => { if (alive) setInstalled(Boolean(data?.devices.length)); }).catch(() => undefined);
    return () => { alive = false; };
  }, []);
  return installed;
}

export function CollectorUninstallPanel() {
  const [os, setOs] = useState<Os>("windows");
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => { if (/Mac|iPhone|iPad/.test(navigator.userAgent)) setOs("macos"); }, []);
  const pick = (next: Os) => { setOs(next); setCopied(false); };
  const copy = async () => {
    try { await navigator.clipboard.writeText(COMMANDS[os]); setCopied(true); setError(""); }
    catch { setError("复制失败"); }
  };
  return <div className={`${f.glass} ${c.panel}`}>
    <div className={c.panelHead}>
      <div className={c.segmented} role="group" aria-label="系统">
        <button type="button" aria-pressed={os === "windows"} onClick={() => pick("windows")}>Windows</button>
        <button type="button" aria-pressed={os === "macos"} onClick={() => pick("macos")}>macOS</button>
      </div>
    </div>
    <ol className={c.steps}>
      <li data-state="current">
        <span className={c.marker} aria-hidden="true">1</span>
        <span className={c.stepLabel}>{os === "windows" ? "在 PowerShell 里运行" : "在终端里运行"}</span>
        <span />
        <div className={c.command}>
          <code>{COMMANDS[os]}</code>
          <button type="button" className={c.copy} data-copied={copied} onClick={() => void copy()}>
            {copied ? <Check size={13} strokeWidth={3} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}{copied ? "已复制" : "复制"}
          </button>
        </div>
      </li>
    </ol>
    {error ? <p className={c.error} role="alert">{error}</p> : null}
  </div>;
}
