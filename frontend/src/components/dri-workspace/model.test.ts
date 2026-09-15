import { describe, expect, it } from 'vitest';
import {
  createReviewComment,
  driWorkspaceFixture,
  routeMeetingPublication,
  unansweredProgressQuestions,
} from './model';

describe('DRI workspace domain rules', () => {
  it('routes an unowned action back to the meeting DRI', () => {
    const route = routeMeetingPublication(
      [
        { id: 'owned', text: '已分配', ownerName: '陈溪南', due: '9/17' },
        { id: 'unowned', text: '尚未分配', due: '9/18' },
      ],
      [],
      '孙铭泽',
    );

    expect(route.actionNotifications).toEqual([
      expect.objectContaining({ id: 'owned', recipientName: '陈溪南', fallbackToMeetingDri: false }),
      expect.objectContaining({ id: 'unowned', recipientName: '孙铭泽', fallbackToMeetingDri: true }),
    ]);
  });

  it('keeps CEO strategy notifications separate from action routing', () => {
    const strategicItem = { id: 'strategy', text: '是否调整本月范围', whyCeo: '资源边界' };
    const route = routeMeetingPublication([], [strategicItem], '孙铭泽');

    expect(route.actionNotifications).toHaveLength(0);
    expect(route.ceoNotifications).toEqual([strategicItem]);
  });

  it('publishes a versioned comment without mutating the Mission draft', () => {
    const mission = driWorkspaceFixture.missions[1];
    const before = JSON.stringify(mission);
    const comment = createReviewComment({
      authorName: '孙铭泽',
      body: '  收紧成功证据  ',
      anchor: 'success-evidence',
      targetId: mission.id,
      targetVersion: mission.version,
      previousComments: [],
      createdAt: '2026-09-13T20:00:00+08:00',
    });

    expect(comment).toMatchObject({ body: '收紧成功证据', targetVersion: mission.version, revision: 1, state: 'published' });
    expect(JSON.stringify(mission)).toBe(before);
  });

  it('asks only questions that sources have not already answered', () => {
    const questions = [
      { id: 'answered', prompt: '已有答案？', reason: '验证', answer: '有' },
      { id: 'missing', prompt: '尚无答案？', reason: '验证' },
    ];

    expect(unansweredProgressQuestions(questions)).toEqual([expect.objectContaining({ id: 'missing' })]);
  });
});
