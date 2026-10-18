import { Type, type Static } from "@sinclair/typebox";

/**
 * 上手最后一页的两个清单（前端交互说明 10a 第 4 步）：工作依据清单、搬家清单。
 * 候选由服务端按本人的数据现算，提交时只传勾选的 key，服务端再算一遍候选、只认候选里的 key。
 */

/** material：天枢里的材料（修订号 vN）；feishu_doc：飞书文档；link：其他链接。修订号拿不到时为空。 */
export const WorkBasisDocKind = Type.Union([Type.Literal("material"), Type.Literal("feishu_doc"), Type.Literal("link")]);
export const WorkBasisCandidate = Type.Object({
  key: Type.String({ minLength: 1, maxLength: 520 }),
  kind: WorkBasisDocKind,
  title: Type.String({ minLength: 1 }),
  url: Type.Union([Type.String(), Type.Null()]),
  revision: Type.Union([Type.String(), Type.Null()]),
  /** 已经入库（本人确认过）。 */
  confirmed: Type.Boolean(),
}, { additionalProperties: false });
export const WorkBasisResponse = Type.Object({ candidates: Type.Array(WorkBasisCandidate) }, { additionalProperties: false });
export const UpdateWorkBasisRequest = Type.Object({
  keys: Type.Array(Type.String({ minLength: 1, maxLength: 520 }), { maxItems: 500 }),
}, { additionalProperties: false });

/** 本机清单里找到的定时任务；imported：已经搬进定时任务区。 */
export const ScheduleMigrationCandidate = Type.Object({
  key: Type.String({ minLength: 1, maxLength: 300 }),
  name: Type.String({ minLength: 1 }),
  cadence: Type.Union([Type.String(), Type.Null()]),
  command: Type.Union([Type.String(), Type.Null()]),
  deviceName: Type.String(),
  imported: Type.Boolean(),
}, { additionalProperties: false });
export const ScheduleMigrationResponse = Type.Object({ candidates: Type.Array(ScheduleMigrationCandidate) }, { additionalProperties: false });
export const UpdateScheduleMigrationRequest = Type.Object({
  keys: Type.Array(Type.String({ minLength: 1, maxLength: 300 }), { maxItems: 500 }),
}, { additionalProperties: false });

export type TWorkBasisCandidate = Static<typeof WorkBasisCandidate>;
export type TWorkBasisResponse = Static<typeof WorkBasisResponse>;
export type TUpdateWorkBasisRequest = Static<typeof UpdateWorkBasisRequest>;
export type TScheduleMigrationCandidate = Static<typeof ScheduleMigrationCandidate>;
export type TScheduleMigrationResponse = Static<typeof ScheduleMigrationResponse>;
export type TUpdateScheduleMigrationRequest = Static<typeof UpdateScheduleMigrationRequest>;
