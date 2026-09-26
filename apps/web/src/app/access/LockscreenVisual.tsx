"use client";

import { useEffect, useState } from "react";
import { formatLockDate, formatLockTime } from "./lockscreenTime";
import styles from "@/styles/access.module.css";

export function LockscreenClock() {
  const [now, setNow] = useState<Date | null>(null);

  useEffect(() => {
    const refresh = () => setNow(new Date());
    const bootstrap = window.setTimeout(refresh, 0);
    const timer = window.setInterval(refresh, 15_000);

    return () => {
      window.clearTimeout(bootstrap);
      window.clearInterval(timer);
    };
  }, []);

  const time = now ? formatLockTime(now) : "--:--";
  const date = now ? formatLockDate(now) : "\u00a0";

  return (
    <div className={styles.clockGroup}>
      <div className={styles.lockGlyph} aria-hidden="true">
        <svg width="16" height="18" viewBox="0 0 16 18" fill="none" aria-hidden="true"><path d="M4.5 7V4.5a3.5 3.5 0 0 1 7 0V7" stroke="currentColor" strokeWidth="1.8"/><rect x="1.5" y="6.5" width="13" height="10.5" rx="2.5" fill="currentColor"/></svg>
      </div>
      <time
        className={styles.clock}
        dateTime={now?.toISOString()}
        aria-label={`当前时间 ${time}`}
      >
        {time}
      </time>
      <p className={styles.date}>{date}</p>
    </div>
  );
}
