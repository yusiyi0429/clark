import { createRequire } from 'node:module';
import { isAbsolute } from 'node:path';

const fromApi = createRequire(new URL('../../../apps/api/package.json', import.meta.url));
const fromClarkLab = createRequire(new URL('../../../../../../../Chat_Service-lab/package.json', import.meta.url));
const preferred = process.env.PARTNER_QA_PGLITE_MODULE;
if (preferred && !isAbsolute(preferred)) throw Error('PARTNER_QA_PGLITE_MODULE must be an absolute package directory or CommonJS module path');

function resolveEngine() {
  if (preferred) return fromApi(preferred).PGlite;
  for (const resolver of [fromApi, fromClarkLab]) {
    try { return resolver('@electric-sql/pglite').PGlite; }
    catch (error) { if (error.code !== 'MODULE_NOT_FOUND') throw error; }
  }
  throw Error('Install @electric-sql/pglite in the project or set PARTNER_QA_PGLITE_MODULE to an installed copy');
}
export const PGlite = resolveEngine();
