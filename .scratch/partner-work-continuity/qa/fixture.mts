import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../../apps/api/src/app.js';
import { migrate } from '../../../apps/api/src/migrate.js';
import { setMemberAccess } from '../../../apps/api/src/memberAccess.js';
import { createMeetingRecordingService, type RecordingDeps } from '../../../apps/api/src/meetingRecordings.js';
import { loadPeopleDirectory } from '../../../apps/api/src/peopleDirectory.js';
import { preflightCandidate, testEnv } from '../../../apps/api/test/helpers.js';
import { createIsolatedPool } from './isolated-pg.mjs';

export const actors = [
  { personId: 'qa-partner-one', displayName: '验收成员甲', loginId: 'qaone', passcode: '2847', roles: ['dri','participant'] },
  { personId: 'qa-partner-two', displayName: '验收成员乙', loginId: 'qatwo', passcode: '5827', roles: ['dri','participant'] },
  { personId: 'qa-partner-three', displayName: '验收成员丙', loginId: 'qathree', passcode: '4681', roles: ['dri','participant'] },
  { personId: 'qa-partner-ceo', displayName: '验收管理帐号', loginId: 'qaceo', passcode: '7162', roles: ['ceo'] },
];

export async function createAcceptanceApp(options: { env?: Partial<Parameters<typeof buildApp>[0]['env']>,
  recordingDeps?: RecordingDeps, worldPeople?: Record<string,string>,
  runtime?: Partial<Omit<Parameters<typeof buildApp>[0], 'pool' | 'env'>> } = {}) {
  const dir = await mkdtemp(fileURLToPath(new URL('./fixture-', import.meta.url)));
  const directory = join(dir, 'people.json');
  await writeFile(directory, JSON.stringify({ schemaVersion: 'company-people.v1',
    people: actors.map(({personId, displayName, roles}) => ({personId, displayName, roles})) }));
  const storage = join(dir, 'files');
  await mkdir(storage);
  const worldMap = join(dir,'world-people.json');
  if (options.worldPeople) await writeFile(worldMap,JSON.stringify({people:options.worldPeople}));
  const { pool, close } = await createIsolatedPool();
  const migrateClient = await pool.connect();
  try { await migrate(migrateClient); } finally { migrateClient.release(); }
  for (const actor of actors) await setMemberAccess(pool.query.bind(pool), { ...actor, mustChange: false });

  const env = { ...testEnv, companyPeopleSeed: directory, materialStorageDir: storage,
    conversationAttachmentStorageDir: storage, recordingStorageDir: storage, publicOrigin: 'https://partner-qa.invalid',
    meetingWorldWritesOff: true, collectionsEnabled: true, ...(options.worldPeople ? {worldInstanceLocalFile:worldMap} : {}), ...options.env };
  const recordingService = options.recordingDeps && createMeetingRecordingService({pool, storageDir:storage,
    peopleDirectory:loadPeopleDirectory(env),publicOrigin:env.publicOrigin,deps:options.recordingDeps});
  const app = await buildApp({pool, env, backgroundPreflight: false, personalMemoryRecall: null,
    conversationRuntime: { async run() { throw new Error('QA scenario attempted an unexpected model call'); } },
    preflightAgent:{async generate(input){return {candidate:preflightCandidate(input.issues.map(issue=>'issue:'+issue.id))};}},
    threadIntroAgent:{async generate(input){return {message:`合成群组：${input.title}`};}},recordingService, ...options.runtime });
  const call = async (actor: string | undefined, method: string, url: string, body?: unknown, headers: Record<string, string> = {}) =>
    await app.inject({ method, url, headers: { origin: env.publicOrigin, ...(actor ? { cookie: actor } : {}), ...headers }, ...(body !== undefined ? { payload: body } : {}) } as any);
  const login = async (index: number) => {
    const { loginId, passcode, personId } = actors[index];
    const response = await call(undefined, 'POST', '/api/auth/login', { loginId, passcode });
    assert.equal(response.statusCode, 200, response.body);
    const cookie = String(response.headers['set-cookie']).split(';')[0];
    const session = await call(cookie, 'GET', '/api/auth/session');
    assert.equal(session.json().personId, personId, session.body);
    return cookie;
  };
  return { app, pool, call, login, dir, storage, env, recordingService, close: async () => {
    try { await app.close(); } finally {
      try { await close(); } finally {
        if(dirname(dir)===dirname(fileURLToPath(import.meta.url)) && /^fixture-[A-Za-z0-9]{6}$/.test(basename(dir)))
          await rm(dir,{recursive:true,force:true});
      }
    }
  } };
}
