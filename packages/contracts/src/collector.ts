import { Type, type Static } from "@sinclair/typebox";

/** 本机采集器已下线（上报、心跳返回 410）；只留本人的采集器状态，设置页据此判断要不要给卸载命令。 */
const Instant = Type.String({ format: "date-time" });

/** 本人的采集器：连上的设备（收到过心跳或上报）、最近一次完整盘点、盘点到的条数。上手的「安装采集器」和扫描页轮询这里。 */
export const CollectorStatusResponse = Type.Object({
  /** 本人是否同意采集：没同意时不收本机清单，扫描页那几步停在「未同意」。 */
  consent: Type.Boolean(),
  devices: Type.Array(Type.Object({
    id: Type.String(),
    name: Type.String(),
    platform: Type.String(),
    lastSeenAt: Instant,
  }, { additionalProperties: false })),
  scannedAt: Type.Union([Instant, Type.Null()]),
  inventory: Type.Object({
    scheduledTasks: Type.Integer({ minimum: 0 }),
    feishuDocs: Type.Integer({ minimum: 0 }),
    memoryFiles: Type.Integer({ minimum: 0 }),
  }, { additionalProperties: false }),
}, { additionalProperties: false });

export type TCollectorStatusResponse = Static<typeof CollectorStatusResponse>;
