import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
    "CEO_ACCESS_PASSWORD_HASH=scrypt:a:b",
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
    services: Record<string, { ports?: { published?: string }[]; image?: string; environment?: Record<string, string>; volumes?: unknown[] }>;
  };

  it("exposes 80/443 only through Caddy and keeps every other service internal", () => {
    for (const [name, service] of Object.entries(config.services)) {
      const published = (service.ports ?? []).map((port) => String(port.published));
      if (name === "edge") {
        expect(published.sort()).toEqual(["443", "80"]);
      } else {
        expect(published, `${name} 不得暴露公网端口`).toEqual([]);
      }
    }
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
    expect(Object.keys(config.services).sort()).toEqual(["api", "edge", "postgres", "web", "wechat"]);
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

  function stubPath(dir: string, psqlOutput: string): string {
    const bin = join(dir, "bin");
    execFileSync("mkdir", ["-p", bin]);
    writeFileSync(join(bin, "psql"), `#!/usr/bin/env bash\nprintf '%s\\n' "${psqlOutput}"\n`, { mode: 0o755 });
    return `${bin}:${process.env.PATH ?? ""}`;
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

describe("staging smoke script", () => {
  it("supports a deterministic dry-run of the checklist", () => {
    const result = run(SMOKE_SH, ["--dry-run"], { PUBLIC_ORIGIN: "https://staging.example.com" });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("dry-run");
    expect(result.stdout).toContain("/healthz");
  });
});
