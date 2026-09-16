"use client";

import { createContext, useContext, useMemo, useState, type ReactNode } from "react";

export type BattlefieldMode = "decisions" | "progress";

type Display = {
  mode: BattlefieldMode;
  setMode: (mode: BattlefieldMode) => void;
  /** 单张卡翻面只切展示面，不改变业务状态；全局模式变化会清掉单卡覆盖。 */
  flipped: (id: string) => boolean;
  flip: (id: string) => void;
};

const Ctx = createContext<Display | null>(null);

export function BattlefieldDisplayProvider({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<BattlefieldMode>("decisions");
  const [overrides, setOverrides] = useState<Record<string, BattlefieldMode>>({});
  const value = useMemo<Display>(
    () => ({
      mode,
      setMode: (next) => {
        setMode(next);
        setOverrides({});
      },
      flipped: (id) => (overrides[id] ?? mode) === "progress",
      flip: (id) => setOverrides((current) => ({ ...current, [id]: (current[id] ?? mode) === "progress" ? "decisions" : "progress" })),
    }),
    [mode, overrides],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useBattlefieldDisplay(): Display {
  const value = useContext(Ctx);
  if (!value) throw new Error("BattlefieldDisplayProvider missing");
  return value;
}
