import { Type, type Static } from "@sinclair/typebox";
import { ConversationAttachmentRef } from "./conversations.js";

const strict = { additionalProperties: false } as const;
export const WorkIntakeScope = Type.String({ pattern: "^(global|project:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$" });
export const CreateWorkIntake = Type.Object({
  id: Type.String({ format: "uuid" }), scope: WorkIntakeScope, message: Type.String({ minLength: 1, maxLength: 20000 }),
  pagePath: Type.Optional(Type.String({ minLength: 1, maxLength: 200, pattern: "^/" })),
  attachments: Type.Array(ConversationAttachmentRef, { maxItems: 10 }),
}, strict);
export const WorkIntakeChange = Type.Object({ action: Type.Union([Type.Literal("cancel"), Type.Literal("first"), Type.Literal("retry")]) }, strict);
export const WorkIntakeEntry = Type.Object({
  id: Type.String({ format: "uuid" }), scope: WorkIntakeScope, message: Type.String(), createdAt: Type.String(), updatedAt: Type.String(),
  state: Type.Union([Type.Literal("queued"), Type.Literal("sending"), Type.Literal("delivered"), Type.Literal("failed"), Type.Literal("cancelled")]),
  priority: Type.Boolean(), error: Type.Union([Type.String(), Type.Null()]),
}, strict);
export const WorkIntakeList = Type.Object({ items: Type.Array(WorkIntakeEntry) }, strict);
export type TWorkIntakeEntry = Static<typeof WorkIntakeEntry>;
export type TCreateWorkIntake = Static<typeof CreateWorkIntake>;
export type TWorkIntakeChange = Static<typeof WorkIntakeChange>;
export const PartnerWorkEvent = Type.Object({id: Type.String(), at: Type.String(), projectId: Type.String(), projectName: Type.String(),
  title: Type.String(), detail: Type.String(), subjectKind: Type.Union([Type.Literal("card"),Type.Literal("topic")]), subjectId: Type.String(),
  waitingId: Type.Union([Type.String(),Type.Null()]),
  /** 从主线开的会话正常做完一轮（同一个会话只留最新一行，最新一次卡住时不出）。 */
  done: Type.Optional(Type.Literal(true)),
  /** 这个会话是从主线开的（open_session）。 */
  fromMain: Type.Optional(Type.Literal(true))}, strict);
export const PartnerWorkEvents = Type.Object({items:Type.Array(PartnerWorkEvent)},strict);
export type TPartnerWorkEvent = Static<typeof PartnerWorkEvent>;
