import { embedded } from "../store.js";
/**
 * 开发测试页（只在 --dev 下由 GET /dev 提供）：配对 → 选文件夹 → 开会话 → 看事件 → 插话 → 批权限 → 停下 → 强停。
 * 照契约直连本机 API，网页那边的实现可以照着它写。口令只存在本页的 sessionStorage。
 */
export const DEV_PAGE = embedded(String.raw`<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>天枢本机程序 · 测试页</title>
<style>
body{font:14px/1.5 system-ui,sans-serif;margin:16px;max-width:980px;color:#1d2433}
fieldset{border:1px solid #d8dde6;border-radius:8px;margin:0 0 12px;padding:8px 12px}
button{margin:2px 4px 2px 0}input,textarea,select{font:inherit}textarea{width:100%;box-sizing:border-box}
#log{background:#0f1420;color:#d6e2ff;height:340px;overflow:auto;padding:8px;border-radius:8px;white-space:pre-wrap;font:12px/1.45 ui-monospace,monospace}
.perm{background:#fff6dd;border:1px solid #f0d27a;border-radius:6px;padding:6px;margin:4px 0}
</style></head><body>
<h2>天枢本机程序 · 测试页</h2>
<fieldset><legend>1 连接</legend>
<span id="health">…</span> <button id="pair">配对</button> <span id="pairInfo"></span> <button id="unpair">取消配对</button>
<div id="agent"></div><button id="login">登录 Claude</button></fieldset>
<fieldset><legend>2 文件夹与模型</legend>
<button id="pick">添加文件夹（本机弹框）</button> <select id="folders"></select> <select id="models"></select></fieldset>
<fieldset><legend>3 会话</legend>
<label><input type="radio" name="kind" value="card" checked>卡</label><label><input type="radio" name="kind" value="topic">专题</label>
<textarea id="first" rows="2">在当前目录写一个 hello.txt，内容是「你好」。写之前先说一句。</textarea>
<button id="start">开工</button> <select id="sessions"></select> <button id="watch">看这个会话</button></fieldset>
<fieldset><legend>4 控制</legend>
<input id="say" placeholder="插话 / 下一句" style="width:60%"> <button id="send">发送</button>
<button id="interrupt">停下</button> <button id="kill">强停</button>
<div id="perms"></div></fieldset>
<div id="log"></div>
<script>
const base = location.origin; const H = 'x-tianshu-local-token';
let token = sessionStorage.getItem('lt') || ''; let current = ''; let lastSeq = 0; let abort = null;
const $ = (id) => document.getElementById(id);
const log = (s) => { const el = $('log'); el.textContent += s + '\n'; el.scrollTop = el.scrollHeight; };
async function api(method, path, body) {
  if (body === undefined && method !== 'GET' && method !== 'DELETE') body = {};
  const r = await fetch(base + path, { method, headers: { ...(token ? { [H]: token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || r.status);
  return j;
}
async function refresh() {
  const h = await api('GET', '/v1/health'); $('health').textContent = 'v' + h.version + (h.tokenValid ? ' · 已配对' : ' · 未配对');
  if (!h.tokenValid) return;
  const s = await api('GET', '/v1/status'); const a = s.agents[0];
  $('agent').textContent = 'Claude Code：' + (a.installed ? a.version : '没装') + ' · ' + (a.loggedIn ? '已登录 ' + (a.subscriptionType || a.authMethod) : '未登录') + ' · 设置：' + a.setup.phase + (a.setup.loginUrl ? ' ' + a.setup.loginUrl : '') + ' · 云端待发 ' + s.cloud.outbox.pending;
  const f = await api('GET', '/v1/folders'); $('folders').innerHTML = f.folders.map((x) => '<option value="' + x.path + '">' + x.label + '</option>').join('');
  const m = await api('GET', '/v1/models'); $('models').innerHTML = m.profiles.map((x) => '<option value="' + x.id + '"' + (x.isDefault ? ' selected' : '') + '>' + x.label + '</option>').join('');
  const ss = await api('GET', '/v1/sessions'); $('sessions').innerHTML = ss.sessions.map((x) => '<option value="' + x.id + '">' + x.title + ' · ' + x.status + '</option>').join('');
}
$('pair').onclick = async () => {
  const p = await api('POST', '/v1/pairings', { clientLabel: '测试页' }); $('pairInfo').textContent = '确认码 ' + p.code + '，到本机弹框里点允许';
  for (let i = 0; i < 120; i++) { await new Promise((r) => setTimeout(r, 1000)); const s = await api('GET', '/v1/pairings/' + p.pairingId);
    if (s.status === 'approved' && s.token) { token = s.token; sessionStorage.setItem('lt', token); $('pairInfo').textContent = '配对成功'; return refresh(); }
    if (s.status !== 'pending') { $('pairInfo').textContent = s.status; return; } }
};
$('unpair').onclick = async () => { await api('DELETE', '/v1/pairing'); token = ''; sessionStorage.removeItem('lt'); refresh(); };
$('login').onclick = async () => { await api('POST', '/v1/agents/claude-code/login'); setTimeout(refresh, 1500); };
$('pick').onclick = async () => { const r = await api('POST', '/v1/folders/pick'); log(r.folder ? '已添加 ' + r.folder.path : '取消了'); refresh(); };
$('start').onclick = async () => {
  const kind = document.querySelector('input[name=kind]:checked').value;
  const body = { subject: kind === 'card' ? { kind, cardId: 'dev-card' } : { kind, topicId: 'dev-topic' }, title: '测试 ' + new Date().toLocaleTimeString(), firstMessage: $('first').value, modelProfileId: $('models').value };
  if (kind === 'card') body.cwd = $('folders').value;
  try { const s = await api('POST', '/v1/sessions', body); await refresh(); $('sessions').value = s.id; watch(s.id); } catch (e) { log('开工失败：' + e.message); }
};
$('watch').onclick = () => watch($('sessions').value);
$('send').onclick = async () => { const r = await api('POST', '/v1/sessions/' + current + '/messages', { text: $('say').value }); log('→ 已发送（' + r.delivery + '）'); $('say').value = ''; };
$('interrupt').onclick = () => api('POST', '/v1/sessions/' + current + '/interrupt');
$('kill').onclick = () => api('POST', '/v1/sessions/' + current + '/kill');
async function decide(id, decision, allowForSession) {
  const message = decision === 'deny' ? (prompt('拒绝理由（可空）') || undefined) : undefined;
  await api('POST', '/v1/sessions/' + current + '/permissions/' + encodeURIComponent(id), { decision, message, allowForSession });
  document.getElementById('p-' + id)?.remove();
}
function show(e) {
  lastSeq = e.seq; const t = e.type;
  if (t === 'assistant_text') log('Claude：' + e.text);
  else if (t === 'tool_call') log('  · ' + e.title);
  else if (t === 'tool_result') log('    ' + (e.isError ? '✗ ' : '✓ ') + e.preview.slice(0, 160));
  else if (t === 'permission_request') {
    const d = document.createElement('div'); d.className = 'perm'; d.id = 'p-' + e.request.requestId;
    d.innerHTML = '要权限：' + e.request.title + ' <button>允许</button>' + (e.request.canAllowForSession ? '<button>这张卡都允许</button>' : '') + '<button>拒绝</button>';
    const [a, b, c] = d.querySelectorAll('button'); a.onclick = () => decide(e.request.requestId, 'allow', false);
    if (e.request.canAllowForSession) { b.onclick = () => decide(e.request.requestId, 'allow', true); c.onclick = () => decide(e.request.requestId, 'deny'); } else b.onclick = () => decide(e.request.requestId, 'deny');
    $('perms').appendChild(d); log('  ? ' + e.request.title);
  } else if (t === 'permission_resolved') { document.getElementById('p-' + e.requestId)?.remove(); log('  ' + (e.decision === 'allow' ? '已允许' : '已拒绝')); }
  else log('[' + e.seq + '] ' + t + ' ' + JSON.stringify(Object.fromEntries(Object.entries(e).filter(([k]) => !['seq', 'at', 'sessionId', 'type'].includes(k)))));
}
async function watch(id) {
  if (abort) abort.abort(); if (id !== current) { lastSeq = 0; $('log').textContent = ''; $('perms').innerHTML = ''; } current = id; abort = new AbortController();
  // EventSource 不能带口令头，用 fetch 读 SSE；断了带 Last-Event-ID 重连。
  for (;;) {
    try {
      const r = await fetch(base + '/v1/sessions/' + id + '/events', { headers: { [H]: token, 'last-event-id': String(lastSeq) }, signal: abort.signal });
      const reader = r.body.getReader(); const dec = new TextDecoder(); let buf = '';
      for (;;) { const { value, done } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true });
        let i; while ((i = buf.indexOf('\n\n')) >= 0) { const chunk = buf.slice(0, i); buf = buf.slice(i + 2);
          const data = chunk.split('\n').filter((l) => l.startsWith('data: ')).map((l) => l.slice(6)).join('\n'); if (data) show(JSON.parse(data)); } }
    } catch (e) { if (abort.signal.aborted) return; }
    await new Promise((r) => setTimeout(r, 1000)); log('（重连事件流，从 ' + lastSeq + ' 之后补发）');
  }
}
refresh().catch((e) => log('连不上：' + e.message));
</script></body></html>`);
