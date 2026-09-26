type Role = "ceo" | "member";

/** 锁屏、引导共用：只恢复该身份下的站内工作页面，不回到登录/引导本身。 */
export function validNextPath(role: Role, candidate?: string): string | null {
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//") || /[\\\u0000-\u0020]/.test(candidate)) return null;
  try {
    const url = new URL(candidate, "https://tianshu.local");
    const path = decodeURIComponent(url.pathname);
    if (url.origin !== "https://tianshu.local" || /[\\\u0000-\u0020]/.test(path) || path.startsWith("//")) return null;
    if (/^\/(access|welcome|api|_next)(\/|$)/.test(path)) return null;
    const member = path === "/me" || path.startsWith("/me/");
    if ((role === "member") !== member) return null;
    url.searchParams.delete("_entry");
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return null; }
}

export function homePath(role: Role) { return role === "ceo" ? "/" : "/me"; }

export function withHomeEntry(path: string): string {
  const url = new URL(path, "https://tianshu.local");
  if (url.pathname === "/" || url.pathname === "/me") url.searchParams.set("_entry", "unlock");
  return `${url.pathname}${url.search}${url.hash}`;
}

export function landingPath(role: Role, nextPath?: string): string {
  return withHomeEntry(validNextPath(role, nextPath) ?? homePath(role));
}

export function loginDestination(role: Role, nextPath?: string, onboarded = true): string {
  if (onboarded) return landingPath(role, nextPath);
  const next = validNextPath(role, nextPath);
  return next ? `/welcome?next=${encodeURIComponent(next)}` : "/welcome";
}

export function onboardingDestination(role: Role, nextPath: string | undefined, suggestedPath: string): string {
  return withHomeEntry(validNextPath(role, nextPath) ?? validNextPath(role, suggestedPath) ?? homePath(role));
}
