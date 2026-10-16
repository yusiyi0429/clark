import type { WorldEnv, WorldHead } from './worldClient.js';

export type WorldComponent = { text?: string; attributes?: Record<string, unknown> };
export type WorldBlock = { display_name?: string; id: string; text?: string; components?: WorldComponent[]; value?: { text?: string; components?: WorldComponent[] } | null };
export type CompanyWorldObject = {
  business: { object_id: string; domain_id?: string; title: string; object_type: string; version: number; object_version: number; revision_id: string;
    attributes: Record<string, unknown>; blocks: WorldBlock[]; relations: { relation: string; value: unknown }[]; formal?: { lifecycle_status?: string } };
  identity: { responsible?: { principals?: { display_name: string }[] } };
  records: { lifecycle: { status?: string; display_name?: string } | null; latest_state?: unknown; confirmed_review?: unknown };
};

/** Dedicated read-only transport: no action endpoint, arbitrary URL or bearer token reaches the Agent. */
export function createCompanyWorldReader(env: WorldEnv) {
  const base = new URL(env.worldApiUrl!);
  if (!['https:', 'http:'].includes(base.protocol) || base.username || base.password || base.search || base.hash) throw new Error('Invalid World API URL');
  const token = env.worldAgentToken!;
  async function get(path: string, signal: AbortSignal): Promise<any> {
    const response = await fetch(`${base.toString().replace(/\/+$/, '')}${path}`, {
      headers: { authorization: `Bearer ${token}` }, redirect: 'error', signal: AbortSignal.any([signal, AbortSignal.timeout(15000)]),
    });
    if (!response.ok) throw new Error('World read failed');
    const body = await response.text();
    if (body.length > 2_000_000) throw new Error('World response exceeds supported coverage');
    return JSON.parse(body);
  }
  return {
    async list(domain: string, signal: AbortSignal): Promise<WorldHead[]> {
      const heads: WorldHead[] = [];
      let cursor: string | undefined;
      const seen = new Set<string>();
      do {
        const query = new URLSearchParams({ domain_id: domain, limit: '100' });
        if (cursor) query.set('cursor', cursor);
        const page = await get(`/v1/world/objects?${query}`, signal);
        if (!Array.isArray(page.items) || (page.next_cursor !== null && typeof page.next_cursor !== 'string')) throw new Error('Invalid World list');
        for (const head of page.items) {
          if (typeof head.object_id !== 'string' || typeof head.revision_id !== 'string' || !Number.isInteger(head.object_version) || head.domain_id !== domain) throw new Error('Invalid World head or scope');
          // tkos.world/0.3 的列表里混入 StateSnapshot（时间记录，无 business 层）；其内容由业务对象投影的 records.latest_state 携带，这里只投影业务对象。
          if (head.object_type === 'StateSnapshot') continue;
          heads.push(head);
        }
        if (heads.length > 200 || seen.has(page.next_cursor)) throw new Error('World coverage exceeds supported size');
        if (page.next_cursor) seen.add(page.next_cursor);
        cursor = page.next_cursor || undefined;
      } while (cursor);
      return heads;
    },
    async read(id: string, signal: AbortSignal): Promise<CompanyWorldObject> {
      const object = await get(`/v1/world/objects/${encodeURIComponent(id)}`, signal);
      const business = object.business;
      if (!business || business.object_id !== id || typeof business.title !== 'string' || (business.domain_id !== undefined && typeof business.domain_id !== 'string')
        || Buffer.byteLength(JSON.stringify(business.title)) > 1000 || Buffer.byteLength(id) > 200
        || (object.records?.lifecycle && Buffer.byteLength(JSON.stringify(object.records.lifecycle.display_name ?? object.records.lifecycle.status ?? '')) > 500)
        || (business.formal?.lifecycle_status !== undefined && Buffer.byteLength(JSON.stringify(business.formal.lifecycle_status)) > 500)
        || typeof business.revision_id !== 'string' || !Number.isInteger(business.object_version)
        || !business.attributes || !Array.isArray(business.blocks) || !Array.isArray(business.relations)
        || !object.identity || !object.records || !('lifecycle' in object.records)) throw new Error('Invalid World object');
      for (const block of business.blocks) {
        if (!block || typeof block.id !== 'string' || (block.text !== undefined && typeof block.text !== 'string')
          || (block.value !== undefined && block.value !== null && typeof block.value !== 'object')) throw new Error('Invalid World block');
        for (const variant of [block, block.value]) {
          if (!variant) continue;
          if (variant.text !== undefined && typeof variant.text !== 'string') throw new Error('Invalid World text');
          if (variant.components !== undefined && (!Array.isArray(variant.components) || variant.components.some((part: any) => !part || typeof part.text !== 'string'))) throw new Error('Invalid World components');
        }
      }
      return object;
    },
  };
}
