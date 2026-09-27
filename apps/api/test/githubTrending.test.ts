import { describe, expect, it, vi } from "vitest";
import { createGithubTrendingReader, parseTrendingHtml, trendingPageUrl } from "../src/githubTrending.js";

// 按 2026-09-27 github.com/trending 的结构手写的精简夹具，不是原页副本。
const row = ({ owner, repo, description, language, stars }: { owner: string; repo: string; description?: string; language?: string; stars?: string }) => `
<article class="Box-row">
  <div class="float-right d-flex"><a href="/login?return_to=%2F${owner}%2F${repo}" class="btn-sm btn">Star</a></div>
  <h2 class="h3 lh-condensed">
    <a href="/${owner}/${repo}" data-view-component="true" class="Link"><svg aria-hidden="true"></svg>
      <span data-view-component="true" class="text-normal">${owner} /</span>
      ${repo}</a>
  </h2>
  ${description === undefined ? "" : `<p class="col-9 color-fg-muted my-1 tmp-pr-4">\n      ${description}\n    </p>`}
  <div class="f6 color-fg-muted mt-2">
    ${language ? `<span class="tmp-mr-3 d-inline-block ml-0 tmp-ml-0"><span class="repo-language-color" style="background-color: #3178c6"></span>
  <span itemprop="programmingLanguage">${language}</span></span>` : ""}
    <a href="/${owner}/${repo}/stargazers" class="tmp-mr-3 Link Link--muted d-inline-block"><svg></svg> 87,379</a>
    ${stars ? `<span data-view-component="true" class="d-inline-block float-sm-right"><svg></svg>\n        ${stars}\n</span>` : ""}
  </div>
</article>`;

const normal = `<html><body><main>${row({ owner: "paperclipai", repo: "paperclip", description: "The open-source app everyone uses to manage agents &amp; work", language: "TypeScript", stars: "2,608 stars today" })}
${row({ owner: "anthropics", repo: "claude-code-action", language: "TypeScript", stars: "31 stars today" })}
${row({ owner: "vercel", repo: "next.js", description: "The React Framework", stars: "1 star today" })}</main></body></html>`;
const changed = `<html><body><main><div class="repo-card"><a href="/paperclipai/paperclip">paperclipai / paperclip</a></div></main></body></html>`;
const empty = `<html><body><div class="blankslate"><h3>It looks like we don’t have any trending repositories for COBOL.</h3></div></body></html>`;

describe("GitHub Trending 读取器", () => {
  it("解析正常榜单：全名、链接、描述、语言、时段内 star；没有描述就是 null，不编", () => {
    expect(parseTrendingHtml(normal)).toEqual([
      { fullName: "paperclipai/paperclip", url: "https://github.com/paperclipai/paperclip", description: "The open-source app everyone uses to manage agents & work", language: "TypeScript", starsInPeriod: 2608 },
      { fullName: "anthropics/claude-code-action", url: "https://github.com/anthropics/claude-code-action", description: null, language: "TypeScript", starsInPeriod: 31 },
      { fullName: "vercel/next.js", url: "https://github.com/vercel/next.js", description: "The React Framework", language: null, starsInPeriod: 1 },
    ]);
  });

  it("结构变了与空榜都解析出 0 个，并各自写出明确的 warning", async () => {
    expect(parseTrendingHtml(changed)).toEqual([]);
    expect(parseTrendingHtml(empty)).toEqual([]);
    const reader = (html: string) => createGithubTrendingReader({ fetchImpl: vi.fn(async () => new Response(html, { status: 200 })), minIntervalMs: 0 });
    expect(await reader(changed).read({ language: null, since: "daily" }, new AbortController().signal)).toEqual({ repos: [], warnings: ["GitHub Trending 页面结构可能变了，没有解析出上榜仓库"] });
    expect(await reader(empty).read({ language: "cobol", since: "daily" }, new AbortController().signal)).toEqual({ repos: [], warnings: ["GitHub Trending 这一版今天是空榜"] });
    expect((await reader(normal).read({ language: null, since: "daily" }, new AbortController().signal)).warnings).toEqual([]);
  });

  it("按语言路径与 since 读对应的一版", () => {
    expect(trendingPageUrl({ language: null, since: "daily" })).toBe("https://github.com/trending");
    expect(trendingPageUrl({ language: "typescript", since: "weekly" })).toBe("https://github.com/trending/typescript?since=weekly");
    expect(trendingPageUrl({ language: "c++", since: "monthly" })).toBe("https://github.com/trending/c%2B%2B?since=monthly");
  });

  it("带 User-Agent、失败如实抛出、两次请求之间限速", async () => {
    const fetchImpl = vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(normal, { status: 200 }));
    const sleep = vi.fn(async () => undefined);
    const reader = createGithubTrendingReader({ fetchImpl: fetchImpl as unknown as typeof fetch, minIntervalMs: 2_000, sleep });
    await reader.read({ language: null, since: "daily" }, new AbortController().signal);
    await reader.read({ language: "typescript", since: "daily" }, new AbortController().signal);
    expect((fetchImpl.mock.calls[0][1]?.headers as Record<string, string>)["User-Agent"]).toMatch(/^Tianshu-PersonalRadar\//);
    expect(sleep).toHaveBeenCalledTimes(1);
    const failing = createGithubTrendingReader({ fetchImpl: vi.fn(async () => new Response("", { status: 429 })) as unknown as typeof fetch, minIntervalMs: 0 });
    await expect(failing.read({ language: null, since: "daily" }, new AbortController().signal)).rejects.toThrow("GitHub Trending 返回 HTTP 429");
  });
});
