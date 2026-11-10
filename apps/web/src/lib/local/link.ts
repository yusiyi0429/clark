/**
 * 配对之后把本机程序关联到云端（RFC 第 8 节、V2 设计第 6.4 节）：云端按本机的 deviceId 发一把设备令牌（POST /api/me/local-devices，
 * 同一台电脑再配对只换令牌），网页当场经本机 PUT /v1/cloud 交给本机程序；令牌不在网页里存。
 */
import type { TLocalDeviceOs } from "@warmap/contracts";
import { createDevice } from "@/lib/board/cloud";
import type { LocalRunner, TLocalStatusResponse } from "./runner";

export const deviceName = (os: TLocalDeviceOs) => (os === "darwin" ? "Mac" : os === "win32" ? "Windows 电脑" : "Linux 电脑");

/** 关联的是谁：本机存下 personId，网页拿它和登录的人比（connection.ts pairedElsewhere）。 */
export type LinkPerson = { personId: string | null; name: string };
export const linkPerson = (account: { personId?: string | null; displayName: string }): LinkPerson => ({ personId: account.personId ?? null, name: account.displayName });

export async function linkCloud(runner: LocalRunner, status: TLocalStatusResponse, person: LinkPerson): Promise<void> {
  const os = (await runner.health()).platform;
  const { token } = await createDevice({ deviceId: status.deviceId, name: deviceName(os), os });
  await runner.linkCloud({ apiBaseUrl: window.location.origin, token, personName: person.name.slice(0, 60), ...(person.personId ? { personId: person.personId } : {}) });
}
