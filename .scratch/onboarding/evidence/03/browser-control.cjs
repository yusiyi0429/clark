/** Control only the active disposable 03 fixture through its in-process application clock. */
const { randomUUID } = require("node:crypto");
const { readFile, rename, writeFile } = require("node:fs/promises");
const { join } = require("node:path");

const command = process.argv[2];
if (!/^(inspect|target-none|target-negotiating|target-issued|draft|open|near|advance|reopen|confirm|welcome-member|welcome-ceo|close)$/.test(command || "") || process.argv.length !== 3) {
  process.stderr.write("Usage: node browser-control.cjs inspect|target-none|target-negotiating|target-issued|draft|open|near|advance|reopen|confirm|welcome-member|welcome-ceo|close\n");
  process.exitCode = 2;
} else main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Fixture control failed"}\n`);
  process.exitCode = 1;
});

async function main() {
  const metadata = JSON.parse(await readFile(join(__dirname, "browser-fixture.json"), "utf8"));
  if (!metadata.ready || metadata.port !== 4500 || !/^warmap_test_[a-f0-9]{12}$/.test(metadata.database)
    || !Number.isSafeInteger(metadata.pid) || typeof metadata.fixtureId !== "string") throw new Error("No active 03 browser fixture");
  process.kill(metadata.pid, 0);
  const id = randomUUID();
  const path = join(__dirname, "browser-command.json");
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ id, fixtureId: metadata.fixtureId, command })}\n`);
  await rename(temporary, path);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    let response;
    try { response = JSON.parse(await readFile(join(__dirname, "browser-response.json"), "utf8")); }
    catch (error) { if (error.code !== "ENOENT" && !(error instanceof SyntaxError)) throw error; }
    if (response?.id === id && response.fixtureId === metadata.fixtureId) {
      process.stdout.write(`${JSON.stringify(response, null, 2)}\n`);
      if (!response.ok) process.exitCode = 1;
      return;
    }
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("Fixture did not acknowledge the command within 30 seconds; do not assume it succeeded");
}

