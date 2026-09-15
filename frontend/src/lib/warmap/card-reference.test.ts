import { describe, expect, it } from 'vitest';
import { cardReference, validReferences } from './card-reference';

const item = { ...cardReference('issue:one', '交付优先级', '议题', '灯塔优先；仍待确认。'), capturedAt: '2026-09-11T08:00:00Z' };
describe('manual card references', () => {
  it('keeps content and source distinct from the title and allows multiple distinct cards', () => {
    expect(validReferences([item, { ...item, id: 'issue:two' }])).toBe(true);
    expect(item.content).toContain('待确认');
    expect(item.source).toContain('非公司生效记录');
  });
  it('rejects duplicates, malformed values, excessive content and excessive count', () => {
    expect(validReferences([item, item])).toBe(false);
    expect(validReferences([{ ...item, capturedAt: 'invalid' }])).toBe(false);
    expect(validReferences([{ ...item, content: 'x'.repeat(8001) }])).toBe(false);
    expect(validReferences(Array.from({ length: 17 }, (_, i) => ({ ...item, id: `card:${i}` })))).toBe(false);
    expect(validReferences([{ ...item, source: null }])).toBe(false);
    expect(validReferences([])).toBe(true);
  });
});
