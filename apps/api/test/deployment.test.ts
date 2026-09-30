import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const REPO = fileURLToPath(new URL("../../..", import.meta.url));
const COMPOSE_FILE = join(REPO, "infra/docker-compose.yml");
const BACKUP_SH = join(REPO, "infra/backup/backup.sh");
const RESTORE_SH = join(REPO, "infra/backup/restore.sh");
const SMOKE_SH = join(REPO, "infra/staging/smoke.sh");

const tempDirs: string[] = [];
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "warmap-deploy-"));
  tempDirs.push(dir);
  return dir;
}
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function run(script: string, args: string[], env: Record<string, string> = {}) {
  return spawnSync("bash", [script, ...args], {
    cwd: REPO,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

const hasDocker = spawnSync("docker", ["compose", "version"], { encoding: "utf8" }).status === 0;

describe.skipIf(!hasDocker)("Compose deployment boundaries", () => {
  const envFile = join(tempDir(), "compose.env");
  writeFileSync(envFile, [
    "POSTGRES_PASSWORD=dummy-pg",
    "PUBLIC_DOMAIN=staging.example.com",
    "SESSION_SECRET=dummy-session",
    "DRI_SERVICE_TOKEN=dummy-dri",
    "COMPANY_MEMORY_MCP_TOKEN=dummy-mcp",
    "PI_BASE_URL=https://provider.example.com/v1",
    "PI_API_KEY=dummy-key",
    "LIGHT_MODEL=light",
    "HEAVY_MODEL=heavy",
    "COMPACTION_MODEL=compaction",
    "BOCHA_API_KEY=dummy-bocha",
    "WECHAT_MCP_TOKEN=dummy-wechat",
    "",
  ].join("\n"));

  const config = JSON.parse(execFileSync("docker", [
    "compose", "-f", COMPOSE_FILE, "--env-file", envFile, "config", "--format", "json",
  ], { cwd: REPO, encoding: "utf8" })) as {
    services: Record<string, { restart?: string; mem_limit?: string | number; ports?: { published?: string; host_ip?: string }[]; image?: string; environment?: Record<string, string>; volumes?: unknown[]; user?: string; entrypoint?: unknown; depends_on?: Record<string, { condition?: string }> }>;
  };

  it("binds only Caddy to host loopback 3130 (host Nginx terminates TLS) and keeps every other service internal", () => {
    for (const [name, service] of Object.entries(config.services)) {
      const published = (service.ports ?? []).map((port) => `${port.host_ip ?? ""}:${port.published}`);
      if (name === "edge") {
        expect(published).toEqual(["127.0.0.1:3130"]);
      } else {
        expect(published, `${name} 不得暴露公网端口`).toEqual([]);
      }
    }
  });

  it("restarts every long-running service after a crash or host reboot", () => {
    for (const name of ["postgres", "wechat", "api", "web", "edge"]) {
      expect(config.services[name].restart, `${name} 需要自动拉起`).toBe("unless-stopped");
    }
    expect(config.services["storage-init"].restart ?? "no").toBe("no");
  });

  it("caps each long-running service's memory so the shared host (15G, no swap) keeps about 3G for Tianshu", () => {
    let total = 0;
    for (const name of ["postgres", "wechat", "api", "web", "edge"]) {
      const limit = Number(config.services[name].mem_limit);
      expect(limit, `${name} 需要内存上限`).toBeGreaterThan(0);
      total += limit;
    }
    expect(total).toBeLessThanOrEqual(3.2 * 1024 ** 3);
  });

  it("runs the WeChat sidecar as a pinned internal service without Caddy exposure", () => {
    const wechat = config.services.wechat;
    expect(wechat).toBeDefined();
    expect(wechat.image).toMatch(/^tmwgsicp\/wechat-download-api:1\.7\.0@sha256:[a-f0-9]{64}$/);
    expect(wechat.environment).toMatchObject({ ENABLE_MCP: "1", MCP_RESOURCE_URL: "http://wechat:5000/mcp" });
    expect(wechat.ports ?? []).toEqual([]);
  });

  it("does not introduce Redis, queues, object storage, Kubernetes or extra runtimes", () => {
    const text = readFileSync(COMPOSE_FILE, "utf8").toLowerCase();
    for (const forbidden of ["redis", "rabbitmq", "kafka", "minio", "kubernetes", "k8s", "celery"]) {
      expect(text).not.toContain(forbidden);
    }
    expect(Object.keys(config.services).sort()).toEqual(["api", "edge", "postgres", "storage-init", "web", "wechat"]);
  });

  it("initializes material/attachment/recording volume ownership before the non-root api starts", () => {
    const init = config.services["storage-init"];
    expect(init, "storage-init 必须存在").toBeDefined();
    // 一次性 init 才需要 root；API 自身仍非 root
    expect(init.user).toBe("0:0");
    expect(config.services.api.user).toBeUndefined();
    expect(JSON.stringify(init.entrypoint)).toContain("chown -R 1000:1000");
    for (const volume of ["meeting_materials", "conversation_attachments", "meeting_recordings"]) {
      expect(JSON.stringify(init.volumes), `storage-init 必须覆盖 ${volume}`).toContain(volume);
      expect(JSON.stringify(config.services.api.volumes), `api 必须挂载 ${volume}`).toContain(volume);
    }
    expect(config.services.api.depends_on?.["storage-init"]?.condition).toBe("service_completed_successfully");
    expect(config.services.api.environment?.MEETING_RECORDING_STORAGE_DIR).toBe("/var/lib/warmap/meeting_recordings");
  });
});

describe("container images run as non-root", () => {
  it("switches both Web and API images to an unprivileged user", () => {
    for (const dockerfile of ["apps/api/Dockerfile", "apps/web/Dockerfile"]) {
      const text = readFileSync(join(REPO, dockerfile), "utf8");
      expect(text, `${dockerfile} 必须以非 root 运行`).toMatch(/^USER (node|warmap)$/m);
    }
  });
});

describe("backup.sh safety boundaries", () => {
  it("refuses to run without the required offsite/age configuration", () => {
    const result = run(BACKUP_SH, [], { DATABASE_URL: "postgres://u:p@h:5432/db" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("BACKUP_AGE_RECIPIENT");
  });

  it("dry-run prints the plan and writes nothing", () => {
    const dir = tempDir();
    const key = join(dir, "id_ed25519");
    writeFileSync(key, "not-a-real-key\n");
    const result = run(BACKUP_SH, ["--dry-run"], {
      DATABASE_URL: "postgres://u:p@h:5432/db",
      BACKUP_AGE_RECIPIENT: "age1dummy",
      BACKUP_SSH_HOST: "backup.example.com",
      BACKUP_SSH_USER: "warmap",
      BACKUP_SSH_PATH: "/srv/backups",
      BACKUP_SSH_KEY_PATH: key,
      BACKUP_LOCAL_DIR: join(dir, "out"),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dry-run");
    expect(existsSync(join(dir, "out"))).toBe(false);
    // 不打印 secret
    expect(result.stdout).not.toContain("u:p");
  });

  it("rejects a retention shorter than 7 days", () => {
    const dir = tempDir();
    const key = join(dir, "id_ed25519");
    writeFileSync(key, "k\n");
    const result = run(BACKUP_SH, ["--dry-run"], {
      DATABASE_URL: "postgres://u:p@h:5432/db",
      BACKUP_AGE_RECIPIENT: "age1dummy",
      BACKUP_SSH_HOST: "backup.example.com",
      BACKUP_SSH_USER: "warmap",
      BACKUP_SSH_PATH: "/srv/backups",
      BACKUP_SSH_KEY_PATH: key,
      BACKUP_RETENTION_DAYS: "3",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("至少为 7");
  });
});

function stubPath(dir: string, psqlOutput: string): string {
  const bin = join(dir, "bin");
  execFileSync("mkdir", ["-p", bin]);
  writeFileSync(join(bin, "psql"), `#!/usr/bin/env bash\nprintf '%s\\n' "${psqlOutput}"\n`, { mode: 0o755 });
  return `${bin}:${process.env.PATH ?? ""}`;
}

const SECRET_PASSWORD = "postgres-super-secret-DO-NOT-PRINT";

/** 桩：docker/age/scp/ssh + 宿主 pg_dump/psql（url 模式）；记录 docker 参数。 */
function createBackupStubs(dir: string): { bin: string; dockerLog: string; offsite: string } {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  const dockerLog = join(dir, "docker.log");
  writeFileSync(dockerLog, "");
  const offsite = join(dir, "offsite");
  mkdirSync(offsite, { recursive: true });
  writeFileSync(join(bin, "docker"), [
    "#!/usr/bin/env bash",
    `printf '%s\\n' "$*" >> ${dockerLog}`,
    'case "$*" in',
    '  *"ps -q"*) if [ "${WARMAP_TEST_API_RUNNING:-1}" = "1" ]; then echo "container-running-1"; fi ;;',
    '  *pg_dump*) printf "DUMPBYTES" ;;',
    '  *"meeting_material|"*) printf "%s\\n" "meeting_material|meeting-1|meet/m-1|aa11" "conversation_attachment|msg-1|conv/a-1|bb22" ;;',
    '  *psql*) printf "12\\n" ;;',
    '  *"ls -A /data"*) if [ "${WARMAP_TEST_VOLUME_EMPTY:-1}" = "1" ]; then exit 0; else exit 1; fi ;;',
    '  *sha256sum*) last="${!#}"; printf "%s  %s\\n" "${WARMAP_TEST_VOLUME_SHA:-aa11}" "$last" ;;',
    '  *tar*) printf "TARBYTES" ;;',
    "esac",
    "exit 0",
  ].join("\n"), { mode: 0o755 });
  writeFileSync(join(bin, "age"), [
    "#!/usr/bin/env bash",
    'out=""; args=("$@")',
    'for ((i=0;i<$#;i++)); do [ "${args[$i]}" = "-o" ] && out="${args[$((i+1))]}"; done',
    'cp "${args[${#args[@]}-1]}" "$out"',
  ].join("\n"), { mode: 0o755 });
  writeFileSync(join(bin, "scp"), [
    "#!/usr/bin/env bash",
    'args=("$@"); files=(); i=0',
    'while [ $i -lt ${#args[@]} ]; do',
    '  a="${args[$i]}"',
    '  case "$a" in',
    '    -i|-o) i=$((i+2)); continue ;;',
    '    -*) i=$((i+1)); continue ;;',
    '    *) files+=("$a"); i=$((i+1)) ;;',
    "  esac",
    "done",
    'unset "files[${#files[@]}-1]"',
    'cp "${files[@]}" "$WARMAP_TEST_OFFSITE/"',
  ].join("\n"), { mode: 0o755 });
  writeFileSync(join(bin, "ssh"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  writeFileSync(join(bin, "pg_dump"), "#!/usr/bin/env bash\nprintf 'DUMPBYTES'\n", { mode: 0o755 });
  writeFileSync(join(bin, "psql"), "#!/usr/bin/env bash\necho 12\n", { mode: 0o755 });
  return { bin, dockerLog, offsite };
}

function backupEnv(dir: string, extras: Record<string, string>): Record<string, string> {
  const key = join(dir, "id_ed25519");
  const composeEnv = join(dir, "compose.env");
  if (!existsSync(key)) writeFileSync(key, "dummy-key\n");
  if (!existsSync(composeEnv)) writeFileSync(composeEnv, "POSTGRES_PASSWORD=test-only\n");
  return {
    BACKUP_AGE_RECIPIENT: "age1dummy",
    BACKUP_SSH_HOST: "backup.example.com",
    BACKUP_SSH_USER: "warmap",
    BACKUP_SSH_PATH: "/srv/backups",
    BACKUP_SSH_KEY_PATH: key,
    WARMAP_ENV_FILE: composeEnv,
    ...extras,
  };
}

describe("backup.sh source modes", () => {
  it("defaults to compose mode: dumps inside the postgres container without DATABASE_URL or password", () => {
    const dir = tempDir();
    const { bin, dockerLog, offsite } = createBackupStubs(dir);
    const composeFile = join(dir, "docker-compose.yml");
    writeFileSync(composeFile, "services: {}\n");
    const composeEnv = join(dir, "infra.env");
    writeFileSync(composeEnv, `POSTGRES_PASSWORD=${SECRET_PASSWORD}\n`);
    const result = run(BACKUP_SH, [], backupEnv(dir, {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      WARMAP_COMPOSE_FILE: composeFile,
      WARMAP_ENV_FILE: composeEnv,
      WARMAP_TEST_OFFSITE: offsite,
      BACKUP_LOCAL_DIR: join(dir, "local"),
      DATABASE_URL: "",
    }));
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    const calls = readFileSync(dockerLog, "utf8");
    expect(calls).toContain("exec -T postgres pg_dump -U warmap -d warmap --format=custom --no-owner --no-privileges");
    expect(calls).toContain("exec -T postgres psql -U warmap -d warmap");
    // 密码只存在于 env 文件路径，绝不进入命令行、脚本输出或 docker 参数
    expect(calls).not.toContain(SECRET_PASSWORD);
    expect(result.stdout).not.toContain(SECRET_PASSWORD);
    expect(result.stderr).not.toContain(SECRET_PASSWORD);
    const local = readdirSync(join(dir, "local"));
    expect(local.some((f) => f.endsWith(".dump.age"))).toBe(true);
    expect(local.some((f) => f.endsWith(".dump.age.sha256"))).toBe(true);
    expect(local.some((f) => f.endsWith("meeting_materials.tar.gz.age"))).toBe(true);
    expect(local.some((f) => f.endsWith("conversation_attachments.tar.gz.age"))).toBe(true);
    expect(local.some((f) => f.endsWith("meeting_recordings.tar.gz.age"))).toBe(true);
    expect(local.some((f) => f.endsWith("wechat_data.tar.gz.age"))).toBe(true);
    expect(local.some((f) => f.endsWith(".manifest.json"))).toBe(true);
    // dump + manifest + 4 卷，各带 checksum sidecar
    expect(local.length).toBe(12);
    expect(readdirSync(offsite).length).toBe(12);
  });

  it("compose mode freezes only a running api before pg_dump and restarts it last (trap)", () => {
    const dir = tempDir();
    const { bin, dockerLog, offsite } = createBackupStubs(dir);
    const composeFile = join(dir, "docker-compose.yml");
    writeFileSync(composeFile, "services: {}\n");
    const result = run(BACKUP_SH, [], backupEnv(dir, {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      WARMAP_COMPOSE_FILE: composeFile,
      WARMAP_TEST_OFFSITE: offsite,
      BACKUP_LOCAL_DIR: join(dir, "local"),
    }));
    expect(result.status).toBe(0);
    const calls = readFileSync(dockerLog, "utf8").split("\n").filter(Boolean);
    const stopIdx = calls.findIndex((c) => / stop api$/.test(c));
    const dumpIdx = calls.findIndex((c) => c.includes("pg_dump"));
    const startIdx = calls.findIndex((c) => / start api$/.test(c));
    expect(stopIdx).toBeGreaterThan(-1);
    expect(stopIdx, "冻结必须先于 dump").toBeLessThan(dumpIdx);
    expect(startIdx).toBeGreaterThan(dumpIdx);
    // 只冻结 api：postgres/edge/wechat 不出现在 stop/start
    expect(calls.join("\n")).not.toMatch(/ stop (postgres|edge|wechat)$/);
    expect(calls[calls.length - 1]).toMatch(/ start api$/);
    // 四个卷都在同批次归档；公众号卷经 sidecar 自己的镜像
    expect(calls.filter((c) => c.includes("--entrypoint tar")).length).toBe(4);
    expect(calls.some((c) => c.includes("meeting_materials"))).toBe(true);
    expect(calls.some((c) => c.includes("conversation_attachments"))).toBe(true);
    expect(calls.some((c) => c.includes("meeting_recordings"))).toBe(true);
    expect(calls.some((c) => c.includes("--entrypoint tar wechat czf - -C /app/data"))).toBe(true);
    const manifest = readdirSync(join(dir, "local")).find((f) => f.endsWith(".manifest.json"));
    const manifestText = readFileSync(join(dir, "local", manifest ?? ""), "utf8");
    expect(manifestText).toContain("meet/m-1");
    expect(manifestText).toContain("meeting_material|meeting-1|meet/m-1|aa11");
    expect(manifestText).not.toContain("dummy-pg");
  });

  it("compose mode does not stop/start an api that was not running", () => {
    const dir = tempDir();
    const { bin, dockerLog } = createBackupStubs(dir);
    const composeFile = join(dir, "docker-compose.yml");
    writeFileSync(composeFile, "services: {}\n");
    const result = run(BACKUP_SH, [], backupEnv(dir, {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      WARMAP_COMPOSE_FILE: composeFile,
      WARMAP_TEST_OFFSITE: join(dir, "offsite"),
      BACKUP_LOCAL_DIR: join(dir, "local"),
      WARMAP_TEST_API_RUNNING: "0",
    }));
    expect(result.status).toBe(0);
    const calls = readFileSync(dockerLog, "utf8");
    expect(calls).not.toMatch(/ stop api$/);
    expect(calls).not.toMatch(/ start api$/);
  });

  it("target=local keeps encrypted artifacts on this host without SSH settings and passes the compose override", () => {
    const dir = tempDir();
    const { bin, dockerLog, offsite } = createBackupStubs(dir);
    const composeFile = join(dir, "docker-compose.yml");
    writeFileSync(composeFile, "services: {}\n");
    const override = join(dir, "volcano.override.yml");
    writeFileSync(override, "services: {}\n");
    const composeEnv = join(dir, "compose.env");
    writeFileSync(composeEnv, "POSTGRES_PASSWORD=test-only\n");
    const result = run(BACKUP_SH, [], {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      BACKUP_TARGET: "local",
      BACKUP_AGE_RECIPIENT: "age1dummy",
      BACKUP_LOCAL_DIR: join(dir, "local"),
      BACKUP_RETENTION_DAYS: "14",
      WARMAP_COMPOSE_FILE: composeFile,
      WARMAP_COMPOSE_OVERRIDE: override,
      WARMAP_ENV_FILE: composeEnv,
      WARMAP_TEST_OFFSITE: offsite,
    });
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("不是异地备份");
    expect(readdirSync(join(dir, "local")).length).toBe(12);
    expect(readdirSync(offsite).length).toBe(0);
    expect(readFileSync(dockerLog, "utf8")).toContain(`-f ${composeFile} -f ${override}`);
  });

  it("rejects an unknown backup target", () => {
    const dir = tempDir();
    const result = run(BACKUP_SH, ["--dry-run"], backupEnv(dir, { BACKUP_TARGET: "s3" }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("只支持 ssh 或 local");
  });

  it("url mode is database-only and explicitly declares volumes unsupported", () => {
    const dir = tempDir();
    const { bin, dockerLog, offsite } = createBackupStubs(dir);
    const result = run(BACKUP_SH, [], backupEnv(dir, {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      BACKUP_SOURCE_MODE: "url",
      DATABASE_URL: "postgres://user:url-secret@db.internal:5432/warmap",
      WARMAP_TEST_OFFSITE: offsite,
      BACKUP_LOCAL_DIR: join(dir, "local"),
    }));
    expect(result.status).toBe(0);
    expect(readFileSync(dockerLog, "utf8")).toBe("");
    expect(result.stdout).toContain("仅备份数据库");
    expect(result.stdout).toContain("不能用于卷恢复");
  });

  it("dry-run reports compose mode, the exact command shape and writes nothing", () => {
    const dir = tempDir();
    const result = run(BACKUP_SH, ["--dry-run"], backupEnv(dir, { BACKUP_LOCAL_DIR: join(dir, "local"), DATABASE_URL: "" }));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("source_mode=compose");
    expect(result.stdout).toContain("docker compose -f");
    expect(result.stdout).toContain("exec -T postgres pg_dump -U warmap -d warmap --format=custom --no-owner --no-privileges");
    expect(result.stdout).toContain("未执行任何写入、未连接数据库、未触达远端");
    expect(existsSync(join(dir, "local"))).toBe(false);
  });

  it("still supports BACKUP_SOURCE_MODE=url with host pg_dump/psql", () => {
    const dir = tempDir();
    const { bin, dockerLog, offsite } = createBackupStubs(dir);
    const result = run(BACKUP_SH, [], backupEnv(dir, {
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      BACKUP_SOURCE_MODE: "url",
      DATABASE_URL: "postgres://user:url-secret@db.internal:5432/warmap",
      WARMAP_TEST_OFFSITE: offsite,
      BACKUP_LOCAL_DIR: join(dir, "local"),
    }));
    expect(result.status).toBe(0);
    expect(readFileSync(dockerLog, "utf8")).toBe("");
    expect(result.stdout).toContain("source_mode=url");
    expect(result.stdout).not.toContain("url-secret");
    expect(readdirSync(join(dir, "local")).some((f) => f.endsWith(".dump.age"))).toBe(true);
  });

  it("url mode requires DATABASE_URL", () => {
    const dir = tempDir();
    const result = run(BACKUP_SH, ["--dry-run"], backupEnv(dir, { BACKUP_SOURCE_MODE: "url", DATABASE_URL: "" }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("DATABASE_URL");
  });

  it("rejects an unknown source mode with a readable message", () => {
    const dir = tempDir();
    const result = run(BACKUP_SH, ["--dry-run"], backupEnv(dir, { BACKUP_SOURCE_MODE: "bogus" }));
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("只支持 compose 或 url");
    expect(result.stderr).not.toContain("unbound variable");
  });
});

describe("restore.sh destructive boundaries", () => {
  function fixture() {
    const dir = tempDir();
    const backup = join(dir, "warmap-test.dump.age");
    writeFileSync(backup, "encrypted-bytes");
    const digest = createHash("sha256").update("encrypted-bytes").digest("hex");
    writeFileSync(`${backup}.sha256`, `${digest}  warmap-test.dump.age\n`);
    const identity = join(dir, "age-identity.txt");
    writeFileSync(identity, "AGE-SECRET-KEY-DUMMY\n");
    return { dir, backup, identity, digest };
  }


  it("defaults to dry-run and refuses to touch a non-empty target database", () => {
    const { dir, backup, identity } = fixture();
    const result = run(RESTORE_SH, ["--backup", backup, "--target-url", "postgres://u:p@restore/db", "--age-identity", identity], {
      PATH: stubPath(dir, "3"),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("拒绝覆盖");
  });

  it("verifies the checksum before any decryption", () => {
    const { dir, backup, identity } = fixture();
    writeFileSync(`${backup}.sha256`, `${"0".repeat(64)}  warmap-test.dump.age\n`);
    const result = run(RESTORE_SH, ["--backup", backup, "--target-url", "postgres://u:p@restore/db", "--age-identity", identity], {
      PATH: stubPath(dir, "0"),
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("checksum 不匹配");
  });

  it("refuses when the target equals the production DATABASE_URL", () => {
    const { backup, identity } = fixture();
    const result = run(RESTORE_SH, ["--backup", backup, "--target-url", "postgres://prod/db", "--age-identity", identity], {
      DATABASE_URL: "postgres://prod/db",
    });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("拒绝恢复");
  });

  it("passes only when the target is empty, and --execute is required to write", () => {
    const { dir, backup, identity } = fixture();
    const result = run(RESTORE_SH, ["--backup", backup, "--target-url", "postgres://u:p@restore/db", "--age-identity", identity], {
      PATH: stubPath(dir, "0"),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dry-run");
    expect(result.stdout).toContain("加 --execute");
  });
});

function volumeFixture(dir: string, opts: { volumeEmpty: boolean; rows: string; volumeSha: string }): { env: Record<string, string> } {
  const bin = join(dir, "bin");
  mkdirSync(bin, { recursive: true });
  writeFileSync(join(bin, "psql"), [
    "#!/usr/bin/env bash",
    'case "$*" in',
    '  *"meeting_material|"*) printf "%s\\n" ${WARMAP_TEST_ROWS} ;;',
    '  *) echo "0" ;;',
    "esac",
  ].join("\n"), { mode: 0o755 });
  writeFileSync(join(bin, "docker"), [
    "#!/usr/bin/env bash",
    'case "$*" in',
    '  *"ls -A /data"*) if [ "${WARMAP_TEST_VOLUME_EMPTY:-1}" = "1" ]; then exit 0; else exit 1; fi ;;',
    '  *sha256sum*) last="${!#}"; printf "%s  %s\\n" "${WARMAP_TEST_VOLUME_SHA}" "$last" ;;',
    "esac",
    "exit 0",
  ].join("\n"), { mode: 0o755 });
  writeFileSync(join(bin, "age"), [
    "#!/usr/bin/env bash",
    'out=""; args=("$@")',
    'for ((i=0;i<$#;i++)); do [ "${args[$i]}" = "-o" ] && out="${args[$((i+1))]}"; done',
    'printf "RESTORED-DUMP" > "$out"',
  ].join("\n"), { mode: 0o755 });
  writeFileSync(join(bin, "pg_restore"), "#!/usr/bin/env bash\nexit 0\n", { mode: 0o755 });
  return { env: {
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    WARMAP_TEST_VOLUME_EMPTY: opts.volumeEmpty ? "1" : "0",
    WARMAP_TEST_ROWS: opts.rows,
    WARMAP_TEST_VOLUME_SHA: opts.volumeSha,
  } };
}

function volumeBackupFixture(dir: string): { meetingArchive: string; attachmentArchive: string; meetingVolume: string; attachmentVolume: string; manifest: string; args: string[] } {
  const dump = join(dir, "warmap-test.dump.age");
  writeFileSync(dump, "encrypted-bytes");
  writeFileSync(`${dump}.sha256`, `${createHash("sha256").update("encrypted-bytes").digest("hex")}  warmap-test.dump.age\n`);
  writeFileSync(join(dir, "age-identity.txt"), "AGE-SECRET-KEY-DUMMY\n");
  const meetingArchive = join(dir, "warmap-x.meeting_materials.tar.gz.age");
  const attachmentArchive = join(dir, "warmap-x.conversation_attachments.tar.gz.age");
  const recordingArchive = join(dir, "warmap-x.meeting_recordings.tar.gz.age");
  const wechatArchive = join(dir, "warmap-x.wechat_data.tar.gz.age");
  for (const [file, content] of [[meetingArchive, "mm-bytes"], [attachmentArchive, "att-bytes"], [recordingArchive, "rec-bytes"], [wechatArchive, "wx-bytes"]] as const) {
    writeFileSync(file, content);
    writeFileSync(`${file}.sha256`, `${createHash("sha256").update(content).digest("hex")}  ${file.split("/").pop()}\n`);
  }
  const manifest = join(dir, "warmap-x.manifest.json");
  writeFileSync(manifest, JSON.stringify({ batch: "warmap-x", storageRows: [] }));
  const meetingVolume = "meeting_materials_restore";
  const attachmentVolume = "conversation_attachments_restore";
  const args = [
    "--meeting-materials-archive", meetingArchive, "--meeting-materials-volume", meetingVolume,
    "--conversation-attachments-archive", attachmentArchive, "--conversation-attachments-volume", attachmentVolume,
    "--meeting-recordings-archive", recordingArchive, "--meeting-recordings-volume", "meeting_recordings_restore",
    "--wechat-data-archive", wechatArchive, "--wechat-data-volume", "wechat_data_restore",
  ];
  return { meetingArchive, attachmentArchive, meetingVolume, attachmentVolume, manifest, args };
}

describe("restore.sh volume-backed recovery", () => {
  it("refuses a non-empty target volume before any write (even in dry-run)", () => {
    const dir = tempDir();
    const v = volumeBackupFixture(dir);
    const { env } = volumeFixture(dir, { volumeEmpty: false, rows: "", volumeSha: "x" });
    const result = run(RESTORE_SH, [
      "--backup", join(dir, "warmap-test.dump.age"),
      "--target-url", "postgres://u:p@restore/db",
      "--age-identity", join(dir, "age-identity.txt"),
      ...v.args,
    ], env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("目标 volume 非空");
  });

  it("fails closed when a restored volume file SHA does not match the restored DB rows", () => {
    const dir = tempDir();
    const v = volumeBackupFixture(dir);
    const { env } = volumeFixture(dir, {
      volumeEmpty: true,
      rows: `meeting_material|meeting-1|meet/m-1|${"a".repeat(64)}`,
      volumeSha: "b".repeat(64),
    });
    const result = run(RESTORE_SH, ["--backup", join(dir, "warmap-test.dump.age"), "--target-url", "postgres://u:p@restore/db", "--age-identity", join(dir, "age-identity.txt"),
      ...v.args,
      "--execute"], env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("存储校验失败");
  });

  // 真实 shell + 多个 stub 子进程（age/scp/docker/psql/sha256sum），全量并行跑时会超过默认 5s，给足墙钟时间
  it("passes with explicit empty volumes and verifies every DB storageKey/SHA against the volumes", { timeout: 30_000 }, () => {
    const dir = tempDir();
    const v = volumeBackupFixture(dir);
    const rows = `meeting_material|meeting-1|meet/m-1|${"a".repeat(64)} conversation_attachment|msg-1|conv/a-1|${"b".repeat(64)}`;
    const { env } = volumeFixture(dir, { volumeEmpty: true, rows, volumeSha: "a".repeat(64) });
    // sha256sum stub 对每个文件都返回同一摘要：第二行(反例)只在混合摘要时失败——这里两行分别校验
    const result = run(RESTORE_SH, ["--backup", join(dir, "warmap-test.dump.age"), "--target-url", "postgres://u:p@restore/db", "--age-identity", join(dir, "age-identity.txt"),
      ...v.args,
      "--execute"], { ...env, WARMAP_TEST_VOLUME_SHA: "a".repeat(64) });
    // 第二行的 DB sha 是 b…，而卷始终返回 a… → 必须失败
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("存储校验失败");

    // 全行匹配的成功路径：两行都是 a…
    const rowsMatch = `meeting_material|meeting-1|meet/m-1|${"a".repeat(64)} conversation_attachment|msg-1|conv/a-1|${"a".repeat(64)}`;
    const dir2 = tempDir();
    const v2 = volumeBackupFixture(dir2);
    const env2 = volumeFixture(dir2, { volumeEmpty: true, rows: rowsMatch, volumeSha: "a".repeat(64) });
    const ok = run(RESTORE_SH, ["--backup", join(dir2, "warmap-test.dump.age"), "--target-url", "postgres://u:p@restore/db", "--age-identity", join(dir2, "age-identity.txt"),
      ...v2.args,
      "--execute"], env2.env);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain("存储校验通过（2 行");
  });

  it("refuses a partial volume set (e.g. without recordings and WeChat data)", () => {
    const dir = tempDir();
    const v = volumeBackupFixture(dir);
    const { env } = volumeFixture(dir, { volumeEmpty: true, rows: "", volumeSha: "x" });
    const result = run(RESTORE_SH, ["--backup", join(dir, "warmap-test.dump.age"), "--target-url", "postgres://u:p@restore/db", "--age-identity", join(dir, "age-identity.txt"),
      ...v.args.slice(0, 8)], env);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("卷恢复参数不完整");
  });

  it("database-only restore is allowed but explicitly declares volumes unsupported", () => {
    const dir = tempDir();
    volumeBackupFixture(dir);
    const result = run(RESTORE_SH, ["--backup", join(dir, "warmap-test.dump.age"), "--target-url", "postgres://u:p@restore/db", "--age-identity", join(dir, "age-identity.txt")], {
      PATH: stubPath(dir, "0"),
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("数据库-only 恢复");
    expect(result.stdout).toContain("不是完整恢复");
  });
});

describe("staging smoke script", () => {
  it("supports a deterministic dry-run of the checklist", () => {
    const result = run(SMOKE_SH, ["--dry-run"], { PUBLIC_ORIGIN: "https://staging.example.com" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dry-run");
    expect(result.stdout).toContain("/healthz");
  });
});
