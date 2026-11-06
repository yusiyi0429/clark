import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { worldConfigured, type WorldEnv, type WorldHead } from './worldClient.js';
import { logEvent } from './observability.js';
import { companyPeriod } from './monthlyPlans.js';
import { createCompanyWorldReader, type CompanyWorldObject, type WorldBlock, type WorldComponent } from './companyWorld.js';

export type CompanyViewer = { personId: string; role: 'ceo' | 'member' };
/** ref 是本体对象的 `<object_id>@<version>`（与 worldRef 同一写法），type 是对象类型；答案要带出处时原样引用。 */
export type CompanyEntry = { handle: string; ref: string; type: string; title: string; text: string };
export type CompanyView = { status: 'ready' | 'empty' | 'not_configured' | 'coverage_unavailable' | 'unavailable'; entries: CompanyEntry[]; nextCursor?: string; message?: string };
/** locate：先按类型、周期和标题定位，只读定位到的对象（伙伴对话用）；不开时照旧全量读后按正文排序（后台作业的检索词常带人名，人名只在正文里）。 */
export type CompanyRequest = { query?: string; cursor?: string; handle?: string; locate?: boolean };
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
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const STATE_TEXT_MAX = 400;
const STATE_LINES_MAX = 12;
/**
 * 进展记录（latest_state、confirmed_review）的正文。0.3 起它是一份 StateSnapshot：标一行快照编号、日期、谁记的、是否未确认，
 * 再取各块的正文和组件正文（每条最多 400 字、最多 12 条）；旧数据直接带 text / summary / result / outcome 的照旧取。
 */
function recordLines(record: unknown): string[] {
  if (!record || typeof record !== 'object') return [];
  const value = record as Record<string, unknown>;
  const lines = ['text', 'summary', 'result', 'outcome'].flatMap((key) => typeof value[key] === 'string' && value[key] ? [value[key] as string] : []);
  for (const block of Array.isArray(value.blocks) ? value.blocks as WorldBlock[] : []) {
    const text = block?.value?.text || block?.text || '';
    const components = block?.value?.components?.length ? block.value.components : block?.components ?? [];
    const parts = [text, ...components.map((part) => (typeof part?.text === 'string' ? part.text : ''))].filter((part) => part.trim());
    const label = block?.display_name;
    lines.push(...parts.map((part, index) => clip(index === 0 && text && label && !part.startsWith(label) ? `${label}：${part}` : part, STATE_TEXT_MAX)));
  }
  if (!lines.length) return [];
  const ref = typeof value.ref === 'string' ? value.ref : null;
  const asOf = typeof value.as_of === 'string' ? value.as_of.slice(0, 10) : null;
  const by = value.generator && typeof value.generator === 'object' ? (value.generator as { display_name?: unknown }).display_name : undefined;
  const header = [ref && `快照 ${ref}`, asOf, typeof by === 'string' && by, value.unconfirmed === true && '未确认'].filter(Boolean).join(' · ');
  return [...(header ? [header] : []), ...lines.slice(0, STATE_LINES_MAX), ...businessValues(value)];
}
/** 已授权范围里的对象头（标题、ref）；关系只展开到这里面的对象，读不到的目标不透露。 */
type HeadIndex = Map<string, { title: string; ref: string }>;
const headIndex = (heads: WorldHead[]): HeadIndex => new Map(heads.map((head) => [head.object_id, { title: head.title, ref: `${head.object_id}@${head.version}` }]));

function project(object: CompanyWorldObject, titles: HeadIndex): CompanyEntry[] {
  const { business, records, identity } = object;
  const status = records.lifecycle?.display_name ?? records.lifecycle?.status ?? business.formal?.lifecycle_status ?? '状态未提供';
  const people = identity.responsible?.principals?.map((person) => person.display_name).filter(Boolean) ?? [];
  const ref = `${business.object_id}@${business.version}`;
  const lines = [`## ${business.title}`, `状态：${status}`, ...(people.length ? [`负责人：${people.join('、')}`] : []), ...businessValues(business.attributes)];
  // 进展放在定义前面：问「怎么样了」时第一页就能读到。
  for (const [label, record] of [['当前进展', records.latest_state], ['已确认复盘', records.confirmed_review]] as const) {
    const recorded = recordLines(record);
    if (recorded.length) lines.push(`### ${label}`, ...recorded);
  }
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
    for (const target of Array.isArray(relation.value) ? relation.value : [relation.value]) {
      const head = target && typeof target === 'object' ? titles.get(target.object_id) : undefined;
      if (head) lines.push(`${label}：${head.title}（${head.ref}）`);
    }
  }
  const text = lines.join('\n\n');
  const chunks = splitProse(text, 4000);
  const version = createHash('sha256').update(JSON.stringify([business.revision_id, business.object_version, text])).digest('base64url').slice(0, 16);
  return chunks.map((body, index) => ({ handle: `company:${encodeURIComponent(business.object_id)}:${version}:${index}`, ref, type: business.object_type, title: business.title,
    text: body.startsWith('## ') ? body : `## ${business.title}\n\n状态：${status}\n\n${body}` }));
}
/** Keep paragraphs intact where possible, and never split a UTF-8 character. */
function splitProse(text: string, maxBytes: number): string[] {
  const result: string[] = [];
  let chunk = '';
  for (const paragraph of text.split('\n\n')) {
    const joined = chunk ? `${chunk}\n\n${paragraph}` : paragraph;
    if (Buffer.byteLength(JSON.stringify(joined)) - 2 <= maxBytes) { chunk = joined; continue; }
    if (chunk) result.push(chunk);
    chunk = '';
    let bytes = 0;
    for (const character of paragraph) {
      const size = Buffer.byteLength(JSON.stringify(character)) - 2;
      if (bytes + size > maxBytes) { result.push(chunk); chunk = ''; bytes = 0; }
      chunk += character; bytes += size;
    }
  }
  if (chunk) result.push(chunk);
  return result;
}
/**
 * 检索词：转小写，拉丁字母和数字按词切，汉字段切成二元组，单字汉字段保留为一个词；去重。其余字符（空白、标点）都当分隔。
 * 公司事实检索和确认会议检索（meetingCardRead）共用。
 */
export function queryTokens(query: string): string[] {
  const terms = query.toLocaleLowerCase().match(/[a-z0-9_-]+|[\p{Script=Han}]+/gu) ?? [];
  return [...new Set(terms.flatMap((term) => /\p{Script=Han}/u.test(term) && term.length > 1
    ? Array.from({ length: term.length - 1 }, (_, i) => term.slice(i, i + 2)) : [term]))];
}
function relevantEntries(entries: CompanyEntry[], query?: string): { entries: CompanyEntry[]; fallback: boolean } {
  if (!query?.trim()) return { entries, fallback: false };
  // 公司事实检索照旧不用单字汉字。
  const tokens = queryTokens(query).filter((token) => !(token.length === 1 && /\p{Script=Han}/u.test(token)));
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
/**
 * 先定位再读（11/06「答案带出处」）：问话里认得出的对象类型和周期。认出类型时只在这些类型里按标题找（找不到再放开）；
 * 认出周期时先让本体按周期筛（筛空就不按周期）。
 */
const TYPE_HINTS: [RegExp, string][] = [
  [/战略/, 'Strategy'],
  [/愿景|使命|公司的?(?:定位|简介)/, 'Company'],
  [/长期目标|六个月目标|半年目标/, 'LongTermGoal'],
  [/(?:本|这个|当|上个?|下个?|\d{1,2}\s*)月(?:的|份)?目标|周期目标|本期目标|月度目标/, 'PeriodGoal'],
  [/mission|任务卡/i, 'Mission'],
  [/\btasks?\b/i, 'Task'],
  [/责任单元/, 'ResponsibilityUnit'],
];
export function locateHints(query: string, now: Date): { types: string[]; period?: string } {
  const types = TYPE_HINTS.flatMap(([pattern, type]) => (pattern.test(query) ? [type] : []));
  const current = companyPeriod(now);
  const [year, month] = current.split('-').map(Number);
  const shift = (delta: number) => { const date = new Date(Date.UTC(year, month - 1 + delta, 1)); return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`; };
  if (/本月|这个月|当月/.test(query)) return { types, period: current };
  if (/上个?月/.test(query)) return { types, period: shift(-1) };
  if (/下个?月/.test(query)) return { types, period: shift(1) };
  // 「10 月」「2026 年 10 月」；「六个月」「3 个月」这类时长不算。没写年取离现在最近的那一年。
  const named = /(?:(\d{4})\s*年\s*)?(\d{1,2})\s*月/.exec(query);
  const asked = named ? Number(named[2]) : 0;
  if (asked >= 1 && asked <= 12) {
    const askedYear = named![1] ? Number(named![1]) : asked - month > 6 ? year - 1 : month - asked > 6 ? year + 1 : year;
    return { types, period: `${askedYear}-${String(asked).padStart(2, '0')}` };
  }
  return { types };
}
/** 一次最多读几个对象；定位到的超过这个数只读标题最贴的几个。 */
const LOCATE_MAX = 6;
/** 一页最多多少字节（条目的 JSON）：全量读 7000；定位读只有几个对象，放宽到 12000，第一页放得下两三个对象的开头。 */
const PAGE_BYTES = 7000;
export const LOCATED_PAGE_BYTES = 12000;
/**
 * 按标题挑对象头：问话检索词（同 query_company，不用单字汉字）在标题里命中几个就是几分。
 * 有类型提示且这些类型里有命中的，只在这些类型里挑；只留分数不低于最高分一半的，最多 LOCATE_MAX 个。
 * 一个都没命中时：有类型提示且这类对象不多于 LOCATE_MAX 个就全读（如「战略是什么」）；否则返回空，调用方走全量读。
 */
export function locateHeads(heads: WorldHead[], query: string, types: string[]): WorldHead[] {
  const tokens = queryTokens(query).filter((token) => !(token.length === 1 && /\p{Script=Han}/u.test(token)));
  const scored = heads.map((head) => ({ head, score: tokens.filter((token) => head.title.toLocaleLowerCase().includes(token)).length }));
  const hits = scored.filter((item) => item.score > 0);
  const typedHits = hits.filter((item) => types.includes(item.head.object_type));
  const pool = typedHits.length ? typedHits : hits;
  if (pool.length) {
    const top = Math.max(...pool.map((item) => item.score));
    return pool.filter((item) => item.score * 2 >= top).sort((left, right) => right.score - left.score).slice(0, LOCATE_MAX).map((item) => item.head);
  }
  const typed = heads.filter((head) => types.includes(head.object_type));
  return typed.length <= LOCATE_MAX ? typed : [];
}
function fingerprint(heads: WorldHead[]): string {
  return JSON.stringify(heads.map((head) => [head.object_id, head.revision_id, head.object_version]).sort(([left], [right]) => String(left).localeCompare(String(right))));
}

/** 读不到本体时附在 message 里的说明（2026-10-19 D-48，取代 10/16 的「再用本地资料作答」）：公司事实不兜底；天枢自己的业务数据照常可用。 */
const NOT_READ = '这次没有读到本体：不能据此判断本体里有没有，也不要用本地资料补公司事实；Mission、执行事项、会议、复盘、材料这些天枢自己的业务数据照常可用。';

/**
 * Company is a disposable readable World projection, never a second authority or a World writer.
 * 读不到（not_configured / coverage_unavailable / unavailable）与「本体里确实没有」（empty）分开报告；读不到时同时记一条日志。
 */
export function createCompanyMemory(env: CompanyEnv): CompanyReader {
  let pending = Promise.resolve();
  return {
    async read(viewer, request, signal) {
      if (!worldConfigured(env)) return { status: 'not_configured', entries: [], message: `本体公司事实读取尚未配置。${NOT_READ}` };
      const authorizedDomains = async (): Promise<string[] | null> => {
        try {
          const grants = JSON.parse(await readFile(env.companyWorldAccessFile ?? '', 'utf8')) as Record<string, unknown>;
          const grant = Object.hasOwn(grants, viewer.personId) ? grants[viewer.personId] : undefined;
          if (!Array.isArray(grant) || !grant.length || grant.some((domain) => typeof domain !== 'string' || !domain)) return null;
          return [...new Set(grant)].sort();
        } catch { return null; }
      };
      const unavailableScope: CompanyView = { status: 'coverage_unavailable', entries: [], message: `尚未确定你可读取的本体公司信息范围。${NOT_READ}` };
      const domains = await authorizedDomains();
      if (!domains) {
        logEvent({ event: 'company.world_unavailable', status: 'coverage_unavailable', errorCode: 'NO_DOMAIN_GRANT', hasQuery: Boolean(request.query) });
        return unavailableScope;
      }
      const run = async (): Promise<CompanyView> => {
        try {
          signal.throwIfAborted();
          if (JSON.stringify(await authorizedDomains()) !== JSON.stringify(domains)) return unavailableScope;
          const reader = createCompanyWorldReader(env);
          const started = Date.now();
          const scope = createHash('sha256').update(JSON.stringify([env.worldApiUrl, domains])).digest('hex');
          const list = async (filters: { period?: string } = {}) => {
            const heads = (await Promise.all(domains.map((domain) => reader.list(domain, signal, filters)))).flat();
            if (new Set(heads.map((head) => head.object_id)).size !== heads.length) throw new Error('Duplicate World objects');
            return heads;
          };
          /** 逐个读（串行）；读到的版本和列表里的对不上（读的时候改了）返回 null。 */
          const readAll = async (heads: WorldHead[]): Promise<CompanyWorldObject[] | null> => {
            const objects: CompanyWorldObject[] = [];
            for (const head of heads) {
              const object = await reader.read(head.object_id, signal);
              if ((object.business.domain_id !== undefined && object.business.domain_id !== head.domain_id) || object.business.revision_id !== head.revision_id || object.business.object_version !== head.object_version) return null;
              objects.push(object);
            }
            return objects;
          };
          const pageOf = (entries: CompanyEntry[], heads: WorldHead[], markdown: string, fallback: boolean, budget: number): CompanyView => {
            const filtered = entries.filter((entry) => !request.handle || entry.handle === request.handle);
            if (request.handle && !filtered.length) return { status: 'unavailable', entries: [], message: '公司参考已变化、删除或不可见，请重新查询。' };
            const version = createHash('sha256').update(JSON.stringify([viewer.personId, scope, fingerprint(heads), markdown, request.query ?? ''])).digest('base64url');
            let cursor = 0;
            if (request.cursor !== undefined) {
              try {
                const continuation = JSON.parse(Buffer.from(request.cursor, 'base64url').toString('utf8')) as { offset: number; version: string };
                if (continuation.version !== version || !Number.isSafeInteger(continuation.offset) || continuation.offset < 0) throw new Error('Stale cursor');
                cursor = continuation.offset;
              } catch { return { status: 'unavailable', entries: [], message: '公司信息、可见范围或检索条件已变化，请重新开始查询。' }; }
            }
            const page: CompanyEntry[] = [];
            let size = 0;
            for (const entry of filtered.slice(cursor)) {
              if (page.length && size + Buffer.byteLength(JSON.stringify(entry)) > budget) break;
              page.push(entry); size += Buffer.byteLength(JSON.stringify(entry));
              if (page.length >= 8) break;
            }
            if (!heads.length) return { status: 'empty', entries: [], message: '读到了本体：你被授权的范围里确实没有公司对象。' };
            return { status: 'ready', entries: page, ...(cursor + page.length < filtered.length ? { nextCursor: Buffer.from(JSON.stringify({ offset: cursor + page.length, version })).toString('base64url') } : {}),
              ...(fallback ? { message: '未精确匹配关键词；以下为授权范围的有界目录及正文，请按标题继续定位。' } : {}) };
          };
          // 先定位：按本人授权的域列对象头（问到周期时让本体按周期筛），按类型和标题挑出几个再读；定位不到或读的时候变了，走下面的全量读。
          let listed: WorldHead[] | undefined;
          if (request.locate && request.query?.trim() && !request.handle) {
            const hints = locateHints(request.query, new Date());
            listed = await list();
            const inPeriod = hints.period ? await list({ period: hints.period }) : [];
            let picked = inPeriod.length ? locateHeads(inPeriod, request.query, hints.types) : [];
            if (!picked.length) picked = locateHeads(listed, request.query, hints.types);
            const objects = picked.length ? await readAll(picked) : null;
            if (objects) {
              if (JSON.stringify(await authorizedDomains()) !== JSON.stringify(domains)) return unavailableScope;
              const titles = headIndex([...listed, ...inPeriod]);
              // 各对象轮流放：先放每个对象的第一段（标题、状态、当前进展），再放第二段……第一页就能看到每个定位到的对象。
              const chunks = objects.map((object) => project(object, titles));
              const entries = Array.from({ length: Math.max(...chunks.map((list) => list.length)) }, (_, index) => chunks.flatMap((list) => list[index] ?? [])).flat();
              logEvent({ event: 'company.world_read', mode: 'located', listed: listed.length, read: objects.length, types: hints.types, period: hints.period ?? null, durationMs: Date.now() - started });
              return pageOf(entries, picked, entries.map((entry) => entry.text).join('\n\n'), false, LOCATED_PAGE_BYTES);
            }
          }
          for (let attempt = 0; attempt < 2; attempt++) {
            const heads = attempt === 0 && listed ? listed : await list();
            const objects = await readAll(heads);
            if (!objects || fingerprint(await list()) !== fingerprint(heads)) continue;
            if (JSON.stringify(await authorizedDomains()) !== JSON.stringify(domains)) return unavailableScope;
            const titles = headIndex(heads);
            const entries = objects.flatMap((object) => project(object, titles));
            const markdown = `# Company\n\n${entries.map((entry) => entry.text).join('\n\n')}`;
            if (markdown.length > 1_000_000) throw new Error('Company coverage exceeds supported size');
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
            logEvent({ event: 'company.world_read', mode: 'full', listed: heads.length, read: objects.length, durationMs: Date.now() - started });
            return pageOf(ranked.entries, heads, markdown, ranked.fallback, PAGE_BYTES);
          }
          logEvent({ event: 'company.world_unavailable', status: 'unavailable', errorCode: 'WORLD_CHANGED_DURING_READ', domains: domains.length });
          return { status: 'unavailable', entries: [], message: `读取期间本体公司信息发生变化，请重试。${NOT_READ}` };
        } catch (error) {
          logEvent({ event: 'company.world_unavailable', status: 'unavailable', errorCode: signal.aborted ? 'ABORTED' : 'WORLD_READ_FAILED',
            error: (error as Error)?.message, domains: domains.length });
          return { status: 'unavailable', entries: [], message: `本体公司信息暂时读不到。${NOT_READ}` };
        }
      };
      // One publication at a time in this single API process; no multi-instance writer claim.
      const work = pending.then(run, run);
      pending = work.then(() => undefined, () => undefined);
      return work;
    },
  };
}
