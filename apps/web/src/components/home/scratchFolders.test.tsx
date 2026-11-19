import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/** 选文件夹的几处不列「随手」项目绑的文件夹（本人 11/19 收到幕后）。没有 jsdom：弹出菜单（Dropdown）换成直接画出来的桩（同 sessionsPanel.test）。 */
vi.mock("@heroui/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@heroui/react")>();
  const { createElement, Fragment } = await import("react");
  type Props = { children?: unknown; [key: string]: unknown };
  const Dropdown = Object.assign(({ children }: Props) => createElement(Fragment, null, children as never), {
    Trigger: ({ children, ...rest }: Props) => createElement("button", { type: "button", ...rest }, children as never),
    Popover: ({ children }: Props) => createElement(Fragment, null, children as never),
    Menu: ({ children, "aria-label": label }: Props) => createElement("ul", { "aria-label": label }, children as never),
    Item: ({ children, id }: Props) => createElement("li", { "data-key": id }, children as never),
  });
  return { ...actual, Dropdown };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/me/work" }));

import type { ReactNode } from "react";
import type { TLocalFolder } from "@warmap/contracts";
import { LocalContext, type LocalRunnerState } from "@/lib/local/LocalRunnerProvider";
import { FolderAsk, ScratchFolders } from "./FolderAsk";
import { FolderMenu } from "./InputFooter";
import { Folders } from "./pages/ConnectionsPage";

const folder = (id: string, label: string, path: string): TLocalFolder => ({ id, label, path, addedAt: "2026-11-18T00:00:00.000Z" });
const FOLDERS = [folder("f1", "tianshu", "C:\\work\\tianshu"), folder("s1", "随手", "C:\\Users\\me\\天枢\\随手")];
const local = { phase: "ready", folders: FOLDERS, error: null, pickFolder: vi.fn(), refresh: vi.fn(), runner: {} } as unknown as LocalRunnerState;
const render = (node: ReactNode, hidden: ReadonlySet<string> = new Set(["s1"])) => renderToStaticMarkup(
  <LocalContext.Provider value={local}><ScratchFolders.Provider value={hidden}>{node}</ScratchFolders.Provider></LocalContext.Provider>);

describe("选文件夹不列随手的文件夹", () => {
  it("在哪个文件夹开工、输入框下的文件夹菜单、连接页的文件夹数都不算随手绑的那个；没有随手时照旧", () => {
    const ask = render(<FolderAsk folders={FOLDERS} onBind={async () => undefined} onPickOther={async () => null} />);
    expect(ask).toContain("tianshu");
    expect(ask).not.toContain("随手");
    const menu = render(<FolderMenu folders={FOLDERS} onPick={vi.fn()} />);
    expect(menu).toContain('data-key="f1"');
    expect(menu).not.toContain('data-key="s1"');
    expect(render(<Folders run={vi.fn()} />)).toContain("1 个");
    expect(render(<FolderAsk folders={FOLDERS} onBind={async () => undefined} onPickOther={async () => null} />, new Set())).toContain("随手");
  });
});
