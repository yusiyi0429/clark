type Role = "ceo" | "member";

/** 锁屏、引导共用：只恢复该身份下的站内工作页面，不回到登录/引导本身。 */
export function validNextPath(role: Role, candidate?: string): string | null {
  if (!candidate || !candidate.startsWith("/") || candidate.startsWith("//") || /[\\\u0000-\u0020]/.test(candidate)) return null;
  try {
    const url = new URL(candidate, "https://tianshu.local");
    const path = decodeURIComponent(url.pathname);
    if (url.origin !== "https://tianshu.local" || /[\\\u0000-\u0020]/.test(path) || path.startsWith("//")) return null;
    if (/^\/(access|welcome|api|_next)(\/|$)/.test(path)) return null;
    if (path === "/oauth/consent") {
      const id = url.searchParams.get("request");
      return id && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id) &&
        [...url.searchParams].length === 1 && !url.hash ? `${path}?request=${id}` : null;
    }
    const member = path === "/me" || path.startsWith("/me/");
    if ((role === "member") !== member) return null;
    url.searchParams.delete("_entry");
    return `${url.pathname}${url.search}${url.hash}`;
  } catch { return null; }
}

export function homePath(role: Role) { return role === "ceo" ? "/" : "/me"; }

/** 回到首页时带上 _entry=unlock，首页据此做进门淡入；/me/work 是成员的新首页（锁屏或登录过期后回来的就是它）。 */
export function withHomeEntry(path: string): string {
  const url = new URL(path, "https://tianshu.local");
  if (url.pathname === "/" || url.pathname === "/me" || url.pathname === "/me/work") url.searchParams.set("_entry", "unlock");
  return `${url.pathname}${url.search}${url.hash}`;
}

export function landingPath(role: Role, nextPath?: string): string {
  return withHomeEntry(validNextPath(role, nextPath) ?? homePath(role));
}

export function loginDestination(role: Role, nextPath?: string, onboarded = true): string {
  const consent = validNextPath(role, nextPath);
  if (consent?.startsWith("/oauth/consent?")) return consent;
  if (onboarded) return landingPath(role, nextPath);
  const next = validNextPath(role, nextPath);
  return next ? `/welcome?next=${encodeURIComponent(next)}` : "/welcome";
}

/** 登录的默认首页不是待恢复的原链接；保留真正指向工作内容的链接。 */
export function onboardingReturnPath(role: Role, nextPath?: string): string | null {
  const next = validNextPath(role, nextPath);
  return next === homePath(role) ? null : next;
}

export function onboardingDestination(role: Role, nextPath: string | undefined, suggestedPath: string): string {
  return withHomeEntry(onboardingReturnPath(role, nextPath) ?? validNextPath(role, suggestedPath) ?? homePath(role));
}
