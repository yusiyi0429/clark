import { createElement, createRef } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { IssueWorkspace } from './issue-workspace';

function renderIssue(receipt?: { issueId:'voice'; status:'decided'; summary:string }) {
  return renderToStaticMarkup(createElement(IssueWorkspace, {
    id:'voice',
    initialResearch:false,
    panelRef:createRef<HTMLElement>(),
    closing:false,
    onClose:vi.fn(),
    receipt,
    onQuote:vi.fn(),
    onAsk:vi.fn(),
  }));
}

describe('IssueWorkspace meeting boundary', () => {
  it('presents alternatives as read-only meeting preparation', () => {
    const html=renderIssue();
    const discussion=html.match(/<section[^>]+aria-labelledby="issue-discussion-title"[\s\S]*?<\/section>/)?.[0];

    expect(discussion).toContain('带到会议讨论');
    expect(discussion).toContain('纳入首次交付');
    expect(discussion).not.toContain('<button');
    expect(html).not.toContain('确认此决定');
    expect(html).not.toContain('先讨论这个选择');
  });

  it('shows a returned meeting conclusion without CEO-side editing actions', () => {
    const html=renderIssue({issueId:'voice',status:'decided',summary:'先确认客户真实使用时刻'});
    const discussion=html.match(/<section[^>]+aria-labelledby="issue-discussion-title"[\s\S]*?<\/section>/)?.[0];

    expect(discussion).toContain('会议结论');
    expect(discussion).toContain('先确认客户真实使用时刻');
    expect(discussion).not.toContain('<button');
    expect(html).not.toContain('撤回此决定');
  });
});
