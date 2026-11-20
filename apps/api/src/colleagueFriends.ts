import type { Pool } from "pg";
import type { TFriendGrant, TFriendRelation, TFriendSettings, TFriendView } from "@warmap/contracts";
import { isCovered } from "./colleagueAccess.js";
import { inTransaction } from "./collector.js";
import type { Query } from "./meetingStore.js";
import type { PeopleDirectory } from "./peopleDirectory.js";

/**
 * 同事好友（设计稿第 3 节）：关系双向、一对一行（low_id < high_id，按库里的排序算），授权分方向（grantor 给 grantee）。
 * 好友只管对话五样以外的事；能不能做只在 colleagueAccess 判。
 */
export class FriendError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}

const DEFAULT_SETTINGS: TFriendSettings = { admission: "auto", defaults: { agentAsk: true } };
const PAIR = "low_id=least($1::text,$2::text) AND high_id=greatest($1::text,$2::text)";
type Pair = { status: "pending" | "friends" | "removed"; requested_by: string };

/** 设置没有行时：直接通过，新好友默认开放「他的伙伴替他来问」。 */
export async function readFriendSettings(q: Query, personId: string): Promise<TFriendSettings> {
  const row = (await q("SELECT admission,default_agent_ask FROM colleague_friend_settings WHERE person_id=$1", [personId])).rows[0];
  return row ? { admission: row.admission, defaults: { agentAsk: row.default_agent_ask } } : DEFAULT_SETTINGS;
}

export async function saveFriendSettings(q: Query, personId: string, settings: TFriendSettings, now: Date): Promise<TFriendSettings> {
  await q(`INSERT INTO colleague_friend_settings (person_id,admission,default_agent_ask,updated_at) VALUES ($1,$2,$3,$4)
    ON CONFLICT (person_id) DO UPDATE SET admission=EXCLUDED.admission,default_agent_ask=EXCLUDED.default_agent_ask,updated_at=EXCLUDED.updated_at`,
  [personId, settings.admission, settings.defaults.agentAsk, now]);
  return settings;
}

const pairRow = async (q: Query, a: string, b: string): Promise<Pair | undefined> =>
  (await q(`SELECT status,requested_by FROM colleague_friendships WHERE ${PAIR}`, [a, b])).rows[0];

const toRelation = (viewer: string, row: Pair | undefined): TFriendRelation =>
  !row || row.status === "removed" ? "none" : row.status === "friends" ? "friends" : row.requested_by === viewer ? "pending_out" : "pending_in";

export async function relationOf(q: Query, viewer: string, other: string): Promise<TFriendRelation> {
  return toRelation(viewer, await pairRow(q, viewer, other));
}

/** 别人加了 viewer、等 viewer 点开放的。 */
export async function listFriendRequests(q: Query, viewer: string): Promise<{ personId: string; at: string }[]> {
  const rows = (await q(`SELECT requested_by,requested_at FROM colleague_friendships
    WHERE status='pending' AND requested_by<>$1 AND (low_id=$1 OR high_id=$1) ORDER BY requested_at`, [viewer])).rows;
  return rows.map((row) => ({ personId: row.requested_by as string, at: (row.requested_at as Date).toISOString() }));
}

const grantOf = async (q: Query, grantor: string, grantee: string): Promise<TFriendGrant | null> => {
  const row = (await q("SELECT agent_ask FROM colleague_friend_grants WHERE grantor_id=$1 AND grantee_id=$2", [grantor, grantee])).rows[0];
  return row ? { agentAsk: row.agent_ask } : null;
};
const writeGrant = (q: Query, grantor: string, grantee: string, grant: TFriendGrant, now: Date) =>
  q(`INSERT INTO colleague_friend_grants (grantor_id,grantee_id,agent_ask,updated_at) VALUES ($1,$2,$3,$4)
    ON CONFLICT (grantor_id,grantee_id) DO UPDATE SET agent_ask=EXCLUDED.agent_ask,updated_at=EXCLUDED.updated_at`, [grantor, grantee, grant.agentAsk, now]);
/** 成为好友：关系改 friends，两个方向的授权各写一条。 */
const befriend = async (q: Query, viewer: string, other: string, mine: TFriendGrant, theirs: TFriendGrant, now: Date) => {
  await q(`UPDATE colleague_friendships SET status='friends',decided_at=$3 WHERE ${PAIR}`, [viewer, other, now]);
  await writeGrant(q, viewer, other, mine, now);
  await writeGrant(q, other, viewer, theirs, now);
};

export type FriendDeps = { q: Query; pool: Pool; directory: PeopleDirectory; now: () => Date };

/** 自己或不被覆盖的人：和没有这个人一样。 */
function checkPerson(deps: FriendDeps, viewer: string, other: string) {
  if (viewer === other || !isCovered(deps.directory, other)) throw new FriendError(404, "PERSON_NOT_FOUND", "人员目录里没有这个人");
}

export async function readFriend(deps: FriendDeps, viewer: string, other: string): Promise<TFriendView> {
  checkPerson(deps, viewer, other);
  const { q } = deps;
  const displayName = deps.directory.searchPeople(undefined).find((person) => person.personId === other)!.displayName;
  return { person: { personId: other, displayName, left: false }, relation: await relationOf(q, viewer, other),
    theirs: await grantOf(q, other, viewer), mine: await grantOf(q, viewer, other) };
}

/** 同一对人的关系串行写。 */
async function locked(deps: FriendDeps, viewer: string, other: string, work: (q: Query, now: Date) => Promise<void>): Promise<TFriendView> {
  checkPerson(deps, viewer, other);
  await inTransaction(deps.pool, async (q) => {
    await q("SELECT pg_advisory_xact_lock(hashtextextended('colleague-friend/'||least($1::text,$2::text)||'/'||greatest($1::text,$2::text),0))", [viewer, other]);
    await work(q, deps.now());
  });
  return readFriend(deps, viewer, other);
}

/** 加好友：对方直接通过（或对方先加了我）就成好友，两个方向各取授权人自己的默认；要对方同意就先等；已有的原样回，移除过的可再加。 */
export const requestFriend = (deps: FriendDeps, viewer: string, other: string) => locked(deps, viewer, other, async (q, now) => {
  const row = await pairRow(q, viewer, other);
  if (row?.status === "friends" || (row?.status === "pending" && row.requested_by === viewer)) return;
  const friendsNow = row?.status === "pending" || (await readFriendSettings(q, other)).admission === "auto";
  if (row?.status !== "pending") await q(`INSERT INTO colleague_friendships (low_id,high_id,status,requested_by,requested_at,decided_at)
    VALUES (least($1::text,$2::text),greatest($1::text,$2::text),'pending',$1,$3,NULL)
    ON CONFLICT (low_id,high_id) DO UPDATE SET status='pending',requested_by=$1,requested_at=$3,decided_at=NULL`, [viewer, other, now]);
  if (friendsNow) await befriend(q, viewer, other, (await readFriendSettings(q, viewer)).defaults, (await readFriendSettings(q, other)).defaults, now);
});

/** 开放：只有对方加了我、等我点的才行；我的授权用入参，对方的取对方的默认。 */
export const acceptFriend = (deps: FriendDeps, viewer: string, other: string, grant: TFriendGrant) => locked(deps, viewer, other, async (q, now) => {
  if (toRelation(viewer, await pairRow(q, viewer, other)) !== "pending_in") throw new FriendError(409, "NOT_PENDING", "没有等你同意的好友请求");
  await befriend(q, viewer, other, grant, (await readFriendSettings(q, other)).defaults, now);
});

/** 删：还在等的删掉这一行（哪个方向都算）；好友改成移除，两个方向的授权都删。只管以后，不通知。 */
export const removeFriend = (deps: FriendDeps, viewer: string, other: string) => locked(deps, viewer, other, async (q, now) => {
  const row = await pairRow(q, viewer, other);
  if (row?.status === "pending") await q(`DELETE FROM colleague_friendships WHERE ${PAIR}`, [viewer, other]);
  if (row?.status !== "friends") return;
  await q(`UPDATE colleague_friendships SET status='removed',decided_at=$3 WHERE ${PAIR}`, [viewer, other, now]);
  await q("DELETE FROM colleague_friend_grants WHERE (grantor_id=$1 AND grantee_id=$2) OR (grantor_id=$2 AND grantee_id=$1)", [viewer, other]);
});

/** 改我给这位好友的勾选。 */
export const saveFriendGrant = (deps: FriendDeps, viewer: string, other: string, grant: TFriendGrant) => locked(deps, viewer, other, async (q, now) => {
  if ((await pairRow(q, viewer, other))?.status !== "friends") throw new FriendError(409, "NOT_FRIENDS", "你们还不是好友");
  await writeGrant(q, viewer, other, grant, now);
});
