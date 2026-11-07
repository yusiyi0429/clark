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

/** 一次探测的结果折成阶段：health 成功看口令；失败看浏览器授权；还没回来、浏览器在问就是 prompt。 */
export function phaseOf(probe: { health: "ok" | "failed" | "waiting"; tokenValid?: boolean; permission: BrowserPermission }): LocalPhase {
  if (probe.health === "ok") return probe.tokenValid ? "ready" : "unpaired";
  if (probe.permission === "denied") return "blocked";
  if (probe.permission === "prompt") return "prompt";
  return probe.health === "waiting" ? "checking" : "offline";
}
