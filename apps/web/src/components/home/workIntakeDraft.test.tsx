import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TCreateWorkIntake } from "@warmap/contracts";
import { WorkspaceContext, type WorkspaceApi } from "@/components/shell/WorkspaceContext";
import { uploadToConversation } from "@/lib/home/attachments";
import { useQueueWorkInput, useViewerQueueWorkInput } from "./WorkIntake";

vi.mock("@/lib/home/attachments", () => ({ uploadToConversation: vi.fn() }));

function mount(viewerId: string | null, fromHome = false) {
  let send!: ReturnType<typeof useQueueWorkInput>;
  function ChatInput() { send = useQueueWorkInput(); return null; }
  function HomeInput() { send = useViewerQueueWorkInput(viewerId); return null; }
  renderToStaticMarkup(fromHome ? <HomeInput /> : <WorkspaceContext.Provider value={{ viewerId } as WorkspaceApi}>
    <ChatInput />
  </WorkspaceContext.Provider>);
  return send;
}

const storage = new Map<string, string>();
const requests: TCreateWorkIntake[] = [];
let loseReply = false;
const text = "请检查这份内部草稿";
const file = (contents: string, name = "internal-draft.txt") =>
  new File([contents], name, { type: "text/plain", lastModified: 123456 });

beforeEach(() => {
  storage.clear();
  requests.length = 0;
  loseReply = false;
  vi.stubGlobal("window", {
    location: { pathname: "/me/work" },
    sessionStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
      removeItem: (key: string) => storage.delete(key),
    },
    dispatchEvent: vi.fn(),
  });
  vi.mocked(uploadToConversation).mockReset().mockImplementation(async (_, files) =>
    files.map(f => ({ id: crypto.randomUUID(), fileName: f.name, mimeType: f.type })));
  vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as TCreateWorkIntake;
    requests.push(body);
    if (loseReply) throw new Error("reply lost");
    return Response.json({ id: body.id, scope: body.scope, message: body.message, state: "queued" });
  });
});
afterEach(() => vi.unstubAllGlobals());

describe("工作队列草稿重试", () => {
  it("刷新后重用正文的提交标识，收到回执后主动再发会新建一条", async () => {
    loseReply = true;
    await expect(mount("owner", true)("global", text, [])).rejects.toThrow("reply lost");
    loseReply = false;
    await mount("owner")("global", text, []);
    expect(requests[1]).toEqual(requests[0]);
    expect(storage.size).toBe(0);
    await mount("owner")("global", text, []);
    expect(requests[2]!.id).not.toBe(requests[0]!.id);
  });

  it("重新选择相同文件就复用上传回执，不保存正文、文件名或文件内容", async () => {
    loseReply = true;
    const secret = "private file contents";
    await expect(mount("owner")("global", text, [file(secret)])).rejects.toThrow("reply lost");
    const persisted = JSON.stringify([...storage.entries()]);
    expect(storage.size).toBe(1);
    for (const value of [text, "internal-draft.txt", secret]) expect(persisted).not.toContain(value);
    loseReply = false;
    await mount("owner")("global", text, [file(secret)]);
    expect(uploadToConversation).toHaveBeenCalledTimes(1);
    expect(requests[1]).toEqual(requests[0]);
    expect(requests[0]!.attachments).toHaveLength(1);
  });

  it("同名、同大小、同修改时间的不同内容与重新排序的附件都要重新上传", async () => {
    loseReply = true;
    await expect(mount("owner")("global", text, [file("ab"), file("cd")])).rejects.toThrow("reply lost");
    loseReply = false;
    await mount("owner")("global", text, [file("xy"), file("cd")]);
    await mount("owner")("global", text, [file("cd"), file("ab")]);
    expect(new Set(requests.map(r => r.id)).size).toBe(3);
    expect(new Set(requests.flatMap(r => r.attachments.map(a => a.id))).size).toBe(6);
    expect(uploadToConversation).toHaveBeenCalledTimes(3);
  });

  it("分别绑定账号、管线和总管线内所在页面，其他账号无法重用原附件回执", async () => {
    loseReply = true;
    await expect(mount("owner")("global", text, [file("a")])).rejects.toThrow("reply lost");
    loseReply = false;
    await mount("other")("global", text, [file("a")]);
    await mount("owner")("project:00000000-0000-4000-8000-000000000001", text, [file("a")]);
    window.location.pathname = "/me/work/buddy";
    await mount("owner")("global", text, [file("a")]);
    window.location.pathname = "/me/work";
    await mount("owner")("global", text, [file("a")]);
    expect(requests[4]).toEqual(requests[0]);
    expect(new Set(requests.map(r => r.id)).size).toBe(4);
    expect(new Set(requests.flatMap(r => r.attachments.map(a => a.id))).size).toBe(4);
  });

  it("缺少登录成员或附件回执时保留草稿，等待再发", async () => {
    await expect(mount(null)("global", text, [])).rejects.toThrow();
    vi.mocked(uploadToConversation).mockResolvedValueOnce([]);
    const submit = mount("owner");
    await expect(submit("global", text, [file("ab")])).rejects.toThrow();
    expect(requests).toHaveLength(0);
    await submit("global", text, [file("ab")]);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.attachments).toHaveLength(1);
  });
});
