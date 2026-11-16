import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LocalContext } from "@/lib/local/LocalRunnerProvider";
import { createHttpRunner } from "@/lib/local/client";
import { createMockRunner } from "@/lib/local/mock";
import { placePath } from "@/lib/work/merge";
import { FolderText, folderActions, registeredFolder } from "./InputFooter";

const WIN = "Mozilla/5.0 (Windows NT 10.0; Win64; x64)";
const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)";
const LINUX = "Mozilla/5.0 (X11; Linux x86_64)";
const TIANSHU = "C:\\work\\tianshu";
const labels = (input: Parameters<typeof folderActions>[0]) => folderActions(input).map((entry) => entry.label);

describe("输入框下面的文件夹菜单（11/16）", () => {
  it("这台电脑上登记过的：在资源管理器中显示、复制路径；项目对话再加「添加文件夹…」；系统不同叫法不同", () => {
    expect(labels({ reveal: true, add: true, userAgent: WIN })).toEqual(["在资源管理器中显示", "复制路径", "添加文件夹…"]);
    expect(labels({ reveal: true, add: false, userAgent: MAC })).toEqual(["在访达中显示", "复制路径"]);
    expect(labels({ reveal: true, add: false, userAgent: LINUX })).toEqual(["在文件管理器中显示", "复制路径"]);
  });

  it("不是这台电脑上登记过的（手机、别的电脑）只要知道路径就能复制", () => {
    expect(labels({ reveal: false, add: false, userAgent: WIN })).toEqual(["复制路径"]);
  });

  it("知道路径：文件夹名是能点开菜单的按钮；不知道路径照旧只写名字", () => {
    expect(renderToStaticMarkup(<FolderText name="tianshu" title={TIANSHU} path={TIANSHU} />)).toMatch(/<button[^>]*data-testid="footer-folder"[^>]*>[\s\S]*?tianshu/);
    const plain = renderToStaticMarkup(<FolderText name="feat-x" title="分支 feat-x" />);
    expect(plain).toMatch(/<span[^>]*data-testid="footer-folder"/);
    expect(plain).not.toContain("<button");
  });

  it("子会话复制的是它真正在做的地方：工作树是工作树的目录，普通文件夹是那个文件夹", () => {
    expect(placePath({ kind: "folder", folder: TIANSHU })).toBe(TIANSHU);
    expect(placePath({ kind: "worktree", folder: TIANSHU, path: "C:\\data\\worktrees\\c1", branch: "card/c1", baseBranch: "main", baseCommit: "a".repeat(40), mergedCommit: null })).toBe("C:\\data\\worktrees\\c1");
  });

  it("在资源管理器中显示只在连着本机、路径是登记过的文件夹时有", () => {
    const local = (phase: string) => ({ runner: createMockRunner(), phase, folders: [{ id: "f1", path: TIANSHU, label: "tianshu", addedAt: "2026-11-16T00:00:00Z" }] }) as unknown as Parameters<typeof LocalContext.Provider>[0]["value"];
    expect(registeredFolder(local("ready"), TIANSHU)?.id).toBe("f1");
    expect(registeredFolder(local("ready"), "C:\\work\\other")).toBeNull();
    expect(registeredFolder(local("offline"), TIANSHU)).toBeNull();
    expect(registeredFolder(null, TIANSHU)).toBeNull();
  });
});

describe("本机打开文件夹", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("网页只交文件夹 id：POST /v1/folders/:id/open，体是 {}", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
    vi.stubGlobal("fetch", fetch);
    await createHttpRunner("http://127.0.0.1:1", () => "t").openFolder("f1");
    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:1/v1/folders/f1/open", expect.objectContaining({ method: "POST", body: "{}" }));
  });

  it("假本机：登记过的打开，没登记的 404", async () => {
    const runner = createMockRunner();
    const [folder] = await runner.listFolders();
    await expect(runner.openFolder(folder!.id)).resolves.toBeUndefined();
    await expect(runner.openFolder("nope")).rejects.toMatchObject({ status: 404 });
  });
});
