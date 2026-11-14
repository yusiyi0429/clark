import { Type, type Static } from "@sinclair/typebox";

const nullableText = Type.Union([Type.String(), Type.Null()]);
export const PartnerMeetingItem = Type.Object({
  id: Type.String(),
  meetingId: nullableText,
  title: Type.String(),
  at: Type.String({ format: "date-time" }),
  stage: Type.Union([Type.Literal("scheduled"), Type.Literal("live"), Type.Literal("processing"),
    Type.Literal("ready"), Type.Literal("attention"), Type.Literal("unmatched")]),
  statusText: Type.String(),
  href: Type.String(),
  joinUrl: nullableText,
  needsAction: Type.Boolean(),
  source: Type.Union([Type.Literal("feishu"), Type.Literal("tianshu")]),
  preflightText: Type.Optional(nullableText),
  sourceUrl: Type.Optional(nullableText),
  recordHref: Type.Optional(nullableText),
  endsAt: Type.Optional(nullableText),
  allDay: Type.Optional(Type.Boolean()),
  canStartRecording: Type.Optional(Type.Boolean()),
  sources: Type.Optional(Type.Array(Type.Object({ label: Type.String(), recordHref: Type.String(), sourceUrl: nullableText }))),
}, { additionalProperties: false });
export const PartnerMeetingsResponse = Type.Object({ items: Type.Array(PartnerMeetingItem) }, { additionalProperties: false });
export const PartnerMeetingRecordResponse = Type.Object({ title: Type.String(), text: Type.String(), sourceUrl: nullableText }, { additionalProperties: false });

export type TPartnerMeetingItem = Static<typeof PartnerMeetingItem>;
export type TPartnerMeetingRecordResponse = Static<typeof PartnerMeetingRecordResponse>;
