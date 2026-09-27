/** 只控制当前这套 02 一次性夹具：写命令文件，等夹具按 id 回应。 */
const { randomUUID } = require("node:crypto");
const { readFile, rename, writeFile } = require("node:fs/promises");
const { join } = require("node:path");

const [command, arg] = process.argv.slice(2);
if (!/^(inspect|seed-signals|run-state|welcome|close)$/.test(command || "")) {
  process.stderr.write("Usage: node radar-control.cjs inspect|seed-signals|run-state <queued|failed|completed-empty>|welcome <member|ceo|new>|close\n");
  process.exitCode = 2;
} else main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Fixture control failed"}\n`);
  process.exitCode = 1;
});

async function main() {
  const metadata = JSON.parse(await readFile(join(__dirname, "radar-fixture.json"), "utf8"));
  if (!metadata.ready || metadata.port !== 4500 || !/^warmap_test_[a-f0-9]{12}$/.test(metadata.database) || typeof metadata.fixtureId !== "string") {
    throw new Error("No active 02 radar fixture");
  }
  process.kill(metadata.pid, 0);
  const id = randomUUID();
  const path = join(__dirname, "radar-command.json");
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ id, fixtureId: metadata.fixtureId, command, arg })}\n`);
  await rename(temporary, path);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    let response;
    try { response = JSON.parse(await readFile(join(__dirname, "radar-response.json"), "utf8")); }
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
