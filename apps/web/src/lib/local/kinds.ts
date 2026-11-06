/**
 * 本机的两种新会话（V2 设计第 21 节）：规划员 plan（拆一个 Task，subject 带 taskId）、验收员 verify（只读，交回后本机自己接，subject 带 cardId）。
 * D 正在给本机契约加；合进来之前网页先按这个形状用，合进来后删掉这个文件，改用契约里的类型。
 */
import type { TLocalCreateSessionRequest, TLocalSessionSummary } from "./runner";

export type PlanSubject = { kind: "plan"; taskId: string };
export type VerifySubject = { kind: "verify"; cardId: string };
export type AnySubject = { kind: "card"; cardId?: string; topicId?: string } | { kind: "topic"; cardId?: string; topicId?: string } | PlanSubject | VerifySubject;
export type PlanStartRequest = Omit<TLocalCreateSessionRequest, "subject"> & { subject: PlanSubject };

export const subjectOf = (session: Pick<TLocalSessionSummary, "subject">) => session.subject as AnySubject;
/** 规划员、验收员的开工请求按契约的形状交给本机（契约合进来后去掉这层转换）。 */
export const asCreateRequest = (request: Omit<TLocalCreateSessionRequest, "subject"> & { subject: AnySubject }) => request as unknown as TLocalCreateSessionRequest;
