/** 审核演示 API：先装好演示环境（env.ts），再跑真正的 apps/api/src/server.ts。cwd 要是 apps/api。 */
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import { WORKTREE, loadReviewEnv } from "./env.js";

loadReviewEnv();
await import(pathToFileURL(join(WORKTREE, "apps/api/src/server.ts")).href);
