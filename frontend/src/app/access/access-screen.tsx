"use client";

import { useState } from "react";
import { TianshuMark } from "@/components/brand/tianshu-mark";
import type { Seat } from "@/lib/seat";
import { AccessForm } from "./access-form";
import { LockscreenBackdrop, LockscreenClock } from "./lockscreen-visual";
import styles from "./access.module.css";

export function AccessScreen({
  configured,
  initialSeat,
  nextPath,
}: {
  configured: boolean;
  initialSeat: Seat;
  nextPath: string | null;
}) {
  const [unlocking, setUnlocking] = useState(false);

  return (
    <main className={styles.shell} data-unlocking={unlocking}>
      <LockscreenBackdrop />

      <div className={styles.brand} aria-label="天枢">
        <TianshuMark className={styles.brandMark} />
        <span className={styles.brandName}>天枢</span>
      </div>

      <section className={styles.lockscreen} aria-labelledby="access-title">
        <h1 id="access-title" className={styles.srOnly}>
          进入天枢
        </h1>

        <LockscreenClock />

        {configured ? (
          <AccessForm
            nextPath={nextPath}
            initialSeat={initialSeat}
            onUnlock={() => setUnlocking(true)}
          />
        ) : (
          <div className={styles.configurationNotice} role="status">
            <h2>访问控制尚未启用</h2>
            <p>服务端缺少访问口令或签名密钥。</p>
          </div>
        )}
      </section>

      <footer className={styles.panelFooter}>
        <a href="https://beian.miit.gov.cn/" target="_blank" rel="noreferrer">
          京ICP备2026051441号
        </a>
      </footer>

      <div className={styles.unlockWash} aria-hidden="true" />
    </main>
  );
}
