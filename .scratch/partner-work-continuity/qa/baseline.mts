import assert from 'node:assert/strict';
import { createAcceptanceApp } from './fixture.mts';

const f = await createAcceptanceApp();
try {
  const a = await f.login(0), b = await f.login(1), c = await f.login(2);
  const project = await f.call(a, 'POST', '/api/me/projects', {name:'独立验收项目'});
  assert.equal(project.statusCode, 201, project.body);
  const url = `/api/me/projects/${project.json().projectId}`;
  const [owner, other, outsider] = [await f.call(a, 'GET', url), await f.call(b, 'GET', url), await f.call(c, 'GET', url)];
  assert.equal(owner.statusCode, 200, owner.body);
  assert.equal(other.statusCode, 404, other.body);
  assert.equal(outsider.statusCode, 404, outsider.body);
  console.log(JSON.stringify({ realFastify: true, database: 'PostgreSQL 17.5 WASM', identities: 3,
    projectReadByIdentity: [owner.statusCode, other.statusCode, outsider.statusCode], version: (await f.pool.query('SELECT MAX(id) AS version FROM schema_migrations')).rows[0].version }));
} finally { await f.close(); }
