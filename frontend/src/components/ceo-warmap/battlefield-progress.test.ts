import { describe, expect, it } from 'vitest';
import { resolveProgressCommand } from './battlefield-progress';

describe('progress navigation', () => {
  it('distinguishes a global overview from a single battlefield', () => {
    expect(resolveProgressCommand('看看各战场进展', null)).toEqual({ mode: 'progress', zone: undefined });
    expect(resolveProgressCommand('只看灯塔进展', null)).toEqual({ mode: 'progress', zone: 'lighthouse' });
    expect(resolveProgressCommand('看看这个战场进度', 'tokenops')).toEqual({ mode: 'progress', zone: 'tokenops' });
    expect(resolveProgressCommand('回到待决策', null)).toEqual({ mode: 'decisions' });
  });
  it('keeps reasoning, negation and unresolved references in conversation', () => {
    for (const text of ['不要看看灯塔进度', '为什么灯塔进度卡住了', '看看灯塔进度是否能按期完成', '这个月的进度需要重新评估', '看看这个战场进度']) {
      expect(resolveProgressCommand(text, null)).toBeNull();
    }
  });
});
