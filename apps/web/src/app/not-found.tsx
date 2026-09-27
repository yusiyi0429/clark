import Link from "next/link";
import { TianshuMark } from "@/components/TianshuMark";
import s from "./not-found.module.css";

/** 全局 404：链接失效，或对象对当前身份不可见（API 对不可见对象同样返回 404，这里不区分两者）。 */
export default function NotFound() {
  return (
    <main className={s.page}>
      <section className={s.card} aria-labelledby="not-found-title">
        <TianshuMark className={s.mark} />
        <h1 id="not-found-title">找不到这个页面</h1>
        <p>链接可能已经失效，或者这项内容你暂时看不到。</p>
        <Link href="/" className={s.home}>回到首页</Link>
      </section>
    </main>
  );
}
