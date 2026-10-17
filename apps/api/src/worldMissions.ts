import { WorldClient, WorldError, worldRef, worldTarget, type WorldHead } from "./worldClient.js";

export const WORLD_MISSION_LINKS = [
  { code: "renhao-202610-b", title: "Ontology & Data Grounding", owner: "liu-renhao" },
  { code: "renhao-202610-c", title: "ENO / Engine Blueprint", owner: "liu-renhao" },
  { code: "siyi-202610-1", title: "可信 Context / Memory 与真实 Agent 读写闭环", owner: "yu-siyi" },
];

/** 每个客户端独享短缓存，替换实例或显式 refresh 后不沿用旧头。 */
export function createWorldMissionLookup(client: WorldClient) {
  const cache = new Map<string, { head: WorldHead; expires: number }>();
  return async (code: string, refresh = false): Promise<WorldHead | null> => {
    const hit = cache.get(code);
    if (!refresh && hit && hit.expires > Date.now()) return hit.head;
    const head = await client.byExternalRef(`mission:${code}`);
    if (head && head.object_type !== "Mission") throw new WorldError(409, "INVALID_STATE", `mission:${code} 未指向 Mission`);
    if (head) cache.set(code, { head, expires: Date.now() + 30_000 });
    else cache.delete(code);
    return head;
  };
}

export async function linkWorldMissions(client: WorldClient): Promise<WorldHead[]> {
  const candidates = await client.listObjects({ domain_id: client.config.domains.eo, type: "Mission" });
  const linked: WorldHead[] = [];
  for (const link of WORLD_MISSION_LINKS) {
    const matches = [];
    for (const candidate of candidates.filter((head) => head.title === link.title)) {
      const object = await client.getObject(candidate.object_id);
      if (object.business.attributes.responsible === client.config.people[link.owner]) matches.push(object.business.object_id);
    }
    if (matches.length !== 1) throw new WorldError(409, "INVALID_STATE", `${link.code} 的标题及负责人匹配数量为 ${matches.length}，停止关联`);
    const objectId = matches[0];
    const externalId = `mission:${link.code}`;
    const existing = await client.byExternalRef(externalId);
    if (existing && existing.object_id !== objectId) throw new WorldError(409, "INVALID_STATE", `The external reference (tianshu, ${externalId}) already points to object ${existing.object_id} in this scope.`);
    const key = `tianshu:link-mission:${link.code}`;
    const saved = await client.savedRequest(key);
    if (saved && saved.target?.object_id !== objectId) throw new WorldError(409, "IDEMPOTENCY_CONFLICT", `${link.code} 的幂等键已有不同目标`);
    if (!existing || saved) {
      await client.write(key, async () => {
        const head = await client.getHead(objectId);
        const refs = head.external_refs ?? [];
        return {
          action_type: "world_revise_object", contract_version: head.contract_version, target: worldTarget(head), expected_versions: [],
          idempotency_key: key, reason: "天枢 Mission 关联本体",
          params: {
            payload: { external_refs: [...refs.filter((ref) => !(ref.system === "tianshu" && ref.id === externalId)), { system: "tianshu", id: externalId }] },
            declaration: { scene: worldRef(head), trigger: "天枢 Mission 关联本体", human_acceptance: { required: false } },
          },
        };
      });
    }
    const verified = await client.byExternalRef(externalId);
    if (verified?.object_id !== objectId) throw new WorldError(409, "INVALID_STATE", `${externalId} 写入后未查回目标 Mission`);
    linked.push(verified);
  }
  return linked;
}
