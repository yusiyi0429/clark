import { loadPeopleDirectory, type PeopleDirectory, type PeopleDirectoryEnv } from "./peopleDirectory.js";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import {
  type TSectionMatch,
  type TSectionSummary,
} from "@warmap/contracts";

export type MemorySection = TSectionSummary & { text: string };
export type { DirectoryPerson as MemoryPerson } from "./peopleDirectory.js";
export { loadPeople } from "./peopleDirectory.js";

export type CompanyMemoryRepository = PeopleDirectory & {
  listSections(): TSectionSummary[];
  searchSections(query: string, limit: number): TSectionMatch[];
  getPassages(sectionId: string, query: string | undefined, limit: number): {
    section: TSectionSummary;
    passages: { id: string; text: string; sourceRef: string; updatedAt: string }[];
  };
};

export type CompanyMemorySeedEnv = PeopleDirectoryEnv & {
  companyMemorySeedDir: string;
};

function bigrams(text: string): string[] {
  const normalized = text.toLowerCase().replace(/\s+/g, "");
  const grams: string[] = [];
  for (let i = 0; i < normalized.length - 1; i += 1) grams.push(normalized.slice(i, i + 2));
  return grams.length > 0 ? grams : normalized ? [normalized] : [];
}

/** ponytail: 标题/命中/字符 bigram overlap 简单排序；真实召回不足时只替换此函数，不动 MCP 契约 */
function relevance(text: string, title: string, query: string): number {
  const lowerText = text.toLowerCase();
  const lowerTitle = title.toLowerCase();
  const needle = query.toLowerCase().replace(/\s+/g, "");
  let score = 0;
  if (lowerTitle.includes(needle)) score += 10;
  if (lowerText.includes(needle)) score += 5;
  for (const gram of bigrams(query)) {
    if (lowerTitle.includes(gram)) score += 4;
    if (lowerText.includes(gram)) score += 2;
  }
  return score;
}

function snippet(text: string, query: string): string {
  const index = text.toLowerCase().indexOf(query.toLowerCase().replace(/\s+/g, "").slice(0, 8));
  const start = Math.max(0, index > 20 ? index - 20 : 0);
  return `${start > 0 ? "…" : ""}${text.slice(start, start + 120).trim()}${text.length > start + 120 ? "…" : ""}`;
}


function loadSections(seedDir: string): MemorySection[] {
  if (!existsSync(seedDir)) {
    throw new Error(`CompanyMemory Markdown 种子目录不存在: ${seedDir}（启动失败，不静默空目录）`);
  }
  const files = readdirSync(seedDir).filter((f) => f.endsWith(".md")).sort();
  if (files.length === 0) {
    throw new Error(`CompanyMemory Markdown 种子目录没有 .md 章节: ${seedDir}`);
  }
  const sections: MemorySection[] = [];
  for (const file of files) {
    const path = join(seedDir, file);
    const updatedAt = statSync(path).mtime.toISOString();
    const current = readFileSync(path, "utf8").split(/\r?\n/);
    // 按二级标题切章；标题前内容视为文件前言，不入目录
    let heading: string | null = null;
    let lines: string[] = [];
    let fileIndex = 0;
    const flush = () => {
      if (heading === null) return;
      fileIndex += 1;
      const text = lines.join("\n").trim();
      sections.push({
        id: `${file}#s${fileIndex}`,
        title: heading,
        text,
        sourceRef: `${file}#${heading}`,
        updatedAt,
      });
    };
    for (const line of current) {
      // seed/memory/CompanyMemory.md 的历史 <Content> 包装行不属于任何章节
      if (line.trim() === "<Content>" || line.trim() === "</Content>") continue;
      const match = /^##\s+(.+?)\s*$/.exec(line);
      if (match) {
        flush();
        heading = match[1];
        lines = [];
      } else if (heading !== null) {
        lines.push(line);
      }
    }
    flush();
  }
  if (sections.length === 0) {
    throw new Error(`CompanyMemory Markdown 章节为空（缺少 "## 标题" 章节）: ${seedDir}`);
  }
  return sections;
}

function splitPassages(section: MemorySection): { id: string; text: string }[] {
  return section.text
    .split(/\n\s*\n/)
    .map((t) => t.trim())
    .filter((t) => t.length > 0)
    .map((text, i) => ({ id: `${section.id}#p${i + 1}`, text }));
}

/** 装载并校验 seed；任何缺失或不合规都抛错，让 API 启动诚实失败。 */
export function loadCompanyMemory(env: CompanyMemorySeedEnv): CompanyMemoryRepository {
  const directory = loadPeopleDirectory(env);
  const sections = loadSections(env.companyMemorySeedDir);
  const sectionById = new Map(sections.map((s) => [s.id, s]));

  return {
    listSections() {
      return sections.map(({ id, title, sourceRef, updatedAt }) => ({ id, title, sourceRef, updatedAt }));
    },

    searchSections(query, limit) {
      return sections
        .map((s) => ({ s, score: relevance(s.text, s.title, query) }))
        .filter(({ score }) => score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, limit)
        .map(({ s, score }) => ({
          id: s.id,
          title: s.title,
          snippet: snippet(splitPassages(s).map((p) => p.text).join(" "), query),
          score,
          sourceRef: s.sourceRef,
          updatedAt: s.updatedAt,
        }));
    },

    getPassages(sectionId, query, limit) {
      const section = sectionById.get(sectionId);
      if (!section) throw new Error(`章节不存在: ${sectionId}`);
      const passages = splitPassages(section);
      const ranked = query
        ? passages
            .map((p) => ({ p, score: relevance(p.text, section.title, query) }))
            .sort((a, b) => b.score - a.score)
            .map(({ p }) => p)
        : passages;
      return {
        section: { id: section.id, title: section.title, sourceRef: section.sourceRef, updatedAt: section.updatedAt },
        passages: ranked.slice(0, limit).map((p) => ({
          id: p.id,
          text: p.text,
          sourceRef: `${section.sourceRef}#p${p.id.split("#p")[1]}`,
          updatedAt: section.updatedAt,
        })),
      };
    },

    searchPeople: directory.searchPeople,
  };
}
