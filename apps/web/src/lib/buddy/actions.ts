/**
 * 伙伴代本人做事（设计 17.4、17.7，契约 buddyActions.ts）网页这边用到的接口：授权、伙伴做过的事和撤销、转达给同事的草稿、回收站、
 * 「请这台电脑停掉」和「请这台电脑对子会话做一件事」的认领和回报。动作本身由 Chat 调天枢，网页不调。
 */
import type { TBuddyAuditEntry, TBuddyAuthority, TBuddyMessageDraft, TClaimSessionCommandsResponse, TSessionCommandDoneRequest, TSessionStopView, TTrashItem } from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";
import { unwrap } from "@/lib/board/cloud";

/** 同 cloud.ts 的读法：没登录回登录页，出错抛 CloudError（带 code，如 409 NOT_UNDOABLE）。 */
const call = <T>(request: Promise<unknown>): Promise<T> => unwrap<T>(request as Parameters<typeof unwrap<T>>[0]);

export const readBuddyAuthority = () => call<TBuddyAuthority>(browserApi.GET("/api/me/buddy-authority"));
export const saveBuddyAuthority = (authority: TBuddyAuthority["authority"]) => call<TBuddyAuthority>(browserApi.PUT("/api/me/buddy-authority", { body: { authority } }));

export const readBuddyLog = () => call<{ entries: TBuddyAuditEntry[] }>(browserApi.GET("/api/me/buddy-actions/log")).then((data) => data.entries);
export const undoBuddyAction = (id: string) => call<TBuddyAuditEntry>(browserApi.POST("/api/me/buddy-actions/log/{id}/undo", { params: { path: { id } } }));

export const readBuddyMessage = (id: string) => call<TBuddyMessageDraft>(browserApi.GET("/api/me/buddy-messages/{id}", { params: { path: { id } } }));
export const sendBuddyMessage = (id: string) => call<TBuddyMessageDraft>(browserApi.POST("/api/me/buddy-messages/{id}/send", { params: { path: { id } } }));
export const cancelBuddyMessage = (id: string) => call<TBuddyMessageDraft>(browserApi.POST("/api/me/buddy-messages/{id}/cancel", { params: { path: { id } } }));

export const readTrash = () => call<{ items: TTrashItem[] }>(browserApi.GET("/api/me/trash")).then((data) => data.items);
export const restoreTrash = (item: Pick<TTrashItem, "kind" | "id">) =>
  call<void>(browserApi.POST("/api/me/trash/{kind}/{id}/restore", { params: { path: { kind: item.kind, id: item.id } } }));

export const claimSessionStops = (deviceId: string) => call<{ stops: TSessionStopView[] }>(browserApi.POST("/api/me/session-stops/claim", { body: { deviceId } })).then((data) => data.stops);
export const reportSessionStop = (id: string, deviceId: string, result: "stopped" | "not_running") =>
  call<unknown>(browserApi.POST("/api/me/session-stops/{id}/done", { params: { path: { id } }, body: { deviceId, result } }));

export const claimSessionCommands = (deviceId: string) =>
  call<TClaimSessionCommandsResponse>(browserApi.POST("/api/me/session-commands/claim", { body: { deviceId } })).then((data) => data.commands);
export const reportSessionCommand = (id: string, body: TSessionCommandDoneRequest) =>
  call<unknown>(browserApi.POST("/api/me/session-commands/{id}/done", { params: { path: { id } }, body }));
