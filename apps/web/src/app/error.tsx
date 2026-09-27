"use client";

import Link from "next/link";
import { TianshuMark } from "@/components/TianshuMark";
import s from "./not-found.module.css";

export default function ErrorPage({ retry }: { error: Error & { digest?: string }; retry: () => void }) {
  return (
    <main className={s.page}>
      <section className={s.card} aria-labelledby="error-title">
        <TianshuMark className={s.mark} />
        <h1 id="error-title">页面暂时无法显示</h1>
        <p>请重试，或者回到首页继续使用天枢。</p>
        <button type="button" className={s.home} style={{ border: 0, cursor: "pointer" }} onClick={() => retry()}>重试</button>
        <Link href="/" className={s.home}>回到首页</Link>
      </section>
    </main>
  );
}
