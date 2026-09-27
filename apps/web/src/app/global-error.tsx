"use client";

import { TianshuMark } from "@/components/TianshuMark";

export default function GlobalError({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  const action = { display: "inline-flex", justifyContent: "center", alignItems: "center", minHeight: 48, padding: "10px 28px", borderRadius: 999, fontSize: 17, fontWeight: 600, cursor: "pointer" } as const;
  return (
    <html lang="zh-CN">
      <body style={{ margin: 0, fontFamily: "system-ui, sans-serif", color: "#1d1d1f", background: "linear-gradient(180deg, #f4faff, #eef3fa)" }}>
        <main style={{ minHeight: "100dvh", display: "grid", placeItems: "center", padding: 16, boxSizing: "border-box" }}>
          <section aria-labelledby="global-error-title" style={{ width: "min(100%, 400px)", boxSizing: "border-box", display: "grid", justifyItems: "center", gap: 12, padding: "40px 24px 32px", border: "1px solid #dce8f4", borderRadius: 24, background: "#ffffffec", boxShadow: "0 16px 48px #19375d18", textAlign: "center" }}>
            <TianshuMark className="mark" />
            <h1 id="global-error-title" style={{ margin: 0, fontSize: 22 }}>页面暂时无法显示</h1>
            <p style={{ margin: 0, fontSize: 15, lineHeight: 1.6, color: "#566170" }}>请重试，或者回到首页继续使用天枢。</p>
            <button type="button" onClick={() => retry()} style={{ ...action, marginTop: 16, border: 0, background: "#007aff", color: "white" }}>重试</button>
            <a href="/" style={{ ...action, minHeight: 40, marginTop: 4, padding: "8px 16px", fontSize: 15, fontWeight: 500, color: "#3a83f7", textDecoration: "none" }}>回到首页</a>
          </section>
        </main>
        <style>{`.mark{width:40px;height:40px;margin-bottom:4px}`}</style>
      </body>
    </html>
  );
}
