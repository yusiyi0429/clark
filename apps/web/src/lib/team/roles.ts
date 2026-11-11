/**
 * 岗位（V2 设计第 19 节，契约 roles.ts）：本人的岗位、可加的预设、修改记录、待本人确认的岗位修改；卡和草稿上的岗位；
 * 开工时按岗位档位挑模型，岗位原样转给本机会话。
 */
import type {
  TLocalRole, TPatchRoleRequest, TRoleBrief, TRoleFamily, TRoleKind, TRoleListResponse, TRoleModelTier, TRoleProposalField, TRoleProposalView,
  TRoleRef, TRoleRevisionField, TRoleRevisionView, TRoleTool, TRoleView, TCardDraftView, TLocalModelProfile,
} from "@warmap/contracts";
import { browserApi } from "@/lib/api/client";
import { CloudError, patchCard } from "@/lib/board/cloud";
import type { CardItem } from "@/lib/board/cards";
import { sourceIdOf } from "@/lib/local/modelPanel";

export type RoleFamily = TRoleFamily;
export type RoleKind = TRoleKind;
export type RoleTool = TRoleTool;
export type ModelTier = TRoleModelTier;
export type RoleField = TRoleProposalField;
export type RoleView = TRoleView;
export type RoleListResponse = TRoleListResponse;
export type RoleRevisionView = TRoleRevisionView;
export type RoleProposalView = TRoleProposalView;
export type PatchRoleRequest = TPatchRoleRequest;
export type CardRole = TRoleRef;

export const FAMILY_LABEL: Record<RoleFamily, string> = { general: "通用", dev: "研发", strategy_content: "战略和内容" };
export const KIND_LABEL: Record<RoleKind, string> = { worker: "干活", reviewer: "验收", critic: "挑刺" };
export const TOOL_LABEL: Record<RoleTool, string> = { tianshu: "天枢", web_search: "联网搜索", feishu: "飞书", github: "GitHub", browser: "浏览器" };
export const TIER_LABEL: Record<ModelTier, string> = { strong: "强", normal: "中", light: "轻" };
export const FIELD_LABEL: Record<RoleField, string> = { dutiesMd: "职责", practiceMd: "做法", acceptanceMd: "验收口径" };
export const CHANGE_LABEL: Record<TRoleRevisionField, string> = { ...FIELD_LABEL, name: "名称", tools: "工具", modelTier: "模型档位" };
export const FIELDS: RoleField[] = ["dutiesMd", "practiceMd", "acceptanceMd"];
export const TOOLS: RoleTool[] = ["tianshu", "web_search", "feishu", "github", "browser"];
export const TIERS: ModelTier[] = ["strong", "normal", "light"];

type Result<T> = { data?: T; error?: unknown; response: Response };
async function unwrap<T>(call: Promise<Result<T>>): Promise<T> {
  let result: Result<T>;
  try { result = await call; } catch { throw new CloudError(0, "连不上天枢，请稍后再试"); }
  const { data, error, response } = result;
  if (response.status === 401) {
    window.location.assign(`/access?next=${encodeURIComponent(window.location.pathname)}`);
    throw new CloudError(401, "登录过期了");
  }
  if (!response.ok) {
    const body = (error ?? {}) as { message?: string; code?: string };
    throw new CloudError(response.status, body.message ?? "没成功，请重试", body.code);
  }
  return data as T;
}
const id = (value: string) => ({ path: { id: value } });

export const listRoles = () => unwrap<RoleListResponse>(browserApi.GET("/api/me/roles") as Promise<Result<RoleListResponse>>);
export const addPreset = (presetKey: string) => unwrap<RoleView>(browserApi.POST("/api/me/roles", { body: { presetKey } }) as Promise<Result<RoleView>>);
export const patchRole = (roleId: string, body: PatchRoleRequest) => unwrap<RoleView>(browserApi.PATCH("/api/me/roles/{id}", { params: id(roleId), body }) as Promise<Result<RoleView>>);
export const listRevisions = (roleId: string) =>
  unwrap(browserApi.GET("/api/me/roles/{id}/revisions", { params: id(roleId) })).then((data) => (data as { revisions: RoleRevisionView[] }).revisions);
export const listProposals = () =>
  unwrap(browserApi.GET("/api/me/role-proposals", { params: { query: { status: "open" } } })).then((data) => (data as { proposals: RoleProposalView[] }).proposals);
export const decideProposal = (proposalId: string, decision: "accept" | "dismiss") =>
  (decision === "accept" ? unwrap(browserApi.POST("/api/me/role-proposals/{id}/accept", { params: id(proposalId) })) : unwrap(browserApi.POST("/api/me/role-proposals/{id}/dismiss", { params: id(proposalId) })))
    .then(() => undefined);

/** 卡上配的岗位（没配为 null）。 */
export const cardRole = (item: CardItem): CardRole | null => item.card?.role ?? null;
/** 草稿卡配的岗位。 */
export const draftRole = (draft: Pick<TCardDraftView, "role">): CardRole | null => draft.role;

/** 开工时换了岗位：记到卡上，返回卡的新版本号。 */
export async function setCardRole(cardId: string, version: number, role: CardRole): Promise<number> {
  const card = (await patchCard(cardId, { version, roleId: role.id })) as { version?: number } | undefined;
  return card?.version ?? version + 1;
}

/** 岗位档位落到具体模型：强 → Opus，中 → Sonnet，轻 → Haiku 一类；认不出时用默认模型。 */
const TIER_MATCH: Record<ModelTier, RegExp> = { strong: /opus/i, normal: /sonnet/i, light: /haiku|flash|mini|lite/i };
/**
 * 按档位配模型（「自动」）：只在 Claude Code 的模型里挑（设计 17.2 第 38 条：Codex 要本人自己选；规划员只能用 Claude Code）。
 * 不看 Claude 订阅的模型目录（40 条）。只在默认模型（标了默认的，没有就第一条）那个来源里挑（11/11 本人定 A）：
 * 默认是 Claude 订阅时，连了 TokenHub 也不会悄悄用 TokenHub 按量花钱；没配对应档位的模型时落到默认那条（内置的「自动」由本机按档位和预算模式挑），同以前。
 * 来源的分法同模型面板（sourceIdOf），本机 ModelProfiles.forTier 也照这套。
 */
export function modelForTier<T extends Pick<TLocalModelProfile, "model" | "label" | "isDefault" | "agent" | "source" | "origin"> & { catalog?: boolean; sourceId?: string }>(all: T[], tier: ModelTier): T | null {
  const models = all.filter((entry) => entry.agent === "claude-code" && !entry.catalog);
  const fallback = models.find((entry) => entry.isDefault) ?? models[0];
  if (!fallback) return null;
  const source = sourceIdOf(fallback);
  return models.find((entry) => sourceIdOf(entry) === source && TIER_MATCH[tier].test(`${entry.model ?? ""} ${entry.label}`)) ?? fallback;
}

/** 交代里的岗位原样转给本机（本机按它写系统提示词、挂插件）。 */
export const localRole = (role: TRoleBrief): TLocalRole => ({
  id: role.id, name: role.name, kind: role.kind, dutiesMd: role.dutiesMd, practiceMd: role.practiceMd, acceptanceMd: role.acceptanceMd,
  tools: role.tools, modelTier: role.modelTier, version: role.version,
});
