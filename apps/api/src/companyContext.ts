import { createCompanyMemory, type CompanyEnv, type CompanyReader, type CompanyViewer, type CompanyView } from "./company.js";

/** 后台服务（雷达、预审、预研、月度起草与复盘、任务卡起草）读公司事实的入口：只读本体投影，人员身份另走 PeopleDirectory。 */
export type CompanyContext = { company: CompanyReader; companyViewer: CompanyViewer };
export type CompanyContextEnv = CompanyEnv & { companySystemPersonId?: string };
export function createCompanyContext(env: CompanyContextEnv, company: CompanyReader = createCompanyMemory(env)): CompanyContext {
  return { company, companyViewer: { personId: env.companySystemPersonId ?? "", role: "ceo" } };
}

/** 后台读取必须有明确的人员授权（COMPANY_SYSTEM_PERSON_ID 在 COMPANY_WORLD_ACCESS_FILE 里有域）；服务凭据本身不授予范围。只读一页，有界。 */
export async function readCompanyContext(context: CompanyContext, query?: string, signal: AbortSignal = AbortSignal.timeout(60_000)): Promise<CompanyView> {
  if (!context.companyViewer.personId) return { status: "coverage_unavailable", entries: [], message: "后台读取本体公司事实还没有配置授权人员，这次没有读到本体。" };
  return context.company.read(context.companyViewer, { query }, signal);
}

/** 交给模型的公司事实：只有标题与正文，加读取状态；不是 ready 时 message 说明没读到的原因。 */
export function companyProse(view: CompanyView) {
  return { status: view.status, entries: view.entries.map(({ title, text }) => ({ title, text })), ...(view.message ? { message: view.message } : {}),
    ...(view.nextCursor ? { more: true } : {}) };
}
