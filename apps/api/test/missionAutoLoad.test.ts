import { describe, expect, it } from "vitest";
import { MISSION_AUTO_LOAD_KIND, missionAutoLoadJobs } from "../src/missionAutoLoad.js";
import type { WorldMissionReader } from "../src/worldMissionLoad.js";
import { createTestDb, TEST_MEMBER } from "./helpers.js";

const AGENTS = "domain-agents";
/** 本体里每个月一条 Mission（负责人是本人，在 Agents 域）；记下按哪几个月列过。 */
function fakeWorld(periods: string[]) {
  const listed: string[] = [];
  const objectOf = (period: string) => `m${period.replace("-", "")}-obj`;
  const head = (period: string) => ({ object_id: objectOf(period), object_type: "Mission", title: `${period} 的 Mission`, version: 1, revision_id: `rev-${period}`,
    object_version: 1, domain_id: AGENTS, external_refs: [], lifecycle: { status: "active", display_name: "进行中" }, contract_version: "tkos.world/0.3" });
  const world = {
    config: { scope_id: "scope-tk", domains: {}, people: { [TEST_MEMBER.personId]: "principal-member" }, capabilities: { [AGENTS]: "04" } },
    listObjects: async (filters: Record<string, unknown>) => {
      if (filters.type !== "Mission") return [];
      listed.push(String(filters.period));
      return periods.includes(String(filters.period)) ? [head(String(filters.period))] : [];
    },
    getObject: async (id: string) => {
      const item = head(`${id.slice(1, 5)}-${id.slice(5, 7)}`);
      return { business: { ...item, attributes: { responsible: "principal-member" }, relations: [], blocks: [] },
        identity: { responsible: { principals: [{ principal_id: "principal-member" }] } }, records: { lifecycle: item.lifecycle }, protocol: { contract_version: item.contract_version } };
    },
  } as unknown as WorldMissionReader;
  return { world, listed };
}

describe("每天自动载入本月和下月的 Mission", () => {
  it("缺省关；开了每天一次，载入公司时区的本月和下月", async () => {
    await createTestDb(async ({ pool }) => {
      const now = () => new Date("2026-11-30T17:00:00.000Z"); // 公司时区 12/1 01:00
      const { world, listed } = fakeWorld(["2026-12", "2027-01"]);
      expect(missionAutoLoadJobs({ enabled: false, pool, world, now })).toEqual({ handlers: {}, recurring: [] });
      expect(missionAutoLoadJobs({ enabled: true, pool, world: null, now })).toEqual({ handlers: {}, recurring: [] });

      const jobs = missionAutoLoadJobs({ enabled: true, pool, world, now });
      expect(jobs.recurring).toEqual([{ kind: MISSION_AUTO_LOAD_KIND, everyMs: 86_400_000 }]);
      await pool.query("INSERT INTO capability_config (id,version,code,name,six_month_outcome) VALUES ('agents',1,'04','智能体','')");
      await jobs.handlers[MISSION_AUTO_LOAD_KIND]({}, { id: "j", kind: MISSION_AUTO_LOAD_KIND, dedupe_key: "k", attempts: 1, payload: {} });
      expect(listed).toEqual(["2026-12", "2027-01"]);
      expect((await pool.query("SELECT period,owner_id,world_object_id FROM missions WHERE world_object_id IS NOT NULL ORDER BY period")).rows).toEqual([
        { period: "2026-12", owner_id: TEST_MEMBER.personId, world_object_id: "m202612-obj" },
        { period: "2027-01", owner_id: TEST_MEMBER.personId, world_object_id: "m202701-obj" },
      ]);
    }, { migrated: true });
  }, 60_000);
});
