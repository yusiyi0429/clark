"use client";

/**
 * 插件页（/me/plugins，第 11.1、11.3 节）：本机程序（连上没有、版本、Claude Code 登录没有）、能用的模型、允许的文件夹、
 * 「带上个人配置」「验收过就合回」开关、本机设备列表和吊销。连本机的三种浏览器授权结果各有样子：等授权、拒过（指到站点设置）、连上。
 * 没装本机程序时给安装命令和「复制」，不写为什么要装。手机上是「我」：个人菜单在最上面，本机只能看。
 */
import { useEffect, useState } from "react";
import Link from "next/link";
import { Check, ChevronRight, Copy, FolderPlus, UsersRound, X } from "lucide-react";
import type { TLocalDeviceView } from "@warmap/contracts";
import { AccountMenu, type Account } from "@/components/AccountMenu";
import { HeroButton } from "@/components/HeroButton";
import { Switch } from "@/components/ui/Switch";
import { useHandheld } from "@/components/ui/useHandheld";
import { useLocalRunner } from "@/lib/local/LocalRunnerProvider";
import { linkCloud, linkPerson, type LinkPerson } from "@/lib/local/link";
import { needsRelink } from "@/lib/local/connection";
import { listDevices, revokeDevice } from "@/lib/board/cloud";
import { showWorkspaceToast } from "@/lib/toast";
import s from "@/styles/v2-local.module.css";

const downloadBase = () => process.env.NEXT_PUBLIC_LOCAL_DOWNLOAD_BASE ?? `${typeof window === "undefined" ? "" : window.location.origin}/downloads/local`;
export const installCommand = (mac: boolean) => (mac ? `curl -fsSL ${downloadBase()}/install.sh | sh` : `irm ${downloadBase()}/install.ps1 | iex`);
const ago = (iso: string | null) => {
  if (!iso) return "没同步过";
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  return minutes < 1 ? "刚刚同步" : minutes < 60 ? `${minutes} 分钟前同步` : minutes < 1440 ? `${Math.round(minutes / 60)} 小时前同步` : `${Math.round(minutes / 1440)} 天前同步`;
};

export function PluginsPage({ account }: { account: Account }) {
  const handheld = useHandheld();
  return (
    <div className={s.page} data-testid="plugins-page">
      <div className={s.wrap}>
        {handheld ? <div className={s.meHead}><h1>我</h1><AccountMenu account={account} /></div> : <h1 className={s.pageTitle}>连接</h1>}
        {handheld ? <Link href="/me/team" className={s.row}><UsersRound size={16} aria-hidden /><b>技能</b><span className={s.grow} /><ChevronRight size={16} aria-hidden /></Link> : null}
        <LocalSection person={linkPerson(account)} handheld={handheld} />
        <DevicesSection person={linkPerson(account)} />
      </div>
    </div>
  );
}

export function LocalSection({ person, handheld }: { person: LinkPerson; handheld: boolean }) {
  const local = useLocalRunner();
  const [linking, setLinking] = useState(false);
  const status = local.status;
  const agent = status?.agents.find((entry) => entry.kind === "claude-code") ?? null;
  const ready = local.phase === "ready";
  // 配对好、还没关联云端的自动关联由 LocalRunnerProvider 一处管；这里只留没关联上、或老关联没记下是谁时的「关联」按钮。

  return (
    <section className={s.section} aria-label="本机程序">
      <p className={s.lab}>本机</p>
      <div className={s.card} data-phase={local.phase}>
        <span className={s.icon} aria-hidden>&gt;_</span>
        <div className={s.cardBody}>
          <b>天枢本机程序</b>
          <PhaseLine handheld={handheld} />
          {ready && status ? (
            <dl className={s.facts}>
              <div><dt>版本</dt><dd>{status.version}</dd></div>
              <div><dt>Claude Code</dt><dd>{agent?.installed ? `${agent.version ?? ""} · ${agent.loggedIn ? `已登录${agent.subscriptionType ? `（${agent.subscriptionType}）` : ""}` : "没登录"}` : "没装"}</dd></div>
              <div><dt>云端</dt><dd>{status.cloud.linked ? `已关联 · 待发 ${status.cloud.outbox.pending} 条` : linking ? "正在关联…" : "没关联"}</dd></div>
            </dl>
          ) : null}
        </div>
        <div className={s.cardSide}>
          {ready ? <span className={s.state} data-tone="done">已连接</span> : null}
          {ready && agent?.installed && !agent.loggedIn && !handheld ? <HeroButton variant="secondary" size="sm" onPress={() => void local.runner.login().then(() => local.refresh())}>登录 Claude</HeroButton> : null}
          {ready && status && (!status.cloud.linked || needsRelink(status)) && !linking && !handheld ? <HeroButton variant="secondary" size="sm" onPress={() => { setLinking(true); void linkCloud(local.runner, status, person).then(() => local.refresh()).catch((error) => showWorkspaceToast({ text: error instanceof Error ? error.message : "没关联上" })).finally(() => setLinking(false)); }}>关联</HeroButton> : null}
        </div>
      </div>
      {ready && !handheld ? <ModelsAndFolders /> : null}
      {ready && !handheld ? (
        <Switch className={s.toggle} checked={status?.settings.includePersonalConfigByDefault ?? false} onChange={(value) => void local.setIncludePersonal(value)}>
          <span>带上个人配置</span>
        </Switch>
      ) : null}
      {ready && !handheld && status ? (
        <Switch className={s.toggle} checked={status.settings.autoMerge}
          onChange={(value) => void local.runner.patchSettings({ autoMerge: value }).then(() => local.refresh()).catch(() => showWorkspaceToast({ text: "没改成，请重试" }))}>
          <span>验收过就合回</span>
        </Switch>
      ) : null}
      {ready && !handheld && status ? (
        <label className={s.toggle}>
          <span>同时跑</span>
          <select className={s.select} value={status.settings.maxConcurrent} aria-label="同时跑几个"
            onChange={(event) => void local.runner.patchSettings({ maxConcurrent: Number(event.target.value) }).then(() => local.refresh()).catch(() => showWorkspaceToast({ text: "没改成，请重试" }))}>
            {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => <option key={n} value={n}>{n} 个</option>)}
          </select>
        </label>
      ) : null}
      {ready && !handheld ? <div className={s.footActions}><HeroButton variant="ghost" size="sm" onPress={() => void local.unpair()}>取消配对</HeroButton></div> : null}
    </section>
  );
}

/** 连本机走到哪：等授权、拒过（指到站点设置）、没装或没开（安装命令）、没配对（配对和确认码）、连上（版本）。 */
export function PhaseLine({ handheld }: { handheld: boolean }) {
  const local = useLocalRunner();
  if (handheld) return <small className={s.faint}>{local.phase === "ready" ? "已连接" : "在电脑上用"}</small>;
  switch (local.phase) {
    case "checking": return <small className={s.faint}>正在连…</small>;
    case "prompt": return <div className={s.guide} data-testid="local-prompt"><span className={s.state} data-tone="wait">等浏览器授权</span><BrowserPrompt /><Retry /></div>;
    case "blocked": return <div className={s.guide} data-testid="local-blocked"><span className={s.state} data-tone="warn">浏览器拦住了</span><SiteSettings /></div>;
    case "offline": return <LocalInstall standalone />;
    case "unpaired": return (
      <div className={s.guide} data-testid="local-unpaired">
        {local.pairing?.state === "waiting" ? <span className={s.code}>确认码 <b>{local.pairing.code}</b></span>
          : <HeroButton variant="primary" size="sm" onPress={() => void local.pair()}>配对</HeroButton>}
        {local.pairing && local.pairing.state !== "waiting" ? <small className={s.faint}>{local.pairing.state === "denied" ? "本机拒绝了" : "没确认，过期了"}</small> : null}
        {local.error ? <small className={s.faint}>{local.error}</small> : null}
      </div>
    );
    case "ready": return <small className={s.faint}>{local.version ? `v${local.version}` : ""}</small>;
  }
}

/** 浏览器正在问「访问此设备上的其他应用和服务」：画一个那样的小框，「允许」亮着。 */
function BrowserPrompt() {
  return (
    <svg className={s.figure} viewBox="0 0 260 92" role="img" aria-label="在浏览器弹出的框里点「允许」">
      <rect x="1" y="1" width="258" height="90" rx="10" fill="#fff" stroke="#dfe4e9" />
      <rect x="14" y="16" width="150" height="8" rx="4" fill="#cfd8e6" />
      <rect x="14" y="32" width="200" height="6" rx="3" fill="#e3e8ef" />
      <rect x="120" y="58" width="58" height="22" rx="11" fill="#f1f3f6" />
      <text x="149" y="73" textAnchor="middle" fontSize="11" fill="#535358">屏蔽</text>
      <rect x="186" y="58" width="60" height="22" rx="11" fill="#3A83F7" />
      <text x="216" y="73" textAnchor="middle" fontSize="11" fill="#fff">允许</text>
    </svg>
  );
}

/** 拒过以后浏览器不再问：指到地址栏左边的站点设置，「本地网络访问」改成允许；装成应用的窗口在「⋮ → 应用信息」。 */
function SiteSettings() {
  return (
    <div className={s.steps}>
      <svg className={s.figure} viewBox="0 0 260 64" role="img" aria-label="点地址栏左边的站点设置">
        <rect x="1" y="8" width="258" height="30" rx="15" fill="#f1f3f6" />
        <circle cx="22" cy="23" r="11" fill="#fff" stroke="#3A83F7" strokeWidth="2" />
        <path d="M17 20h10M17 26h10" stroke="#3A83F7" strokeWidth="1.6" strokeLinecap="round" />
        <rect x="42" y="18" width="120" height="10" rx="5" fill="#cfd8e6" />
        <path d="M22 40v12" stroke="#3A83F7" strokeWidth="1.6" />
        <text x="30" y="58" fontSize="11" fill="#075ccb">站点设置</text>
      </svg>
      <ol className={s.stepList}><li>本地网络访问 › 允许</li><li>应用窗口：⋮ › 应用信息</li></ol>
    </div>
  );
}

/** 「重试」：不等挂着的那次，真的再探一遍（浏览器会问的，再问一次）。 */
function Retry() {
  const local = useLocalRunner();
  const [busy, setBusy] = useState(false);
  return <HeroButton variant="ghost" size="sm" isDisabled={busy} onPress={() => { setBusy(true); void local.refresh({ fresh: true }).finally(() => setBusy(false)); }}>重试</HeroButton>;
}

/**
 * 本机程序没开：给打开它的路——安装命令和「复制」（装好就起来，装过的再跑一遍也是把它打开）。
 * 桌面版窗口里本机程序是壳自己带的，不给安装命令（壳会把它重新拉起来）。
 * 右栏也用这一块，只要命令（「离线」和「重试」右栏自己有）；连接页 standalone，带「没连上」和「重试」。
 */
export function LocalInstall({ standalone = false }: { standalone?: boolean }) {
  const [copied, setCopied] = useState<string | null>(null);
  const mac = typeof navigator !== "undefined" && /Mac/i.test(navigator.userAgent);
  const desktop = typeof navigator !== "undefined" && navigator.userAgent.includes("TianshuDesktop/");
  const lines = desktop ? [] : [{ key: mac ? "mac" : "win", label: mac ? "Mac" : "Windows", text: installCommand(mac) }];
  const copy = async (key: string, text: string) => {
    try { await navigator.clipboard.writeText(text); setCopied(key); window.setTimeout(() => setCopied(null), 1600); } catch { /* 手动选中复制 */ }
  };
  if (!standalone && !lines.length) return null;
  return (
    <div className={s.guide} data-testid="local-offline">
      {standalone ? <span className={s.state}>没连上</span> : null}
      {lines.map((line) => (
        <div key={line.key} className={s.command}>
          <small>{line.label}</small>
          <code>{line.text}</code>
          <button type="button" className={s.copy} onClick={() => void copy(line.key, line.text)} aria-label="复制">{copied === line.key ? <Check size={14} aria-hidden /> : <Copy size={14} aria-hidden />}{copied === line.key ? "已复制" : "复制"}</button>
        </div>
      ))}
      {standalone ? <Retry /> : null}
    </div>
  );
}

function ModelsAndFolders() {
  const local = useLocalRunner();
  return (
    <div className={s.grid2}>
      <div className={s.block}>
        <p className={s.lab}>模型</p>
        {local.models.map((model) => (
          <div key={model.id} className={s.line}>
            <span className={s.badge}>{model.source === "subscription" ? "订阅" : "TokenHub"}</span>
            <b>{model.label}</b>
            <span className={s.grow} />
            <small className={s.faint}>{model.webSearch ? "能联网搜索" : ""}{model.isDefault ? " · 默认" : ""}</small>
          </div>
        ))}
      </div>
      <div className={s.block}>
        <p className={s.lab}>允许的文件夹<span className={s.grow} /><button type="button" className={s.add} onClick={() => void local.pickFolder()}><FolderPlus size={14} aria-hidden />添加</button></p>
        {local.folders.length ? local.folders.map((folder) => (
          <div key={folder.id} className={s.line} title={folder.path}>
            <b>{folder.label}</b>
            <small className={s.path}>{folder.path}</small>
            <span className={s.grow} />
            <button type="button" className={s.mini} aria-label={`移除 ${folder.label}`} onClick={() => void local.runner.removeFolder(folder.id).then(() => local.refresh())}><X size={13} aria-hidden /></button>
          </div>
        )) : <small className={s.faint}>还没有</small>}
        {local.error ? <small className={s.error} role="alert">{local.error}</small> : null}
      </div>
    </div>
  );
}

/**
 * 本机设备（新首页设计 12.1 第 7 条）：吊销的正好是这台时，当场重新关联（这台电脑拿一把新令牌，被吊销的那一行留着写「已吊销」）；
 * 被吊销的设备只写「已吊销」，不再有按钮。
 */
export function DevicesSection({ person }: { person: LinkPerson }) {
  const local = useLocalRunner();
  const [devices, setDevices] = useState<TLocalDeviceView[] | null>(null);
  // 这页吊销的留在页上：列表只回没吊销的，重新拉掉了就接在后面；列表里又有了（重新关联过）就不算吊销。
  const [revoked, setRevoked] = useState<TLocalDeviceView[]>([]);
  const load = () => void listDevices().then((list) => { setDevices(list); setRevoked((gone) => gone.filter((device) => !list.some((entry) => entry.id === device.id))); }).catch(() => setDevices([]));
  useEffect(load, [local.status?.cloud.linked]);
  const [failed, setFailed] = useState<string | null>(null);
  const rows = [...(devices ?? []), ...revoked.filter((device) => !devices?.some((entry) => entry.id === device.id))];
  if (!rows.length) return null;
  const here = local.status?.deviceId ?? null;
  const revoke = (device: TLocalDeviceView) => void revokeDevice(device.id).then(async () => {
    setFailed(null);
    setRevoked((gone) => [...gone, device]);
    if (device.id === here && local.status) { await linkCloud(local.runner, local.status, person).catch(() => undefined); await local.refresh(); load(); }
  }).catch(() => setFailed(device.id));
  return (
    <section className={s.section} aria-label="本机设备">
      <p className={s.lab}>本机设备</p>
      <div className={s.block}>
        {rows.map((device) => (
          <div key={device.id} className={s.line}>
            <b>{device.name}</b>
            {device.id === here ? <span className={s.badge}>这台</span> : null}
            <small className={s.faint}>{device.appVersion ? `v${device.appVersion} · ` : ""}{ago(device.lastSyncAt)}</small>
            <span className={s.grow} />
            {revoked.some((entry) => entry.id === device.id) ? <span className={s.state}>已吊销</span>
              : <>{failed === device.id ? <span className={s.error}>失败</span> : null}<HeroButton variant="ghost" size="sm" onPress={() => revoke(device)}>{failed === device.id ? "重试" : "吊销"}</HeroButton></>}
          </div>
        ))}
      </div>
    </section>
  );
}
