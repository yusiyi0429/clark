import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkHomeData } from "@/lib/home/types";

/**
 * 右边 thread 里的「在哪个文件夹开工？」由外壳（HomeShell）接上（Task 4 修复第 1 轮）。没有 jsdom，照 leftCollapse.test 的做法：
 * 整个 HomeShell 静态画出来，HomeFrame 里几格状态（面板位、thread、等文件夹的项目）由桩给，本机程序报「连着」。
 * 专题子会话页要挂载后才读到详情（静态画只有占位），所以只把它换成把 ask 画出来的薄壳（同 threadPane.test）；外壳、ThreadPane、FolderAsk 都是真的。
 */
const h = vi.hoisted(() => ({
  frameIndex: 0,
  /** HomeFrame 里第 7 个 useState（shown）、第 10 个（thread）、第 13 个（needFolder）。 */
  shown: "thread" as string | null,
  thread: { kind: "topic", id: "t1", from: "品牌建设" } as { kind: "card" | "topic"; id: string; from?: string } | null,
  needFolder: new Set<string>() as ReadonlySet<string>,
  path: "/me/work/buddy",
  data: undefined as WorkHomeData | undefined,
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      if (/^\s*at HomeFrame /.test(new Error().stack?.split("\n")[2] ?? "")) {
        const index = h.frameIndex++;
        if (index === 6) {
          if (initial !== null) throw new Error("HomeFrame 第 7 个 useState 不是面板位");
          return [h.shown, () => undefined];
        }
        if (index === 9) {
          if (initial !== null) throw new Error("HomeFrame 第 10 个 useState 不是 thread");
          return [h.thread, () => undefined];
        }
        if (index === 12) {
          const value = typeof initial === "function" ? (initial as () => unknown)() : initial;
          if (!(value instanceof Set)) throw new Error("HomeFrame 第 13 个 useState 不是 needFolder");
          return [h.needFolder, () => undefined];
        }
      }
      return actual.useState(initial);
    },
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => h.path, useSearchParams: () => new URLSearchParams() }));
vi.mock("@/lib/home/useWorkHome", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/home/useWorkHome")>();
  return { ...actual, useWorkHome: () => { const real = actual.useWorkHome(); return h.data ? { ...real, data: h.data } : real; } };
});
vi.mock("./usePhone", async (importOriginal) => ({ ...(await importOriginal<typeof import("./usePhone")>()), usePhone: () => false }));
// 这台电脑连着本机程序，允许的文件夹有一个。
vi.mock("@/lib/local/LocalRunnerProvider", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/local/LocalRunnerProvider")>();
  return { ...actual, useLocalRunner: () => ({ ...actual.useLocalRunner(), phase: "ready",
    folders: [{ id: "f1", path: "C:\\Users\\me\\work\\brand", label: "brand", addedAt: "2026-11-18T00:00:00.000Z" }] }) };
});
vi.mock("@/components/topics/TopicSession", () => ({
  TopicSession: ({ ask }: { ask?: ReactNode }) => <div data-testid="topic-session">{ask}</div>,
}));

import { HomeShell } from "./HomeShell";

const shell = () => { h.frameIndex = 0; return renderToStaticMarkup(<HomeShell account={{ displayName: "孙铭泽", role: "member", personId: "p" }} />); };
const topic = { id: "t1", kind: "topic", letter: null, title: "首页换深色", state: "queued", unseen: false, waiting: null, queueReason: null, holdUntil: null, role: null,
  sessionId: null, deviceId: null, autoStart: false, updatedAt: "2026-11-18T01:00:00.000Z", merge: null, free: true };

afterEach(() => { h.needFolder = new Set(); h.path = "/me/work/buddy"; h.data = undefined; });

describe("伙伴主线开的会话等文件夹（本人 11/18）", () => {
  it("右边 thread 里等文件夹时，选文件夹的框画在会话里", () => {
    h.data = { period: "2026-11", projects: [{ projectId: "p1", name: "品牌建设", lastActivityAt: null, budget: null, goals: [], transfer: null, unseen: false,
      summary: { running: 0, waiting: 0, queued: 1, done: 0, doneToday: 0, needsYou: 0 }, pipeline: { conversationId: null, scope: "project:p1" }, planning: false, subSessions: [topic], items: [] }],
      archivedCount: 0, month: { missions: [] }, waiting: [], other: { subSessions: [], items: [] } } as unknown as WorkHomeData;
    // 项目还没在这台电脑上绑文件夹、这个会话等着：右边 thread 的会话里出「在哪个文件夹开工？」，选项是这台电脑上的文件夹。
    h.needFolder = new Set(["p1"]);
    const waiting = shell();
    expect(waiting).toContain('data-testid="buddy-view"');
    const pane = waiting.slice(waiting.indexOf('data-testid="side-thread"'));
    expect(waiting).toContain('data-testid="side-thread"');
    expect(pane).toMatch(/data-testid="topic-session"><div[^>]*data-testid="folder-ask"/);
    expect(pane).toContain("在哪个文件夹开工？");
    expect(pane).toContain("C:\\Users\\me\\work\\brand");
    // 中间的主线里没有这个框。
    expect(waiting.slice(0, waiting.indexOf('data-testid="side-thread"'))).not.toContain("folder-ask");
    // 不等文件夹（这个项目没在等）：右边不出。
    h.needFolder = new Set();
    expect(shell()).not.toContain("folder-ask");
  });
});
