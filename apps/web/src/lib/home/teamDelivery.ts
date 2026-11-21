import type { TReplyTeamDeliveryRequest, TRequestBox, TRequestListItem, TRequestPerson, TSendTeamDeliveryRequest, TTeamDelivery, TTeamDeliverySource } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";
import type { components } from "@/lib/api/schema";
import { fileNameOf } from "@/lib/home/attachments";

export const TEAM_DELIVERY_CHANGED = "team-delivery-changed";
export type TeamBox = "received" | "sent";

function result<T>(data: T | undefined, response: Response, error: unknown, fallback: string): T {
  if (response.status === 401) { window.location.assign("/access"); throw new Error("登录已过期"); }
  if (!response.ok || !data) throw new Error((error as { message?: string } | undefined)?.message || fallback);
  return data;
}

export async function listTeamDeliveries(box: TeamBox, signal?: AbortSignal): Promise<TTeamDelivery[]> {
  const { data, response, error } = await browserApi.GET("/api/me/team-deliveries", { params: { query: { box } }, signal, cache: "no-store" });
  return result(data, response, error, "没有读到同事收发记录").items;
}

export async function readTeamDelivery(id: string, signal?: AbortSignal): Promise<TTeamDelivery> {
  const { data, response, error } = await browserApi.GET("/api/me/team-deliveries/{id}", { params: { path: { id } }, signal, cache: "no-store" });
  return result(data, response, error, "这条记录已不可见").delivery;
}

export async function listTeamPeople(viewerId: string | null): Promise<TRequestPerson[]> {
  const { data, response, error } = await browserApi.GET("/api/people/directory");
  return result(data, response, error, "没有读到同事名单").people.filter((person) => person.personId !== viewerId);
}

export async function listTeamSources(): Promise<TTeamDeliverySource[]> {
  const { data, response, error } = await browserApi.GET("/api/me/team-delivery-sources", { cache: "no-store" });
  return result(data, response, error, "没有读到可分享的文件版本").items;
}

export async function listCollectionRounds(box: TRequestBox, signal?: AbortSignal): Promise<TRequestListItem[]> {
  const { data, response, error } = await browserApi.GET("/api/me/requests", { params: { query: { box } }, signal, cache: "no-store" });
  return result(data, response, error, "没有读到收集轮次").items.filter((item) => item.kind === "collection");
}

/** 同一份 payload 可直接发 JSON，也可随文件发 multipart。保留原始字节和名字。 */
async function postFiles(path: string, payload: TSendTeamDeliveryRequest | TReplyTeamDeliveryRequest, files: readonly File[]): Promise<TTeamDelivery> {
  const body = new FormData();
  body.set("payload", JSON.stringify(payload));
  for (const file of files) body.append("files", file, fileNameOf(file));
  const response = await fetch(path, { method: "POST", body });
  const json = await response.json().catch(() => undefined);
  return result<components["schemas"]["TeamDeliveryResponse"]>(json, response, json, "上传没有成功，请重试").delivery;
}

export async function sendTeamDelivery(body: TSendTeamDeliveryRequest, files: readonly File[]): Promise<TTeamDelivery> {
  if (files.length) return postFiles("/api/me/team-deliveries", body, files);
  const { data, response, error } = await browserApi.POST("/api/me/team-deliveries", { body });
  return result(data, response, error, "没有发出去，请重试").delivery;
}

export async function replyTeamDelivery(id: string, body: TReplyTeamDeliveryRequest, files: readonly File[]): Promise<TTeamDelivery> {
  if (files.length) return postFiles("/api/me/team-deliveries/" + encodeURIComponent(id) + "/replies", body, files);
  const { data, response, error } = await browserApi.POST("/api/me/team-deliveries/{id}/replies", { params: { path: { id } }, body });
  return result(data, response, error, "回复没有发出去，请重试").delivery;
}

export async function retryRecipient(id: string, personId: string): Promise<TTeamDelivery> {
  const { data, response, error } = await browserApi.POST("/api/me/team-deliveries/{id}/recipients/{personId}/retry", { params: { path: { id, personId } } });
  return result(data, response, error, "这位同事的投递重试失败").delivery;
}

export const teamError = (error: unknown, fallback: string) => error instanceof TypeError ? fallback : error instanceof Error ? error.message : fallback;
