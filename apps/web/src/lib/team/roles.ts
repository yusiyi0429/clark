/**
 * 岗位（V2 设计第 19 节）：本人的岗位、可加的预设、修改记录、待本人确认的岗位修改。
 * 契约 roles.ts 还没到：类型照第 19.3、19.4 节先写在这里，到了换成契约类型。
 * 接口 404（后端还没有）时整页改用请求桩：数据只在这个标签页的内存里，刷新就没了。
 */
import type { TCardModelTier } from "@warmap/contracts";
import { CloudError } from "@/lib/board/cloud";
import type { CardItem } from "@/lib/board/cards";

export type RoleFamily = "general" | "dev" | "strategy_content";
export type RoleKind = "worker" | "reviewer" | "critic";
export type RoleTool = "tianshu" | "web_search" | "feishu" | "github" | "browser";
export type ModelTier = TCardModelTier;
export type RoleField = "duties_md" | "practice_md" | "acceptance_md";
export type Person = { id: string; name: string };

export type RoleView = {
  id: string;
  presetKey: string | null;
  presetVersion: number | null;
  name: string;
  family: RoleFamily;
  kind: RoleKind;
  dutiesMd: string;
  practiceMd: string;
  acceptanceMd: string;
  tools: RoleTool[];
  modelTier: ModelTier;
  version: number;
  updatedAt: string;
  updatedBy: Person | null;
};
export type RolePresetView = { key: string; version: number; name: string; family: RoleFamily; kind: RoleKind; added: boolean };
export type RoleListResponse = { roles: RoleView[]; presets: RolePresetView[] };
export type PatchRoleRequest = { version: number; name?: string; dutiesMd?: string; practiceMd?: string; acceptanceMd?: string; tools?: RoleTool[]; modelTier?: ModelTier };
export type RoleChange = { field: RoleField | "name" | "tools" | "model_tier"; before: string; after: string };
export type RoleRevisionView = { version: number; changes: RoleChange[]; reason: string | null; source: "manual" | "proposal"; proposalId: string | null; card: { id: string; title: string } | null; by: Person; at: string };
export type RoleProposalView = {
  id: string;
  roleId: string;
  roleName: string;
  sourceKind: "overrule" | "second_fail";
  card: { id: string; title: string } | null;
  field: RoleField;
  currentText: string;
  proposedText: string;
  why: string;
  createdAt: string;
};

export const FAMILY_LABEL: Record<RoleFamily, string> = { general: "通用", dev: "研发", strategy_content: "战略和内容" };
export const KIND_LABEL: Record<RoleKind, string> = { worker: "干活", reviewer: "验收", critic: "挑刺" };
export const TOOL_LABEL: Record<RoleTool, string> = { tianshu: "天枢", web_search: "联网搜索", feishu: "飞书", github: "GitHub", browser: "浏览器" };
export const TIER_LABEL: Record<ModelTier, string> = { strong: "强", normal: "中", light: "轻" };
export const FIELD_LABEL: Record<RoleField, string> = { duties_md: "职责", practice_md: "做法", acceptance_md: "验收口径" };
export const FIELD_KEY: Record<RoleField, "dutiesMd" | "practiceMd" | "acceptanceMd"> = { duties_md: "dutiesMd", practice_md: "practiceMd", acceptance_md: "acceptanceMd" };
export const FIELDS: RoleField[] = ["duties_md", "practice_md", "acceptance_md"];
export const TOOLS: RoleTool[] = ["tianshu", "web_search", "feishu", "github", "browser"];
export const TIERS: ModelTier[] = ["strong", "normal", "light"];

// ── 接口 ──

/** 后端还没有岗位接口（第一次读就 404）：之后都走桩。 */
let stubbed = false;
export const rolesStubbed = () => stubbed;

async function call<T>(method: "GET" | "POST" | "PATCH" | "DELETE", path: string, body?: unknown): Promise<T> {
  let response: Response;
  try {
    response = await fetch(path, { method, credentials: "same-origin", headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new CloudError(0, "连不上天枢，请稍后再试");
  }
  if (response.status === 401) {
    window.location.assign(`/access?next=${encodeURIComponent(window.location.pathname)}`);
    throw new CloudError(401, "登录过期了");
  }
  const data = (await response.json().catch(() => null)) as (T & { message?: string; code?: string }) | null;
  if (!response.ok) throw new CloudError(response.status, data?.message ?? "没成功，请重试", data?.code);
  return data as T;
}

export async function listRoles(): Promise<RoleListResponse> {
  if (!stubbed) {
    try {
      return await call<RoleListResponse>("GET", "/api/me/roles");
    } catch (error) {
      if (!(error instanceof CloudError) || error.status !== 404) throw error;
      stubbed = true;
    }
  }
  return stub.list();
}
/** 桩也按异步走，出错是拒绝而不是同步抛。 */
const fromStub = <T>(run: () => T): Promise<T> => Promise.resolve().then(run);
export const addPreset = (presetKey: string) => (stubbed ? fromStub(() => stub.add(presetKey)) : call<RoleView>("POST", "/api/me/roles", { presetKey }));
export const patchRole = (roleId: string, body: PatchRoleRequest) => (stubbed ? fromStub(() => stub.patch(roleId, body)) : call<RoleView>("PATCH", `/api/me/roles/${encodeURIComponent(roleId)}`, body));
export const listRevisions = (roleId: string) =>
  stubbed ? fromStub(() => stub.revisions(roleId)) : call<{ revisions: RoleRevisionView[] }>("GET", `/api/me/roles/${encodeURIComponent(roleId)}/revisions`).then((data) => data.revisions);
export const listProposals = () =>
  stubbed ? fromStub(() => stub.proposals()) : call<{ proposals: RoleProposalView[] }>("GET", "/api/me/role-proposals?status=open").then((data) => data.proposals);
export const decideProposal = (proposalId: string, decision: "accept" | "dismiss") =>
  stubbed ? fromStub(() => stub.decide(proposalId, decision)) : call<unknown>("POST", `/api/me/role-proposals/${encodeURIComponent(proposalId)}/${decision}`).then(() => undefined);

// ── 卡上的岗位 ──

export type CardRole = { id: string; name: string };
/** 卡上配的岗位（契约到了以后是 card.role）；桩里开工时选的记在内存里。 */
export function cardRole(item: CardItem): CardRole | null {
  const role = (item.card as { role?: CardRole | null } | null | undefined)?.role;
  return role ?? stubCardRoles.get(item.id) ?? null;
}
/** 草稿卡配的岗位（契约到了以后是 draft.role）。 */
export const draftRole = (draft: object): CardRole | null => (draft as { role?: CardRole | null }).role ?? null;

/** 开工时换了岗位：记到卡上，返回卡的新版本号；后端还不收 roleId 时记进桩、返回 null。 */
export async function setCardRole(cardId: string, version: number, role: CardRole): Promise<number | null> {
  if (!stubbed) {
    try {
      const card = await call<{ version: number }>("PATCH", `/api/me/cards/${encodeURIComponent(cardId)}`, { version, roleId: role.id });
      return card.version;
    } catch (error) {
      if (!(error instanceof CloudError) || (error.status !== 400 && error.status !== 404)) throw error;
    }
  }
  stubCardRoles.set(cardId, role);
  return null;
}

/** 岗位档位落到具体模型：强 → Opus，中 → Sonnet，轻 → Haiku 一类；认不出时用默认模型。 */
const TIER_MATCH: Record<ModelTier, RegExp> = { strong: /opus/i, normal: /sonnet/i, light: /haiku|flash|mini|lite/i };
export function modelForTier<T extends { model: string | null; label: string; isDefault: boolean }>(models: T[], tier: ModelTier): T | null {
  return models.find((entry) => TIER_MATCH[tier].test(`${entry.model ?? ""} ${entry.label}`)) ?? models.find((entry) => entry.isDefault) ?? models[0] ?? null;
}

/** 桩期间交代里还没有岗位：开工时把职责和做法放在交代前面。 */
export function roleSection(role: Pick<RoleView, "name" | "dutiesMd" | "practiceMd" | "acceptanceMd">): string {
  return [`# 岗位：${role.name}`, role.dutiesMd && `## 职责\n${role.dutiesMd}`, role.practiceMd && `## 做法\n${role.practiceMd}`, role.acceptanceMd && `## 验收口径\n${role.acceptanceMd}`]
    .filter(Boolean).join("\n\n");
}

// ── 请求桩（后端没有岗位接口时）──

type Preset = Omit<RolePresetView, "added"> & Pick<RoleView, "dutiesMd" | "practiceMd" | "acceptanceMd" | "tools" | "modelTier">;
const preset = (key: string, name: string, family: RoleFamily, kind: RoleKind, tools: RoleTool[], modelTier: ModelTier): Preset =>
  ({ key, version: 1, name, family, kind, tools, modelTier, dutiesMd: "", practiceMd: "", acceptanceMd: "" });
/** 第 19.3 节的三组预设；正文由主会话另写，这里留空。 */
const PRESETS: Preset[] = [
  preset("general/reviewer", "验收员", "general", "reviewer", ["tianshu"], "normal"),
  preset("general/devil", "反方", "general", "critic", ["web_search"], "normal"),
  preset("general/reader", "读者视角", "general", "critic", [], "light"),
  preset("dev/developer", "开发", "dev", "worker", ["tianshu", "github"], "strong"),
  preset("dev/code-review", "代码评审", "dev", "reviewer", ["github"], "normal"),
  preset("dev/tester", "测试", "dev", "worker", ["github", "browser"], "normal"),
  preset("strategy_content/researcher", "调研员", "strategy_content", "worker", ["tianshu", "web_search", "feishu"], "strong"),
  preset("strategy_content/writer", "写稿人", "strategy_content", "worker", ["tianshu", "feishu"], "normal"),
  preset("strategy_content/industry", "行业视角", "strategy_content", "critic", ["web_search"], "normal"),
];

const ME: Person = { id: "me", name: "我" };
const stubRoles = new Map<string, RoleView>();
const stubRevisions = new Map<string, RoleRevisionView[]>();
const stubProposals = new Map<string, RoleProposalView>();
const stubCardRoles = new Map<string, CardRole>();
const conflict = () => new CloudError(409, "别处改过了，已载入最新", "VERSION_CONFLICT");
const missing = () => new CloudError(404, "没有这个岗位");
const now = () => new Date().toISOString();
const show = (value: string[] | string) => (Array.isArray(value) ? value.map((tool) => TOOL_LABEL[tool as RoleTool] ?? tool).join("、") : value);

const stub = {
  list(): RoleListResponse {
    const roles = [...stubRoles.values()];
    return { roles, presets: PRESETS.map(({ key, version, name, family, kind }) => ({ key, version, name, family, kind, added: roles.some((role) => role.presetKey === key) })) };
  },
  add(presetKey: string): RoleView {
    const source = PRESETS.find((entry) => entry.key === presetKey);
    if (!source) throw missing();
    const role: RoleView = { id: `stub-${stubRoles.size + 1}-${presetKey.replace(/\W/g, "-")}`, presetKey, presetVersion: source.version, name: source.name, family: source.family, kind: source.kind,
      dutiesMd: source.dutiesMd, practiceMd: source.practiceMd, acceptanceMd: source.acceptanceMd, tools: [...source.tools], modelTier: source.modelTier, version: 1, updatedAt: now(), updatedBy: ME };
    stubRoles.set(role.id, role);
    return role;
  },
  patch(roleId: string, body: PatchRoleRequest, from?: { proposalId: string; card: RoleProposalView["card"]; why: string }): RoleView {
    const role = stubRoles.get(roleId);
    if (!role) throw missing();
    if (role.version !== body.version) throw conflict();
    const changes: RoleChange[] = [];
    const next = { ...role };
    if (body.name !== undefined && body.name !== role.name) { changes.push({ field: "name", before: role.name, after: body.name }); next.name = body.name; }
    for (const field of FIELDS) {
      const key = FIELD_KEY[field];
      const value = body[key];
      if (value !== undefined && value !== role[key]) { changes.push({ field, before: role[key], after: value }); next[key] = value; }
    }
    if (body.tools && show(body.tools) !== show(role.tools)) { changes.push({ field: "tools", before: show(role.tools), after: show(body.tools) }); next.tools = [...body.tools]; }
    if (body.modelTier && body.modelTier !== role.modelTier) { changes.push({ field: "model_tier", before: TIER_LABEL[role.modelTier], after: TIER_LABEL[body.modelTier] }); next.modelTier = body.modelTier; }
    if (!changes.length) return role;
    Object.assign(next, { version: role.version + 1, updatedAt: now(), updatedBy: ME });
    stubRoles.set(roleId, next);
    stubRevisions.set(roleId, [{ version: next.version, changes, reason: from?.why ?? null, source: from ? "proposal" : "manual", proposalId: from?.proposalId ?? null, card: from?.card ?? null, by: ME, at: now() },
      ...(stubRevisions.get(roleId) ?? [])]);
    return next;
  },
  revisions: (roleId: string) => stubRevisions.get(roleId) ?? [],
  proposals: () => [...stubProposals.values()],
  decide(proposalId: string, decision: "accept" | "dismiss") {
    const proposal = stubProposals.get(proposalId);
    if (!proposal) throw new CloudError(404, "这条已经处理过了");
    stubProposals.delete(proposalId);
    if (decision === "dismiss") return;
    const role = stubRoles.get(proposal.roleId);
    if (!role) throw missing();
    stub.patch(role.id, { version: role.version, [FIELD_KEY[proposal.field]]: proposal.proposedText }, { proposalId, card: proposal.card, why: proposal.why });
  },
};

/** 开发走查（假本机程序）时，桩里给第一个干活的岗位挂一条待确认的修改，好看「采纳」「不要」。 */
export function seedStubProposal(): void {
  if (!stubbed || stubProposals.size) return;
  const role = [...stubRoles.values()].find((entry) => entry.kind === "worker");
  if (!role) return;
  const id = `stub-proposal-${role.id}`;
  stubProposals.set(id, { id, roleId: role.id, roleName: role.name, sourceKind: "overrule", card: null, field: "practice_md", currentText: role.practiceMd,
    proposedText: `${role.practiceMd ? `${role.practiceMd}\n` : ""}- 交回前先把每条完成标准对应的证据列出来。`, why: "验收被推翻：交回里没有能核对的证据", createdAt: now() });
}
