import { join } from "node:path";
import { createCompanyMemory, type CompanyEnv, type CompanyReader, type CompanyViewer, type CompanyView } from "./company.js";
import { loadPeopleDirectory, type PeopleDirectory, type PeopleDirectoryEnv } from "./peopleDirectory.js";

/** Product identities and explicitly authorized company reads remain separate capabilities. */
export type CompanyContext = PeopleDirectory & { company: CompanyReader; companyViewer: CompanyViewer };
export type CompanyContextEnv = PeopleDirectoryEnv & CompanyEnv & { companySystemPersonId?: string; memoryStorageDir?: string };
export function createCompanyContext(env: CompanyContextEnv, company = createCompanyMemory({ ...env, ...(env.memoryStorageDir && !env.companyStorageDir ? { companyStorageDir: join(env.memoryStorageDir, "company") } : {}) })): CompanyContext {
  return { ...loadPeopleDirectory(env), company, companyViewer: { personId: env.companySystemPersonId ?? "", role: "ceo" } };
}

/** Shared background services must have an explicit person grant; the service bearer never grants scope. */
export async function readCompanyContext(context: CompanyContext, query?: string, signal = AbortSignal.timeout(60_000), cursor?: string): Promise<CompanyView> {
  if (!context.companyViewer.personId) return { status: "coverage_unavailable", entries: [], message: "后台公司读取尚未配置明确的人员授权。" };
  return context.company.read(context.companyViewer, { query, cursor }, signal);
}
export function companyProse(view: CompanyView) {
  return { status: view.status, entries: view.entries.map(({ title, text }) => ({ title, text })), ...(view.message ? { message: view.message } : {}), ...(view.nextCursor ? { more: true, message: [view.message, "当前为有界参考，仍有未读正文；可通过 query_company 继续定位。"].filter(Boolean).join(" ") } : {}) };
}
