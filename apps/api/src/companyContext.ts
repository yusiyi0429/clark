import { createCompanyMemory, type CompanyEnv, type CompanyReader, type CompanyViewer, type CompanyView } from "./company.js";
import { loadPeopleDirectory, type PeopleDirectory, type PeopleDirectoryEnv } from "./peopleDirectory.js";

/** Product identities and explicitly authorized company reads remain separate capabilities. */
export type CompanyContext = PeopleDirectory & { company: CompanyReader; companyViewer: CompanyViewer };
export type CompanyContextEnv = PeopleDirectoryEnv & CompanyEnv & { companySystemPersonId?: string; memoryStorageDir?: string };
export function createCompanyContext(env: CompanyContextEnv, company = createCompanyMemory(env)): CompanyContext {
  return { ...loadPeopleDirectory(env), company, companyViewer: { personId: env.companySystemPersonId ?? "", role: "ceo" } };
}

/** Shared background services must have an explicit person grant; the service bearer never grants scope. */
export async function readCompanyContext(context: CompanyContext, query?: string, signal = AbortSignal.timeout(60_000)): Promise<CompanyView> {
  if (!context.companyViewer.personId) return { status: "coverage_unavailable", entries: [], message: "后台公司读取尚未配置明确的人员授权。" };
  const entries: CompanyView["entries"] = [];
  const cursors = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await context.company.read(context.companyViewer, { query, cursor }, signal);
    if (page.status !== "ready" && page.status !== "empty") return { ...page, entries: [] };
    entries.push(...page.entries);
    cursor = page.nextCursor;
    if (cursor && cursors.has(cursor)) return { status: "unavailable", entries: [], message: "公司信息分页不完整。" };
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return { status: entries.length ? "ready" : "empty", entries };
}
export function companyProse(view: CompanyView) {
  return { status: view.status, entries: view.entries.map(({ title, text }) => ({ title, text })), ...(view.message ? { message: view.message } : {}) };
}
