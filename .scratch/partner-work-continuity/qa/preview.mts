import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { actors, createAcceptanceApp } from './fixture.mts';

const repo = fileURLToPath(new URL('../../../', import.meta.url));
const webDir = join(repo, 'apps', 'web');
const qaDir = fileURLToPath(new URL('./', import.meta.url));
const runDir = join(qaDir, 'preview-' + new Date().toISOString().replace(/[:.]/g, '-'));
await mkdir(runDir);
const log = createWriteStream(join(runDir, 'next.log'));
const status: Record<string, unknown> = { startedAt: new Date().toISOString(), supervisorPid: process.pid, state: 'starting' };
const save = () => writeFile(join(runDir, 'status.json'), JSON.stringify(status, null, 2));
const announce = (event: string, details: Record<string, unknown> = {}) => console.log(JSON.stringify({ event, ...details }));
let fixture: Awaited<ReturnType<typeof createAcceptanceApp>> | undefined;
let nextProcess: ChildProcess | undefined;

async function freePort() {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  return address.port;
}

async function stop() {
  if (nextProcess?.pid && nextProcess.exitCode === null) {
    const pid = nextProcess.pid;
    if (process.platform === 'win32') {
      await new Promise<void>(resolve => {
        const kill = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        kill.once('error', () => { nextProcess?.kill(); resolve(); });
        kill.once('exit', () => resolve());
      });
    } else nextProcess.kill('SIGTERM');
    announce('next_stopped', { pid });
  }
  if (fixture) {
    await fixture.close();
    fixture = undefined;
    announce('fixture_stopped');
  }
  log.end();
}

try {
  let locked = false;
  try { await access(join(webDir, '.next', 'dev', 'lock')); locked = true; } catch {}
  announce('next_lock_check', { lockPresent: locked });
  // Next 自己获取运行锁，残留锁文件也交给它判断，不删除或终止既有实例。
  const webPort = await freePort();
  assert.notEqual(webPort, 3700);
  const webOrigin = 'http://127.0.0.1:' + webPort;
  status.webOrigin = webOrigin;
  fixture = await createAcceptanceApp({ env: { publicOrigin: webOrigin } });
  const sessions = [];
  for (let index = 0; index < 2; index++) {
    const cookie = await fixture.login(index);
    sessions.push(cookie);
    for (const [method, url, body] of [
      ['POST', '/api/me/onboarding/complete', {}],
      ['PUT', '/api/me/buddy', { name: index ? '乙伙伴' : '甲伙伴', form: 'classic', personality: 'steady' }],
      ['POST', '/api/me/projects', { name: index ? '乙的合成项目' : '甲的合成项目' }],
    ] as const) {
      const result = await fixture.call(cookie, method, url, body);
      assert.ok([200, 201].includes(result.statusCode), result.body);
    }
  }
  const share = await fixture.call(sessions[0], 'POST', '/api/me/team-deliveries', {
    clientId: randomUUID(), kind: 'question', recipientIds: [actors[1].personId], text: '请乙确认合成项目的下一步。',
  });
  assert.equal(share.statusCode, 200, share.body);
  const apiOrigin = await fixture.app.listen({ host: '127.0.0.1', port: 0 });
  assert.ok(apiOrigin.startsWith('http://127.0.0.1:'));
  status.apiOrigin = apiOrigin;
  status.accounts = actors.slice(0, 2).map(({ displayName, loginId, passcode }) => ({ displayName, loginId, passcode }));
  const nextCli = join(webDir, 'node_modules', 'next', 'dist', 'bin', 'next');
  // The acceptance preview uses Webpack while investigating grouped-route 404s after a Turbopack restart.
  nextProcess = spawn(process.execPath, [nextCli, 'dev', '--webpack', '--hostname', '127.0.0.1', '--port', String(webPort)], {
    cwd: webDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, API_SERVER_URL: apiOrigin, M2_SERVER_URL: apiOrigin, NEXT_TELEMETRY_DISABLED: '1' },
  });
  status.nextPid = nextProcess.pid;
  await save();
  announce('started', { webOrigin, apiOrigin, nextPid: nextProcess.pid, runDir });
  let tail = '';
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Next dev readiness timed out')), 55_000);
    const onOutput = (chunk: Buffer) => {
      const text = chunk.toString();
      log.write(text);
      process.stdout.write(text);
      tail = (tail + text).slice(-10_000);
      if (/Ready in/.test(tail)) { clearTimeout(timer); resolve(); }
    };
    nextProcess!.stdout!.on('data', onOutput);
    nextProcess!.stderr!.on('data', onOutput);
    nextProcess!.once('error', error => { clearTimeout(timer); reject(error); });
    nextProcess!.once('exit', code => { clearTimeout(timer); reject(new Error('Next dev exited with ' + code)); });
  });
  status.state = 'verifying_http';
  await save();
  status.loginUrl = webOrigin + '/access?next=%2Fme%2Fwork';
  const results: Record<string, unknown>[] = [];
  try {
    const loginPage = await fetch(String(status.loginUrl), { signal: AbortSignal.timeout(60_000), redirect: 'manual' });
    assert.equal(loginPage.status, 200, 'Login page must return 200');
    await loginPage.text();
    results.push({ path: '/access', status: loginPage.status });
    for (let index = 0; index < 2; index++) {
      const { loginId, passcode, personId } = actors[index];
      const response = await fetch(webOrigin + '/api/auth/login', {
        method: 'POST', headers: { 'content-type': 'application/json', origin: webOrigin },
        body: JSON.stringify({ loginId, passcode }), signal: AbortSignal.timeout(60_000),
      });
      assert.equal(response.status, 200, await response.clone().text());
      const cookie = response.headers.get('set-cookie')!.split(';')[0];
      const session = await fetch(webOrigin + '/api/auth/session', { headers: { cookie }, signal: AbortSignal.timeout(30_000) });
      assert.equal(session.status, 200);
      assert.equal((await session.json()).personId, personId);
      for (const path of ['/me/work', '/me/work/buddy', '/api/me/work-home', '/api/me/projects', '/api/me/team-deliveries?box=received']) {
        const result = await fetch(webOrigin + path, { headers: { cookie }, signal: AbortSignal.timeout(60_000), redirect: 'manual' });
        assert.equal(result.status, 200, path + ' ' + (await result.clone().text()).slice(0, 500));
        if (path.startsWith('/me/')) assert.ok((await result.text()).includes('work-home'), path + ' missing work shell');
        else await result.json();
        results.push({ loginId, path, status: result.status });
      }
    }
    status.state = 'ready';
    status.verified = results;
  } catch (error) {
    const cause = error as Error & { cause?: { code?: string } };
    // A blocked HTTP probe needs manual verification; an actual bad response is a startup failure.
    status.state = cause.cause?.code === 'EACCES' ? 'awaiting_browser' : 'failed';
    status.httpError = { message: cause.message, code: cause.cause?.code };
    status.verified = results;
    if (status.state === 'failed') process.exitCode = 1;
  }
  await save();
  announce(status.state === 'ready' ? 'preview_ready' : status.state === 'failed' ? 'preview_verification_failed' : 'preview_http_blocked', status);
  await new Promise<void>(resolve => {
    const timer = setInterval(() => {
      void access(join(runDir, 'stop')).then(() => finish(true), () => {});
    }, 1_000);
    let finished = false;
    function finish(requested: boolean) {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      if (!requested) {
        status.state = 'failed';
        status.error = { message: 'Next exited before the preview was stopped; inspect next.log', code: nextProcess?.exitCode };
        process.exitCode = 1;
      }
      resolve();
    }
    process.once('SIGINT', () => finish(true));
    process.once('SIGTERM', () => finish(true));
    nextProcess!.once('exit', () => finish(false));
    if (nextProcess!.exitCode !== null || nextProcess!.signalCode !== null) finish(false);
  });
} catch (error) {
  const cause = error as Error & { code?: string; cause?: { code?: string; message?: string } };
  status.state = 'failed';
  status.error = { message: cause.message, code: cause.code ?? cause.cause?.code ?? null };
  announce('failed', { error: status.error });
  process.exitCode = 1;
} finally {
  await stop();
  status.stoppedAt = new Date().toISOString();
  await save();
  announce('finished', { runDir, state: status.state });
}
