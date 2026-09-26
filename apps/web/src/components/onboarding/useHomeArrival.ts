"use client";

import { useEffect, useLayoutEffect, useState } from "react";
import { useSearchParams } from "next/navigation";

/** 只消费本次路由的展示参数，不持久化引导或业务状态。 */
export function useHomeArrival() {
  const params = useSearchParams();
  const [arriving, setArriving] = useState(() => params?.get("_entry") === "unlock");
  useLayoutEffect(() => {
    const url = new URL(window.location.href);
    if (url.searchParams.get("_entry") !== "unlock") return;
    url.searchParams.delete("_entry");
    window.history.replaceState(window.history.state, "", `${url.pathname}${url.search}${url.hash}`);
    setArriving(true);
  }, []);
  useEffect(() => {
    if (!arriving) return;
    const timer = window.setTimeout(() => setArriving(false), window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 150 : 640);
    return () => window.clearTimeout(timer);
  }, [arriving]);
  return arriving;
}
