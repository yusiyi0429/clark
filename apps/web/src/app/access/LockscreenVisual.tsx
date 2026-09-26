"use client";

import Image from "next/image";
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

/**
 * 醒屏时沿壁纸那两道折边各走一遍的光。
 *
 * 两条路径不是随手画的曲线，是**照着当前这张壁纸量出来的**，量法有三处容易踩空：
 *
 * 1. **要在 16:9 的视口上量。** 这个 svg 的 viewBox 是 1600×900 + `slice`，只有在
 *    16:9 时它才和视口一比一对齐；换个宽高比，`slice` 是裁不是缩，按比例换算就会整体偏。
 * 2. **折边是暗线，不是明暗交界。** 拿上下两点相减找梯度，正好压在线上时读数反而接近 0；
 *    要用「比上下邻居暗多少」找极大值。
 * 3. **线只有一两像素宽。** 逐列扫描要步进够细，验证也要在 ±6px 内取最大，否则差两像素
 *    就读成没有。
 *
 * 量完的结果：两条线上「暗出邻居」的均值是 0.33 和 0.23，往下挪 70px 就归零 —— 贴着的。
 *
 * **换壁纸就要重新量一遍**，路径是写死在这张图上的。颜色同理：这张图亮，描边走深靛蓝；
 * 上一张深色壁纸用的是暖奶油色。
 */
export function LockscreenBackdrop() {
  const [ready, setReady] = useState(false);

  return (
    <div className={styles.backdrop} data-image-ready={ready} aria-hidden="true">
      <div className={styles.gradientFallback} />
      <div className={styles.renderStage}>
        <Image
          src="/brand/tianshu-flow-lock-v3.webp"
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
            <stop offset="0" stopColor="#5470d0" stopOpacity="0.1" />
            <stop offset="0.46" stopColor="#33489f" stopOpacity="0.52" />
            <stop offset="0.78" stopColor="#22307c" stopOpacity="0.88" />
            <stop offset="1" stopColor="#5d78d6" stopOpacity="0.12" />
          </linearGradient>
        </defs>
        <path
          d="M420 425 C430 433 450 451 480 471 C510 491 560 518 600 546 C640 574 680 606 720 639 C760 672 800 707 840 744 C880 781 940 842 960 861"
          pathLength="1"
          stroke="url(#tkos-wake-light)"
          className={styles.overlayContour}
        />
        <path
          d="M620 183 C650 189 750 207 800 219 C850 232 880 246 920 258 C960 271 1000 277 1040 294 C1080 311 1120 334 1160 360 C1200 386 1240 417 1280 450 C1320 484 1360 521 1400 561 C1440 602 1480 647 1520 693 C1560 739 1620 814 1640 838"
          pathLength="1"
          stroke="url(#tkos-wake-light)"
          className={`${styles.overlayContour} ${styles.overlayContourStrong}`}
        />
        <path
          d="M620 183 C650 189 750 207 800 219 C850 232 880 246 920 258 C960 271 1000 277 1040 294 C1080 311 1120 334 1160 360 C1200 386 1240 417 1280 450 C1320 484 1360 521 1400 561 C1440 602 1480 647 1520 693 C1560 739 1620 814 1640 838"
          pathLength="1"
          stroke="rgba(46, 66, 170, 0.92)"
          className={styles.overlayGlint}
        />
      </svg>

      <div className={styles.depthVeil} />
    </div>
  );
}
