import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

const post = vi.hoisted(() => vi.fn());
vi.mock("@/lib/board/cloud", async (original) => ({ ...await original<typeof import("@/lib/board/cloud")>(), openProjectPipeline: post }));
import { openPipeline, usePipelineScope } from "./Conversations";

/** 项目对话第一次画出来时拿到的 scope（服务端渲染不跑 effect：只看挂上那一刻）。 */
function Probe({ id }: { id: string }) {
  return <i>{usePipelineScope(id, `project:${id}`) ?? "等 POST"}</i>;
}
const deferred = () => {
  let resolve!: (value: unknown) => void;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
};

describe("项目对话的 scope 记在页面里", () => {
  it("认得的项目不等 POST 就用记下的 scope", async () => {
    post.mockReset();
    post.mockResolvedValueOnce({ projectId: "p-known", conversationId: "c1", scope: "project:p-known" });
    // 第一次打开：等 POST 回来。
    expect(renderToStaticMarkup(<Probe id="p-known" />)).toBe("<i>等 POST</i>");
    expect(await openPipeline("p-known", "project:p-known")).toBe("project:p-known");
    // 再打开：挂上那一刻就有 scope，不再发 POST。
    expect(renderToStaticMarkup(<Probe id="p-known" />)).toBe("<i>project:p-known</i>");
    expect(await openPipeline("p-known", "project:p-known")).toBe("project:p-known");
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("同一项目同时打开两次只发一次 POST", async () => {
    post.mockReset();
    const answer = deferred();
    post.mockReturnValueOnce(answer.promise);
    // 严格模式双跑 effect / 两处同时打开：在途的那次复用。
    const first = openPipeline("p-twice", "project:p-twice");
    const second = openPipeline("p-twice", "project:p-twice");
    expect(post).toHaveBeenCalledTimes(1);
    answer.resolve({ projectId: "p-twice", conversationId: "c2", scope: "project:p-twice" });
    expect(await Promise.all([first, second])).toEqual(["project:p-twice", "project:p-twice"]);
  });

  it("POST 没成：先用本地的 scope，下次打开再试", async () => {
    post.mockReset();
    post.mockRejectedValueOnce(new Error("offline"));
    expect(await openPipeline("p-failed", "project:p-failed")).toBe("project:p-failed");
    expect(renderToStaticMarkup(<Probe id="p-failed" />)).toBe("<i>等 POST</i>");
    post.mockResolvedValueOnce({ projectId: "p-failed", conversationId: "c3", scope: "project:p-failed" });
    await openPipeline("p-failed", "project:p-failed");
    expect(post).toHaveBeenCalledTimes(2);
  });
});
