import { COAGENT_SKINS, type CoAgentSkin } from "@/components/coagent/skin";

/**
 * 这台电脑上次登录的人（设计稿 19 节「认得你就请出伙伴」）：ID、显示名和他的伙伴（名字、形象），不记口令。
 * 登录成功时写入；退出登录不清（下次还认得）；登录页点「换个人」才清。伙伴是后来选的或改了，保存伙伴时用 refreshLastLogin 跟上。
 */
export type LastLoginBuddy = { name: string; form: CoAgentSkin };
export type LastLogin = { loginId: string; displayName: string; buddy?: LastLoginBuddy };

const storageKey = "tianshu.lastLogin";
const FORMS = new Set<string>(COAGENT_SKINS.map((skin) => skin.id));

function buddyOf(value: unknown): LastLoginBuddy | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { name, form } = value as { name?: unknown; form?: unknown };
  return typeof name === "string" && name.trim() && typeof form === "string" && FORMS.has(form) ? { name, form: form as CoAgentSkin } : undefined;
}

export function readLastLogin(): LastLogin | null {
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return null;
    const value: unknown = JSON.parse(stored);
    if (!value || typeof value !== "object" || !("loginId" in value) || !("displayName" in value)) return null;
    if (typeof value.loginId !== "string" || !value.loginId.trim() || typeof value.displayName !== "string" || !value.displayName.trim()) return null;
    const buddy = buddyOf((value as { buddy?: unknown }).buddy);
    return { loginId: value.loginId, displayName: value.displayName, ...(buddy ? { buddy } : {}) };
  } catch {
    return null;
  }
}

export function saveLastLogin(lastLogin: LastLogin): void {
  try {
    window.localStorage.setItem(storageKey, JSON.stringify(lastLogin));
  } catch {
    // Storage can be unavailable; the signed-in session still works.
  }
}

type Session = { authenticated?: boolean; displayName?: string; loginId?: string; buddy?: unknown };

async function readSession(): Promise<Session | null> {
  const response = await fetch("/api/auth/session");
  return response.ok ? (await response.json()) as Session : null;
}

export async function rememberLastLogin(loginId: string): Promise<void> {
  try {
    const session = await readSession();
    if (session?.authenticated && typeof session.displayName === "string" && session.displayName.trim()) {
      const buddy = buddyOf(session.buddy);
      saveLastLogin({ loginId, displayName: session.displayName, ...(buddy ? { buddy } : {}) });
    }
  } catch {
    // Session lookup is best effort; a successful login still enters the workspace.
  }
}

/** 保存伙伴以后：记住的正是当前登录的这个人时，换上他现在的伙伴（引导里第一次选的、设置里改的）。 */
export async function refreshLastLogin(): Promise<void> {
  try {
    const stored = readLastLogin();
    if (!stored) return;
    const session = await readSession();
    if (!session?.authenticated || session.loginId !== stored.loginId) return;
    const buddy = buddyOf(session.buddy);
    saveLastLogin({ loginId: stored.loginId, displayName: session.displayName?.trim() ? session.displayName : stored.displayName, ...(buddy ? { buddy } : {}) });
  } catch {
    // Best effort, like rememberLastLogin.
  }
}

export function clearLastLogin(): void {
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // The visible form still switches accounts when storage is unavailable.
  }
}
