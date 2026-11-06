/**
 * 配对之后把本机程序关联到云端（RFC 第 8 节、V2 设计第 6.4 节）：云端按本机的 deviceId 发一把设备令牌（POST /api/me/local-devices，
 * 同一台电脑再配对只换令牌），网页当场经本机 PUT /v1/cloud 交给本机程序；令牌不在网页里存。
 */
import type { TLocalDeviceOs } from "@warmap/contracts";
import { createDevice } from "@/lib/board/cloud";
import type { LocalRunner, TLocalStatusResponse } from "./runner";

export const deviceName = (os: TLocalDeviceOs) => (os === "darwin" ? "Mac" : os === "win32" ? "Windows 电脑" : "Linux 电脑");

export async function linkCloud(runner: LocalRunner, status: TLocalStatusResponse, personName: string): Promise<void> {
  const os = (await runner.health()).platform;
  const { token } = await createDevice({ deviceId: status.deviceId, name: deviceName(os), os });
  await runner.linkCloud({ apiBaseUrl: window.location.origin, token, personName: personName.slice(0, 60) });
}
