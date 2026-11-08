import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Project } from "@/lib/home/projects";
import { LocalContext } from "@/lib/local/LocalRunnerProvider";
import { ProjectInfo } from "./ProjectInfo";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/me/work" }));
const local = { phase: "ready", folders: [], sessions: [] } as unknown as Parameters<typeof LocalContext.Provider>[0]["value"];

const project = { id: "p1", name: "首页改版", archived: false, folder: null, transfer: null, goals: [], current: [], subSessions: [], items: [] } as unknown as Project;
const actions = { rename: vi.fn(), archive: vi.fn(), setFolder: vi.fn(), transfer: vi.fn(), withdraw: vi.fn() };

describe("项目详情：自动接力上限（18.12）", () => {
  it("有一行「自动接力上限」，没读到项目详情时写缺省的 20 轮", () => {
    const html = renderToStaticMarkup(<LocalContext.Provider value={local}><ProjectInfo project={project} period="2026-11" go={vi.fn()} actions={actions} doneDefinitionOf={() => null} me={{ personId: "me", name: "我" }} /></LocalContext.Provider>);
    expect(html).toMatch(/自动接力上限.*data-testid="project-relay-limit".*20 轮/);
  });
});
