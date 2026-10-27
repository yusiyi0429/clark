import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";

const source = process.argv[2];
if (!source) throw new Error("Usage: node scripts/sync-chat-task-quality.mjs <Chat_Service checkout>");
const root = resolve(source);
const content = await readFile(resolve(root, "src/task-quality-contract.ts"));
const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
if (!content.equals(execFileSync("git", ["show", `${commit}:src/task-quality-contract.ts`], { cwd: root })))
  throw new Error("Commit the Chat contract before exporting its pinned snapshot.");
await writeFile(new URL("../packages/contracts/src/vendor/chat-task-quality.ts", import.meta.url), content);
await writeFile(new URL("../packages/contracts/src/vendor/chat-task-quality.json", import.meta.url), JSON.stringify({
  repository: "TokenkingOS/Chat_Service", path: "src/task-quality-contract.ts", commit,
  sha256: createHash("sha256").update(content).digest("hex"),
}, null, 2) + "\n");
