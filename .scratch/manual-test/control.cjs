/** 控制正在运行的手动测试环境：拨应用时钟、推进本月卡、重置引导。用法见 README.md。 */
const { randomUUID } = require("node:crypto");
const { readFile, rename, writeFile } = require("node:fs/promises");
const { join } = require("node:path");

const command = process.argv[2];
if (!/^(inspect|target-none|target-negotiating|target-issued|draft|open|near|advance|reopen|confirm|confirm-all|next-month|welcome-member|welcome-dri|welcome-ceo|welcome-luyao|close)$/.test(command || "") || process.argv.length !== 3) {
  process.stderr.write("用法: node control.cjs inspect|target-none|target-negotiating|target-issued|draft|open|near|advance|reopen|confirm|confirm-all|next-month|welcome-member|welcome-dri|welcome-ceo|welcome-luyao|close\n");
  process.exitCode = 2;
} else main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : "Fixture control failed"}\n`);
  process.exitCode = 1;
});

async function main() {
  const metadata = JSON.parse(await readFile(join(__dirname, "run", "fixture.json"), "utf8"));
  if (!metadata.ready || metadata.port !== 4500 || !/^warmap_test_[a-f0-9]{12}$/.test(metadata.database)
    || !Number.isSafeInteger(metadata.pid) || typeof metadata.fixtureId !== "string") throw new Error("手动测试环境没有在运行（先执行 start.ps1）");
  process.kill(metadata.pid, 0);
  const id = randomUUID();
  const path = join(__dirname, "run", "command.json");
  const temporary = `${path}.${process.pid}.tmp`;
  await writeFile(temporary, `${JSON.stringify({ id, fixtureId: metadata.fixtureId, command })}\n`);
  await rename(temporary, path);
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    let response;
    try { response = JSON.parse(await readFile(join(__dirname, "run", "response.json"), "utf8")); }
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

