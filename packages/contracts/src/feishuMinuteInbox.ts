import { Type, type Static } from "@sinclair/typebox";
import { PickedWorldAnchor } from "./meetingDecisions.js";

/**
 * 飞书里直接开的会待整理（只给妙记所有者本人）：上线后飞书视频会议生成、还没对上天枢会议的妙记。
 * 整理 = 用这份妙记新建一场会；记到 = 挂到建议的那场天枢里约好的会；忽略 = 不再提示。
 */
export const FeishuMinutePerson = Type.Object(
  { personId: Type.String({ minLength: 1, maxLength: 200 }), displayName: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
/** 时间对得上的天枢里约好的会；没有为 null。 */
export const FeishuMinuteSuggestion = Type.Object(
  { meetingId: Type.String({ minLength: 1 }), title: Type.String({ minLength: 1 }) },
  { additionalProperties: false },
);
export const FeishuMinuteInboxItem = Type.Object(
  {
    minuteToken: Type.String({ minLength: 1, maxLength: 200 }),
    title: Type.String({ minLength: 1 }),
    /** 妙记生成时刻与加上时长后的时刻；没有时长时结束 = 开始。 */
    startsAt: Type.String(),
    endsAt: Type.String(),
    /** 飞书实际参会人里对得上天枢人员的，所有者排第一。 */
    attendees: Type.Array(FeishuMinutePerson),
    /** 对不上天枢人员的参会人数。 */
    otherAttendees: Type.Integer({ minimum: 0 }),
    suggestion: Type.Union([FeishuMinuteSuggestion, Type.Null()]),
  },
  { additionalProperties: false },
);
export const FeishuMinuteInboxResponse = Type.Object({ minutes: Type.Array(FeishuMinuteInboxItem) }, { additionalProperties: false });
export const OrganizeFeishuMinuteRequest = Type.Object(
  { title: Type.String({ minLength: 1, maxLength: 200 }), anchors: Type.Array(PickedWorldAnchor, { minItems: 1, maxItems: 10 }) },
  { additionalProperties: false },
);
export const AttachFeishuMinuteRequest = Type.Object({ meetingId: Type.String({ minLength: 1 }) }, { additionalProperties: false });
/** 整理、记到之后妙记所在的那场会。 */
export const FeishuMinuteMeetingResponse = Type.Object({ meetingId: Type.String({ minLength: 1 }) }, { additionalProperties: false });

export type TFeishuMinutePerson = Static<typeof FeishuMinutePerson>;
export type TFeishuMinuteSuggestion = Static<typeof FeishuMinuteSuggestion>;
export type TFeishuMinuteInboxItem = Static<typeof FeishuMinuteInboxItem>;
export type TFeishuMinuteInboxResponse = Static<typeof FeishuMinuteInboxResponse>;
export type TOrganizeFeishuMinuteRequest = Static<typeof OrganizeFeishuMinuteRequest>;
export type TAttachFeishuMinuteRequest = Static<typeof AttachFeishuMinuteRequest>;
export type TFeishuMinuteMeetingResponse = Static<typeof FeishuMinuteMeetingResponse>;
