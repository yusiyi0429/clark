"use client";

/**
 * 全站画人的那个小圆：这个人传过照片就显示照片，没传过（或拿不到 personId）显示 children（各处原来的单字）。
 * 谁传过照片整页只读一次（/api/people/avatars）；本人换头像、删头像后用 setMyAvatarVersion 就地更新，不用重读。
 */

import { useState, useSyncExternalStore, type ReactNode } from "react";
import { browserApi } from "@/lib/api/client";
import a from "@/styles/person-avatar.module.css";

let versions: Record<string, string> | null = null;
let loading = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());

function subscribe(listener: () => void) {
  listeners.add(listener);
  if (versions === null && !loading) {
    loading = true;
    void browserApi.GET("/api/people/avatars").then(({ data }) => {
      if (data) { versions = { ...data.avatars, ...versions }; notify(); }
    }).catch(() => undefined).finally(() => { loading = false; });
  }
  return () => { listeners.delete(listener); };
}

export function useAvatarVersion(personId: string | null | undefined): string | null {
  const all = useSyncExternalStore(subscribe, () => versions, () => null);
  return personId ? all?.[personId] ?? null : null;
}

/** 本人换了（version）或删了（null）头像。 */
export function setMyAvatarVersion(personId: string, version: string | null) {
  const next = { ...versions };
  if (version) next[personId] = version; else delete next[personId];
  versions = next;
  notify();
}

const avatarUrl = (personId: string, version: string) =>
  `/api/people/${encodeURIComponent(personId)}/avatar?v=${encodeURIComponent(version)}`;

export function PersonAvatar({ personId, className, children }: { personId?: string | null; className?: string; children: ReactNode }) {
  const version = useAvatarVersion(personId);
  const src = personId && version ? avatarUrl(personId, version) : null;
  const [broken, setBroken] = useState<string | null>(null);
  return (
    <span className={className} aria-hidden="true">
      {src && broken !== src ? <img className={a.photo} src={src} alt="" onError={() => setBroken(src)} /> : children}
    </span>
  );
}
