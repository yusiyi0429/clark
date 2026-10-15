import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { worldConfigured, type WorldEnv, type WorldHead } from './worldClient.js';
import { createWorldReader, type CompanyWorldObject, type WorldComponent } from './worldReader.js';

export type CompanyViewer = { personId: string; role: 'ceo' | 'member' };
export type CompanyEntry = { handle: string; title: string; text: string };
export type CompanyView = { status: 'ready' | 'empty' | 'not_configured' | 'coverage_unavailable' | 'unavailable'; entries: CompanyEntry[]; nextCursor?: string; message?: string };
export type CompanyRequest = { query?: string; cursor?: string; handle?: string };
export type CompanyReader = { read(viewer: CompanyViewer, request: CompanyRequest, signal: AbortSignal): Promise<CompanyView> };
export type CompanyEnv = WorldEnv & { companyWorldAccessFile?: string; companyStorageDir?: string };

const dates: Record<string, string> = { period: '周期', start_date: '开始日期', end_date: '结束日期', due_date: '到期日期', deadline: '截止日期', date: '日期' };
const relations: Record<string, string> = { serves: '服务目标', depends_on: '依赖', contributes_to: '贡献于', belongs_to: '归属' };
function businessValues(attributes: Record<string, unknown> = {}): string[] {
  return Object.keys(dates).flatMap((key) => typeof attributes[key] === 'string' || typeof attributes[key] === 'number' ? [`${dates[key]}：${attributes[key]}`] : []);
}
function componentText(component: WorldComponent): string {
  return [component.text ?? '', ...businessValues(component.attributes)].filter(Boolean).join('；');
}
function project(object: CompanyWorldObject, titles: Map<string, string>): CompanyEntry[] {
  const { business, records, identity } = object;
  const status = records.lifecycle?.display_name ?? records.lifecycle?.status ?? business.formal?.lifecycle_status ?? '状态未提供';
  const people = identity.responsible?.principals?.map((person) => person.display_name).filter(Boolean) ?? [];
  const lines = [`## ${business.title}`, `状态：${status}`, ...(people.length ? [`负责人：${people.join('、')}`] : []), ...businessValues(business.attributes)];
  const seen = new Set<string>();
  for (const block of business.blocks) {
    // Canonical value wins; convenience fields supply content only when canonical content is empty.
    const text = block.value?.text || block.text || '';
    const components = block.value?.components?.length ? block.value.components : block.components ?? [];
    const content = [text, ...components.map(componentText)].filter((part) => part.trim() && !seen.has(part) && Boolean(seen.add(part)));
    if (content.length) lines.push(`### ${block.display_name ?? "业务内容"}`, ...content);
  }
  for (const relation of business.relations) {
    const label = relations[relation.relation];
    if (!label) continue;
    for (const ref of Array.isArray(relation.value) ? relation.value : [relation.value]) {
      const title = ref && typeof ref === 'object' ? titles.get(ref.object_id) : undefined;
      if (title) lines.push(`${label}：${title}`);
    }
  }
  // Records are facts only through explicit business text fields; protocol/event envelopes never become prose.
  for (const [label, record] of [['当前进展', records.latest_state], ['已确认复盘', records.confirmed_review]] as const) {
    if (!record || typeof record !== 'object') continue;
    const value = record as Record<string, unknown>;
    const texts = ['text', 'summary', 'result', 'outcome'].flatMap((key) => typeof value[key] === 'string' ? [value[key] as string] : []);
    if (texts.length) lines.push(`### ${label}`, ...texts, ...businessValues(value));
  }
  const text = lines.join('\n\n');
  const chunks = splitProse(text, 4500);
  return chunks.map((body, index) => ({ handle: `company:${encodeURIComponent(business.object_id)}:${index}`, title: business.title, text: body.startsWith('## ') ? body : `## ${business.title}\n\n状态：${status}\n\n${body}` }));
}
/** Keep paragraphs intact where possible, and never split a UTF-8 character. */
function splitProse(text: string, maxBytes: number): string[] {
  const result: string[] = [];
  let chunk = '';
  for (const paragraph of text.split('\n\n')) {
    const joined = chunk ? `${chunk}\n\n${paragraph}` : paragraph;
    if (Buffer.byteLength(joined) <= maxBytes) { chunk = joined; continue; }
    if (chunk) result.push(chunk);
    chunk = '';
    let bytes = 0;
    for (const character of paragraph) {
      const size = Buffer.byteLength(character);
      if (bytes + size > maxBytes) { result.push(chunk); chunk = ''; bytes = 0; }
      chunk += character; bytes += size;
    }
  }
  if (chunk) result.push(chunk);
  return result;
}
function relevantEntries(entries: CompanyEntry[], query?: string): { entries: CompanyEntry[]; fallback: boolean } {
  if (!query?.trim()) return { entries, fallback: false };
  const terms = query.toLocaleLowerCase().match(/[a-z0-9_-]+|[\p{Script=Han}]+/gu) ?? [];
  const tokens = [...new Set(terms.flatMap((term) => /\p{Script=Han}/u.test(term)
    ? Array.from({ length: Math.max(0, term.length - 1) }, (_, i) => term.slice(i, i + 2)) : [term]))];
  const scores = new Map<string, number>();
  const chunkScores = new Map<string, number>();
  for (const entry of entries) {
    const score = tokens.filter((token) => `${entry.title}\n${entry.text}`.toLocaleLowerCase().includes(token)).length;
    chunkScores.set(entry.handle, score);
    scores.set(entry.title, Math.max(scores.get(entry.title) ?? 0, score));
  }
  const matched = entries.filter((entry) => (scores.get(entry.title) ?? 0) > 0);
  return matched.length ? { entries: matched.sort((left, right) => scores.get(right.title)! - scores.get(left.title)! || chunkScores.get(right.handle)! - chunkScores.get(left.handle)!), fallback: false }
    : { entries, fallback: true };
}
function fingerprint(heads: WorldHead[]): string {
  return JSON.stringify(heads.map((head) => [head.object_id, head.revision_id, head.object_version]).sort(([left], [right]) => String(left).localeCompare(String(right))));
}

/** Company is a disposable readable World projection, never a second authority or a World writer. */
export function createCompanyMemory(env: CompanyEnv): CompanyReader {
  let pending = Promise.resolve();
  return {
    async read(viewer, request, signal) {
      if (!worldConfigured(env)) return { status: 'not_configured', entries: [], message: '公司事实读取尚未配置；不能用页面或历史信息代替正式公司事实。' };
      const authorizedDomains = async (): Promise<string[] | null> => {
        try {
          const grants = JSON.parse(await readFile(env.companyWorldAccessFile ?? '', 'utf8')) as Record<string, unknown>;
          const grant = Object.hasOwn(grants, viewer.personId) ? grants[viewer.personId] : undefined;
          if (!Array.isArray(grant) || !grant.length || grant.some((domain) => typeof domain !== 'string' || !domain)) return null;
          return [...new Set(grant)].sort();
        } catch { return null; }
      };
      const unavailableScope: CompanyView = { status: 'coverage_unavailable', entries: [], message: '尚未确定你可读取的 World 公司信息范围，无法据此判断公司事实或公司是否没有对象。' };
      const domains = await authorizedDomains();
      if (!domains) return unavailableScope;
      const run = async (): Promise<CompanyView> => {
        try {
          signal.throwIfAborted();
          if (JSON.stringify(await authorizedDomains()) !== JSON.stringify(domains)) return unavailableScope;
          const reader = createWorldReader(env);
          for (let attempt = 0; attempt < 2; attempt++) {
            const list = async () => (await Promise.all(domains.map((domain) => reader.list(domain, signal)))).flat();
            const heads = await list();
            if (new Set(heads.map((head) => head.object_id)).size !== heads.length) throw new Error('Duplicate World objects');
            const objects: CompanyWorldObject[] = [];
            for (const head of heads) {
              const object = await reader.read(head.object_id, signal);
              if ((object.business.domain_id !== undefined && object.business.domain_id !== head.domain_id) || object.business.revision_id !== head.revision_id || object.business.object_version !== head.object_version) break;
              objects.push(object);
            }
            if (objects.length !== heads.length || fingerprint(await list()) !== fingerprint(heads)) continue;
            if (JSON.stringify(await authorizedDomains()) !== JSON.stringify(domains)) return unavailableScope;
            const titles = new Map(objects.map((object) => [object.business.object_id, object.business.title]));
            const entries = objects.flatMap((object) => project(object, titles));
            const markdown = `# Company\n\n${entries.map((entry) => entry.text).join('\n\n')}`;
            if (markdown.length > 1_000_000) throw new Error('Company coverage exceeds supported size');
            const scope = createHash('sha256').update(JSON.stringify([env.worldApiUrl, domains])).digest('hex');
            const root = join(env.companyStorageDir ?? '/tmp/warmap-company', scope);
            let unchanged = false;
            try {
              const current = JSON.parse(await readFile(join(root, 'current.json'), 'utf8')) as { generation: string };
              if (/^[a-f0-9-]{36}$/.test(current.generation)) {
                const directory = join(root, 'generations', current.generation);
                const state = JSON.parse(await readFile(join(directory, 'state.json'), 'utf8')) as { heads: WorldHead[] };
                unchanged = fingerprint(state.heads) === fingerprint(heads) && await readFile(join(directory, 'Company.md'), 'utf8') === markdown;
              }
            } catch { /* Missing/corrupt projections are rebuilt exclusively from the fresh authorized World read above. */ }
            if (!unchanged) {
              const generation = randomUUID();
              const dir = join(root, 'generations', generation);
              await mkdir(dir, { recursive: true, mode: 0o700 });
              await writeFile(join(dir, 'Company.md'), markdown, { encoding: 'utf8', mode: 0o600 });
              await writeFile(join(dir, 'state.json'), JSON.stringify({ domains, heads, checkedAt: new Date().toISOString() }), { encoding: 'utf8', mode: 0o600 });
              signal.throwIfAborted();
              if (JSON.stringify(await authorizedDomains()) !== JSON.stringify(domains)) return unavailableScope;
              const pointer = join(root, `${generation}.tmp`);
              await writeFile(pointer, JSON.stringify({ generation }), { encoding: 'utf8', mode: 0o600 });
              await rename(pointer, join(root, 'current.json'));
            }
            // Even an unchanged generation must not be consumed after access was revoked while comparing artifacts.
            if (JSON.stringify(await authorizedDomains()) !== JSON.stringify(domains)) return unavailableScope;
            const ranked = relevantEntries(entries, request.query);
            const filtered = ranked.entries.filter((entry) => !request.handle || entry.handle === request.handle);
            const cursor = request.cursor === undefined ? 0 : Number(request.cursor);
            if (!Number.isSafeInteger(cursor) || cursor < 0) return { status: 'unavailable', entries: [], message: '无效的 Company 分页位置。' };
            const page: CompanyEntry[] = [];
            let size = 0;
            for (const entry of filtered.slice(cursor)) {
              if (page.length && size + Buffer.byteLength(JSON.stringify(entry)) > 7000) break;
              page.push(entry); size += Buffer.byteLength(JSON.stringify(entry));
              if (page.length >= 8) break;
            }
            return { status: heads.length ? 'ready' : 'empty', entries: page, ...(cursor + page.length < filtered.length ? { nextCursor: String(cursor + page.length) } : {}),
              ...(ranked.fallback ? { message: '未精确匹配关键词；以下为授权范围的有界目录及正文，请按标题继续定位。' } : {}) };
          }
          return { status: 'unavailable', entries: [], message: '读取期间公司信息发生变化，本次未发布或使用不完整的公司记忆。请重试。' };
        } catch {
          return { status: 'unavailable', entries: [], message: 'World 公司信息暂时不可用；未使用旧记忆或本地信息补充正式事实。' };
        }
      };
      // One publication at a time in this single API process; no multi-instance writer claim.
      const work = pending.then(run, run);
      pending = work.then(() => undefined, () => undefined);
      return work;
    },
  };
}
