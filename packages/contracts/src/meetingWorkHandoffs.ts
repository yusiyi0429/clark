import { Type, type Static } from "@sinclair/typebox";
import { MeetingWorkAuthorization, MeetingWorkTarget, NexusDriContent } from "./nexusDri.js";

const strict = { additionalProperties: false } as const;
const uuid = Type.String({ format: "uuid" });
const text = Type.String({ minLength: 1 });
const nullableText = Type.Union([Type.String(), Type.Null()]);
const instant = Type.String({ format: "date-time" });

export const MeetingWorkTargetOption = Type.Object({ ...MeetingWorkTarget.properties, projectName: text, name: text }, strict);
export const MeetingWorkTargetList = Type.Object({ targets: Type.Array(MeetingWorkTargetOption) }, strict);
export const MeetingWorkHandoffParams = Type.Object({ confirmationRef: uuid }, strict);

export const MeetingWorkConclusion = Type.Object({
  confirmationRef: uuid, requestId: text, itemId: text, meetingId: text, revision: Type.Integer({ minimum: 1 }),
  decision: Type.Union([Type.Literal("confirmed"), Type.Literal("amended")]), confirmedAt: instant, confirmedBy: text,
  question: text, content: NexusDriContent,
  source: Type.Object({ id: text, version: text, hash: text, minutesRef: text, reference: nullableText, turnId: nullableText,
    quote: nullableText, readState: Type.Union([Type.Literal("excerpt"), Type.Literal("reference_only")]) }, strict),
}, strict);

export const MeetingWorkReceipt = Type.Object({
  id: uuid, target: MeetingWorkTarget, instruction: Type.String(),
  status: Type.Union([Type.Literal("pending"), Type.Literal("delivered"), Type.Literal("failed")]), reason: nullableText,
  authorizedAt: instant, deliveredAt: Type.Union([instant, Type.Null()]),
}, strict);

export const MeetingWorkHandoffs = Type.Object({ items: Type.Array(Type.Object({
  conclusion: MeetingWorkConclusion, receipts: Type.Array(MeetingWorkReceipt),
}, strict)) }, strict);
export const ContinueMeetingWork = Type.Object({ ...MeetingWorkAuthorization.properties, revision: Type.Integer({ minimum: 1 }) }, strict);
export const MeetingWorkResult = Type.Object({ receipts: Type.Array(MeetingWorkReceipt) }, strict);

export const MeetingWorkCriterionRef = Type.Object({
  kind: Type.Union([Type.Literal("task"), Type.Literal("card")]), id: text, revision: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]),
  index: Type.Union([Type.Integer({ minimum: 1 }), Type.Null()]), text: Type.String(),
}, strict);
export const MeetingWorkFeedItem = Type.Object({
  kind: Type.Literal("meeting_handoff"), id: uuid, at: instant, target: MeetingWorkTargetOption,
  conclusion: MeetingWorkConclusion, instruction: Type.String(), authorizedBy: text, authorizedAt: instant,
  criteria: Type.Array(MeetingWorkCriterionRef), superseded: Type.Boolean(),
}, strict);

export type TMeetingWorkTarget = Static<typeof MeetingWorkTarget>;
export type TMeetingWorkTargetOption = Static<typeof MeetingWorkTargetOption>;
export type TMeetingWorkConclusion = Static<typeof MeetingWorkConclusion>;
export type TMeetingWorkReceipt = Static<typeof MeetingWorkReceipt>;
export type TMeetingWorkHandoffs = Static<typeof MeetingWorkHandoffs>;
export type TContinueMeetingWork = Static<typeof ContinueMeetingWork>;
export type TMeetingWorkAuthorization = Static<typeof MeetingWorkAuthorization>;
export type TMeetingWorkCriterionRef = Static<typeof MeetingWorkCriterionRef>;
export type TMeetingWorkFeedItem = Static<typeof MeetingWorkFeedItem>;
