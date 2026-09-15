import { describe, expect, it } from 'vitest';
import { readDecisions } from './decision-model';

describe('shared prototype decision restoration', () => {
  it('restores explicit decisions, not notification replies or malformed records', () => {
    expect(readDecisions(JSON.stringify({
      capacity: {issueId:'capacity',status:'decided',summary:'优先灯塔'},
      voice: {issueId:'voice',status:'replied',summary:'补充依据'},
      payment: {issueId:'hub',status:'decided',summary:'错误映射'},
      growth: {issueId:'growth',status:'decided',summary:''},
    }))).toEqual({capacity:{issueId:'capacity',status:'decided',summary:'优先灯塔'}});
  });
  it('returns an empty decision set for corrupted browser storage', () => {
    for (const raw of [null,'{','null','[]','42']) expect(readDecisions(raw)).toEqual({});
  });
});
