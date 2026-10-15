import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { Value } from "@sinclair/typebox/value";
import {
  CompanyPeopleSeed,
  type TCompanyPeopleSeed,
  type TPersonResult,
  type TSectionMatch,
  type TSectionSummary,
} from "@warmap/contracts";

export type MemorySection = TSectionSummary & { text: string };
export type MemoryPerson = TPersonResult;

export type CompanyMemoryRepository = {
  listSections(): TSectionSummary[];
  searchSections(query: string, limit: number): TSectionMatch[];
  getPassages(sectionId: string, query: string | undefined, limit: number): {
    section: TSectionSummary;
    passages: { id: string; text: string; sourceRef: string; updatedAt: string }[];
  };
  searchPeople(query: string | undefined): TPersonResult[];
};

export type CompanyMemorySeedEnv = {
  companyMemorySeedDir: string;
  companyPeopleSeed: string;
};

function firstErrors(schema: Parameters<typeof Value.Check>[0], value: unknown): string {
  return [...Value.Errors(schema, value)]
    .slice(0, 3)
    .map((e) => `${e.path || "/"} ${e.message}`)
    .join("; ");
}

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

export function loadPeople(seedPath: string): MemoryPerson[] {
  if (!existsSync(seedPath)) {
    throw new Error(`CompanyMemory 人员 seed 不存在: ${seedPath}（不虚构人员，启动失败）`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(seedPath, "utf8"));
  } catch (err) {
    throw new Error(`CompanyMemory 人员 seed 不是合法 JSON: ${seedPath}: ${(err as Error).message}`);
  }
  if (!Value.Check(CompanyPeopleSeed, raw)) {
    throw new Error(`CompanyMemory 人员 seed 不符合 company-people.v1: ${seedPath}: ${firstErrors(CompanyPeopleSeed, raw)}`);
  }
  const updatedAt = statSync(seedPath).mtime.toISOString();
  const people = (raw as TCompanyPeopleSeed).people.map((p): MemoryPerson => ({
    personId: p.personId,
    displayName: p.displayName,
    roles: [...p.roles],
    sourceRef: `${seedPath}#${p.personId}`,
    updatedAt,
  }));
  const seen = new Set<string>();
  for (const person of people) {
    if (seen.has(person.personId)) {
      throw new Error(`CompanyMemory 人员 seed 存在重复 personId: ${person.personId}`);
    }
    seen.add(person.personId);
  }
  return people;
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
  const people = loadPeople(env.companyPeopleSeed);
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

    searchPeople(query) {
      const needle = query?.trim().toLowerCase();
      const matched = needle ? people.filter((p) => p.displayName.toLowerCase().includes(needle)) : people;
      return matched.map((p) => ({ ...p }));
    },
  };
}

/** 括号里装着链接、wiki / docx 标识、revision 等后台信息的整段括注（一号位看不懂，也不该看到）。 */
const TECH_PAREN_RE = /[（(][^（）()]*(?:https?:\/\/|wiki\s|docx\s|revision\s)[^（）()]*[）)]/gi;
/** 正文里的裸链接（飞书 wiki / 妙记地址）。 */
const URL_RE = /[ \t]*https?:\/\/[^\s）)」』，,；;]+/g;
/** 资料文件全名《业务视角_TKOS_Inception_集团经营上下文与指标定义_v1.0_2026-10-10》→《集团经营上下文与指标定义》：去掉前缀段、版本和日期。 */
const FILE_TITLE_RE = /《(?:业务视角|TKOS|Inception|_)+_([^《》]+?)(?:_v\d+(?:\.\d+)*)?(?:_\d{4}-\d{2}-\d{2})?》/g;
/** 给人看的企业知识正文：去掉后台标识括注和链接，资料文件全名换成短名，其他原样保留。 */
export function plainKnowledgeText(text: string): string {
  return text.replace(TECH_PAREN_RE, "").replace(URL_RE, "").replace(FILE_TITLE_RE, "《$1》").replace(/[ \t]+\n/g, "\n");
}
