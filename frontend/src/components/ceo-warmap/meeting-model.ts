import type { HeavyNoticeId } from './decision-model';
import type { IssueId } from './model';

export interface TodayMeeting {
  id:string;
  title:string;
  time:string;
  reviewId:HeavyNoticeId;
  summary:string;
  leadDri:string;
  ceoName:string;
  participants:string[];
  issueIds:IssueId[];
}

/** Meeting identity binds its review, draft, completion and conversation. Replace this fixture with calendar records at integration. */
export const todayMeetings: TodayMeeting[] = [
  { id: 'product-alignment', title: '灯塔项目：产品交互对齐会议', time: '10:00 - 12:00', reviewId: 'preflight-product', summary: '讨论首次真实使用的交付边界，以及客户 DRI 参与方式。', leadDri:'白田田', ceoName:'刘明华', participants:['刘明华','白田田','孙铭泽','产品负责人'], issueIds:['voice','payment','participation'] },
  { id: 'm1b-workshop', title: '灯塔项目：M1B L4/5 workshop', time: '13:00 - 15:00', reviewId: 'preflight-workshop', summary: '对齐六个月目标、本月结果与 Missions 的承接，处理跨战场资源取舍。', leadDri:'白田田', ceoName:'刘明华', participants:['刘明华','白田田','孙铭泽','业务负责人'], issueIds:['capacity','growth','hub'] },
];

/** A meeting owns an agenda and may therefore carry several issues. */
export function meetingsForIssue(issueId: IssueId): TodayMeeting[] {
  return todayMeetings.filter(meeting => meeting.issueIds.includes(issueId));
}
