/**
 * 连本机这一步走到哪了（第 11.3 节，RFC 附录 F）：
 * - prompt：浏览器正在问「允许访问此设备上的其他应用和服务」，等本人点；
 * - blocked：本人点过「屏蔽」，浏览器不再问，只能去站点设置改回允许；
 * - offline：浏览器放行了，但本机程序没装或没开；
 * - unpaired：连上了，还没配对（或口令失效）；
 * - ready：连上并配好对。
 */
export type LocalPhase = "checking" | "prompt" | "blocked" | "offline" | "unpaired" | "ready";

export type BrowserPermission = "granted" | "denied" | "prompt" | "unknown";

/** Chrome 156 叫 loopback-network，早一点的版本叫 local-network-access；都查不到就当不知道。 */
const PERMISSION_NAMES = ["loopback-network", "local-network-access"];

export async function readBrowserPermission(): Promise<BrowserPermission> {
  if (typeof navigator === "undefined" || !navigator.permissions?.query) return "unknown";
  for (const name of PERMISSION_NAMES) {
    try {
      const status = await navigator.permissions.query({ name } as unknown as PermissionDescriptor);
      return status.state;
    } catch { /* 这个名字浏览器不认，试下一个 */ }
  }
  return "unknown";
}

type CloudLink = { cloud: { linked: boolean; personId: string | null } };

/**
 * 本机程序关联的是别人（同一台电脑换了账号登录）：按没配对显示，不读它的会话和后台。按人员 id 比；
 * 没关联、老的关联（当时没传 personId，见 needsRelink）、或不知道本人是谁时不算别人。
 */
export function pairedElsewhere(status: CloudLink, personId: string | null | undefined): boolean {
  return !!personId && status.cloud.linked && !!status.cloud.personId && status.cloud.personId !== personId;
}

/** 老的关联（没记下是谁）：连接页再给一次「关联」，点了就记上本人。 */
export const needsRelink = (status: CloudLink) => status.cloud.linked && !status.cloud.personId;

/**
 * 探测挂了多久才算「浏览器在问」。浏览器弹授权框时 fetch 一直挂着，等本人点；本机程序没开时很快失败。
 * 11/08 在 Windows 11 上实测（Chromium 152 连 127.0.0.1 一个没人听的端口）：失败要 0.23～2.06 秒（约 0.25 和 1.8 交替），
 * 本机程序开着时 health 5 毫秒回来。原来的 1.2 秒比关着的端口失败还早，程序没开也会亮「等授权」；取 3.5 秒留余量。
 */
export const PROMPT_WAIT_MS = 3500;

/**
 * 一次探测的结果折成阶段。授权状态在浏览器从没问过时也是 prompt（比如 localhost 连 127.0.0.1 根本不问），所以光看它分不出来，要看探测挂了多久：
 * - 成功：看口令；
 * - 授权 denied：被拦截；
 * - 挂过 PROMPT_WAIT_MS 还没回来（waiting），授权是 prompt：浏览器在问；挂了这么久才失败（本人把框关了）也算，重试会再问；
 * - 很快就失败：本机程序没开（offline）。
 */
export function phaseOf(probe: { health: "ok" | "failed" | "waiting"; tokenValid?: boolean; permission: BrowserPermission; elapsedMs?: number }): LocalPhase {
  if (probe.health === "ok") return probe.tokenValid ? "ready" : "unpaired";
  if (probe.permission === "denied") return "blocked";
  if (probe.health === "waiting") return probe.permission === "prompt" ? "prompt" : "checking";
  return probe.permission === "prompt" && (probe.elapsedMs ?? 0) >= PROMPT_WAIT_MS ? "prompt" : "offline";
}

/**
 * 探一次 health：挂过 PROMPT_WAIT_MS 还没回来，先用 onWaiting 报一次阶段（浏览器在问就是 prompt）；
 * 回来了交回 health 的结果，失败了交回按授权状态和用时折出的阶段。
 */
export async function probeRunner<T>(health: () => Promise<T>, onWaiting: (phase: LocalPhase) => void,
  readPermission: () => Promise<BrowserPermission> = readBrowserPermission): Promise<{ health: T } | { phase: LocalPhase }> {
  let settled = false;
  const started = Date.now();
  const early = setTimeout(() => {
    void readPermission().then((permission) => { if (!settled) onWaiting(phaseOf({ health: "waiting", permission })); });
  }, PROMPT_WAIT_MS);
  try {
    const value = await health();
    settled = true;
    return { health: value };
  } catch {
    settled = true;
    const elapsedMs = Date.now() - started;
    return { phase: phaseOf({ health: "failed", permission: await readPermission(), elapsedMs }) };
  } finally {
    clearTimeout(early);
  }
}

/**
 * 同一时间只探一次：有一次在探，再叫就等它；fresh（本人点「重试」）不等挂着的那次，另起一次，旧的那次结果作废（latest() 变 false）。
 */
export function singleFlight() {
  let current: Promise<void> | null = null;
  let seq = 0;
  return (run: (latest: () => boolean) => Promise<void>, fresh = false): Promise<void> => {
    if (current && !fresh) return current;
    const mine = ++seq;
    const flight: Promise<void> = run(() => mine === seq).finally(() => { if (current === flight) current = null; });
    current = flight;
    return flight;
  };
}
