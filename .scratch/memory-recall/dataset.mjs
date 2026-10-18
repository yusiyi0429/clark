// 组装评测用记忆库与按规模抽样的候选池。
import { existsSync, readFileSync } from 'node:fs';
import { TARGETS } from './data/targets.mjs';
import { QUERIES as LABELED } from './data/queries.mjs';

const fillers = JSON.parse(readFileSync(new URL('./data/fillers.json', import.meta.url), 'utf8'));

export const ITEMS = [
  ...TARGETS.map(([id, date, kind, anchor, title, text, status, supersededBy]) => ({ id, kind, title, text, createdAt: `${date}T10:00:00.000Z`, anchors: [{ target: anchor }],
    status: status ?? 'active', supersededBy: supersededBy ?? null })),
  ...fillers.map((item) => ({ id: item.id, kind: item.kind, title: item.title, text: item.text, createdAt: `${item.date}T10:00:00.000Z`, anchors: [{ target: item.anchor }],
    status: 'active', supersededBy: null })),
];
/** 大规模测试的追加条目（gen-padding.mjs），只在规模超过 300 时进候选池。 */
const PADDING_FILE = new URL('./data/padding.json', import.meta.url);
export const PADDING = existsSync(PADDING_FILE) ? JSON.parse(readFileSync(PADDING_FILE, 'utf8')).map((item) => ({ id: item.id, kind: item.kind, title: item.title, text: item.text,
  createdAt: `${item.date}T10:00:00.000Z`, anchors: [{ target: item.anchor ?? 'topic:其他' }], status: 'active', supersededBy: null })) : [];
export const BY_ID = new Map([...ITEMS, ...PADDING].map((item) => [item.id, item]));
/** 现行条目（生产上只有 active 进候选）。 */
export const ACTIVE = ITEMS.filter((item) => item.status === 'active');
export const CORE = new Set(ACTIVE.filter((item) => item.kind === 'preference').map((item) => item.id));
/** 参与检索的现行条目：偏好类常驻、不参与检索。 */
export const RETRIEVABLE = ACTIVE.filter((item) => !CORE.has(item.id));

// 补标注（adjudicate.mjs 的强模型判断，人工复核过）：各方案选过、判为相关（≥1）的条目并入 related，只影响精确率；gold 不动。
const ADJUDICATION_FILE = new URL('./data/adjudication.json', import.meta.url);
const adjudication = existsSync(ADJUDICATION_FILE) ? JSON.parse(readFileSync(ADJUDICATION_FILE, 'utf8')) : {};
export const QUERIES = LABELED.map((query) => {
  const judged = Object.entries(adjudication[query.id] ?? {}).filter(([id, score]) => score >= 1 && !query.gold.includes(id)).map(([id]) => id);
  return { ...query, related: [...new Set([...(query.related ?? []), ...judged])] };
});

for (const query of QUERIES) {
  for (const id of [...query.gold, ...(query.related ?? []), ...Object.keys(query.stale ?? {}), ...Object.values(query.stale ?? {})]) {
    if (!BY_ID.has(id)) throw new Error(`${query.id} 引用了不存在的条目 ${id}`);
    if (BY_ID.get(id).status !== 'active' && query.gold.includes(id)) throw new Error(`${query.id} 的 gold ${id} 不是现行条目`);
  }
}

/** 可复现的伪随机。 */
function rng(seed) {
  let state = seed >>> 0;
  return () => { state = (state * 1664525 + 1013904223) >>> 0; return state / 2 ** 32; };
}
const hash = (text) => [...text].reduce((value, ch) => (value * 31 + ch.codePointAt(0)) >>> 0, 7);

/**
 * 某条查询在规模 n（可检索条目数）下的候选池：必含 gold 与 stale 两边，其余从剩下的现行条目里按固定种子抽，凑到 n 条；
 * 偏好类全部带上（常驻）。n 大于等于全部时就是全量。额外的 padding（大规模测试用）追加在后面。
 */
export function poolFor(query, n, padding = []) {
  const universe = [...RETRIEVABLE, ...padding];
  if (n >= universe.length) return [...universe, ...ACTIVE.filter((item) => CORE.has(item.id))];
  const must = new Set([...query.gold, ...Object.keys(query.stale ?? {}), ...Object.values(query.stale ?? {})]);
  const rest = universe.filter((item) => !must.has(item.id));
  const random = rng(hash(`${query.id}:${n}`));
  for (let index = rest.length - 1; index > 0; index--) { const swap = Math.floor(random() * (index + 1)); [rest[index], rest[swap]] = [rest[swap], rest[index]]; }
  const chosen = [...universe.filter((item) => must.has(item.id)), ...rest.slice(0, Math.max(0, n - must.size))];
  // 按时间倒序（与生产 list 一致）
  chosen.sort((left, right) => right.createdAt.localeCompare(left.createdAt) || left.id.localeCompare(right.id));
  return [...chosen, ...ACTIVE.filter((item) => CORE.has(item.id))];
}
