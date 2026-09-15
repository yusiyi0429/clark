"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function LoginPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const router = useRouter();

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/auth/login", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password }),
    });
    setBusy(false);
    if (res.ok) {
      router.push("/");
      router.refresh();
      return;
    }
    const body = (await res.json().catch(() => ({}))) as { message?: string };
    setError(body.message ?? "登录失败");
  }

  return (
    <form onSubmit={submit}>
      <h1>CEO WarMap</h1>
      <label>
        访问密码
        <input
          type="password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          autoComplete="current-password"
          required
        />
      </label>
      <button type="submit" disabled={busy}>
        {busy ? "登录中…" : "登录"}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </form>
  );
}
