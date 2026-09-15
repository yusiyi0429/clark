export type CardReference = { id: string; title: string; kind: string; content: string; source: string };
export type SelectedReference = CardReference & { capturedAt: string };
export const MAX_REFERENCES = 16;
export function cardReference(id: string, title: string, kind: string, content: unknown, source = '交互原型 · 演练材料，非公司生效记录'): CardReference {
  return { id, title, kind, content: typeof content === 'string' ? content : JSON.stringify(content, null, 2), source };
}
export function validReferences(value: unknown): value is SelectedReference[] {
  return Array.isArray(value) && value.length <= MAX_REFERENCES && value.every(item =>
    item && typeof item === 'object' && ['id', 'title', 'kind', 'content', 'source', 'capturedAt'].every(key => typeof item[key] === 'string') &&
    item.id.length > 0 && item.id.length <= 150 && item.title.length > 0 && item.title.length <= 350 &&
    item.kind.length <= 60 && item.content.length <= 8_000 && item.source.length <= 1_000 && Number.isFinite(Date.parse(item.capturedAt))) &&
    new Set(value.map(item => item.id)).size === value.length && value.reduce((sum, item) => sum + item.content.length, 0) <= 64_000;
}
