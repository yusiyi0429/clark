export type LastLogin = { loginId: string; displayName: string };

const storageKey = "tianshu.lastLogin";

export function readLastLogin(): LastLogin | null {
  try {
    const stored = window.localStorage.getItem(storageKey);
    if (!stored) return null;
    const value: unknown = JSON.parse(stored);
    if (!value || typeof value !== "object" || !("loginId" in value) || !("displayName" in value)) return null;
    if (typeof value.loginId !== "string" || !value.loginId.trim() || typeof value.displayName !== "string" || !value.displayName.trim()) return null;
    return { loginId: value.loginId, displayName: value.displayName };
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

export async function rememberLastLogin(loginId: string): Promise<void> {
  try {
    const response = await fetch("/api/auth/session");
    if (!response.ok) return;
    const session = (await response.json()) as { authenticated?: boolean; displayName?: string };
    if (session.authenticated && typeof session.displayName === "string" && session.displayName.trim()) {
      saveLastLogin({ loginId, displayName: session.displayName });
    }
  } catch {
    // Session lookup is best effort; a successful login still enters the workspace.
  }
}

export function clearLastLogin(): void {
  try {
    window.localStorage.removeItem(storageKey);
  } catch {
    // The visible form still switches accounts when storage is unavailable.
  }
}
