"use client";

/**
 * 不用盯着页面也能知道（设计 9.7）：等你大于 0 时，标签页标题写「(3) 天枢」，图标右上角一个 8px 强调色圆点；
 * 离开新首页、等你清零时还原。
 */
import { useEffect } from "react";

const TITLE = "天枢";

export function useTabTitle(waiting: number) {
  useEffect(() => {
    document.title = waiting > 0 ? `(${waiting}) ${TITLE}` : TITLE;
  }, [waiting]);
  useEffect(() => () => { document.title = TITLE; }, []);
  useEffect(() => {
    const links = [...document.querySelectorAll<HTMLLinkElement>('link[rel~="icon"]')];
    const link = links[0];
    if (!link) return;
    const original = link.href;
    if (!waiting) return;
    let cancelled = false;
    const image = new Image();
    image.crossOrigin = "anonymous";
    image.onload = () => {
      if (cancelled) return;
      const size = 32;
      const canvas = document.createElement("canvas");
      canvas.width = size;
      canvas.height = size;
      const context = canvas.getContext("2d");
      if (!context) return;
      context.drawImage(image, 0, 0, size, size);
      // 8px 圆点（32 的图标上画成 半径 8，浏览器缩到 16 时约 8px）；强调色读变量。
      context.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--accent").trim() || "#3a83f7";
      context.beginPath();
      context.arc(size - 8, 8, 8, 0, Math.PI * 2);
      context.fill();
      try { link.href = canvas.toDataURL("image/png"); } catch { /* 图标跨域，读不出来就不加点 */ }
    };
    image.src = original;
    return () => { cancelled = true; link.href = original; };
  }, [waiting]);
}
