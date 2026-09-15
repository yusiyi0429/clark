"use client";

import Image from "next/image";
import { useEffect, useState } from "react";
import { formatLockDate, formatLockTime } from "./lockscreen-time";
import styles from "./access.module.css";

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

export function LockscreenBackdrop() {
  const [ready, setReady] = useState(false);

  return (
    <div className={styles.backdrop} data-image-ready={ready} aria-hidden="true">
      <div className={styles.gradientFallback} />
      <div className={styles.renderStage}>
        <Image
          src="/brand/tianshu-flow-lock-v2.webp"
          alt=""
          fill
          sizes="100vw"
          preload
          unoptimized
          draggable={false}
          className={styles.renderImage}
          onLoad={() => setReady(true)}
        />
      </div>

      <svg
        className={styles.lightOverlay}
        viewBox="0 0 1600 900"
        preserveAspectRatio="xMidYMid slice"
        focusable="false"
      >
        <defs>
          <linearGradient id="tkos-wake-light" x1="0" y1="0" x2="1" y2="0">
            <stop offset="0" stopColor="#c88b91" stopOpacity="0.08" />
            <stop offset="0.46" stopColor="#f3c0ab" stopOpacity="0.58" />
            <stop offset="0.78" stopColor="#fff0d8" stopOpacity="0.96" />
            <stop offset="1" stopColor="#d8989f" stopOpacity="0.12" />
          </linearGradient>
        </defs>
        <path
          d="M-40 355 C142 410 292 401 455 438 C610 473 705 471 807 511"
          pathLength="1"
          stroke="url(#tkos-wake-light)"
          className={styles.overlayContour}
        />
        <path
          d="M1640 232 C1480 256 1410 334 1273 327 C1148 320 1082 391 972 408 C890 421 840 468 797 511"
          pathLength="1"
          stroke="url(#tkos-wake-light)"
          className={`${styles.overlayContour} ${styles.overlayContourStrong}`}
        />
        <path
          d="M1590 271 C1436 309 1348 344 1218 365 C1085 386 934 452 797 512"
          pathLength="1"
          stroke="rgba(255, 239, 214, 0.9)"
          className={styles.overlayGlint}
        />
      </svg>

      <div className={styles.depthVeil} />
    </div>
  );
}
