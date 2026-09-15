#!/usr/bin/env bash
# Caddy 公网边界验证：/ -> web，/api/* 与 /mcp/* -> api，SSE 流式不缓冲，multipart 透传。
# 用宿主机 stub 服务 + docker caddy 重复执行，不依赖业务应用。
set -euo pipefail
cd "$(dirname "$0")"

WEB_PORT=${WEB_PORT:-4101}
API_PORT=${API_PORT:-4102}
EDGE_PORT=${EDGE_PORT:-8080}

node - "$WEB_PORT" "$API_PORT" <<'NODE' &
const http = require("http");
const [, , webPort, apiPort] = process.argv;
http.createServer((_req, res) => {
  res.writeHead(200, { "content-type": "text/plain" });
  res.end("WEB");
}).listen(Number(webPort));
http.createServer((req, res) => {
  if (req.url === "/api/stream") {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: one\n\n");
    setTimeout(() => { res.write("data: two\n\n"); res.end(); }, 1200);
    return;
  }
  if (req.method === "POST") {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(`API POST ct=${req.headers["content-type"] || ""} bytes=${Buffer.concat(chunks).length}`);
    });
    return;
  }
  res.writeHead(200, { "content-type": "text/plain" });
  res.end(`API ${req.url}`);
}).listen(Number(apiPort));
NODE
STUB_PID=$!
trap 'kill $STUB_PID 2>/dev/null || true; docker rm -f warmap-caddy-verify >/dev/null 2>&1 || true' EXIT

CADDYFILE=$(mktemp /tmp/warmap-caddy-verify.XXXX.Caddyfile)
cat > "$CADDYFILE" <<EOF
:8080 {
	reverse_proxy /api/* host.docker.internal:$API_PORT {
		flush_interval -1
	}
	reverse_proxy /mcp/* host.docker.internal:$API_PORT
	reverse_proxy /* host.docker.internal:$WEB_PORT
}
EOF

docker rm -f warmap-caddy-verify >/dev/null 2>&1 || true
docker run -d --name warmap-caddy-verify -p "$EDGE_PORT":8080 \
  -v "$CADDYFILE":/etc/caddy/Caddyfile:ro \
  --add-host=host.docker.internal:host-gateway \
  caddy:2 caddy run --config /etc/caddy/Caddyfile >/dev/null

for _ in $(seq 1 40); do
  curl -s "http://localhost:$EDGE_PORT/" >/dev/null 2>&1 && break
  sleep 0.5
done

fail() { echo "FAIL: $1"; exit 1; }

[ "$(curl -s "http://localhost:$EDGE_PORT/")" = "WEB" ] || fail "/ 应路由到 Web"
[ "$(curl -s "http://localhost:$EDGE_PORT/api/cards/home")" = "API /api/cards/home" ] || fail "/api/* 应路由到 API"
[ "$(curl -s -X POST "http://localhost:$EDGE_PORT/mcp/company-memory")" = "API POST ct= bytes=0" ] || fail "/mcp/company-memory 应路由到 API"

head -c 2048 /dev/zero > /tmp/warmap-verify-multipart.bin
MP=$(curl -s -F "file=@/tmp/warmap-verify-multipart.bin" "http://localhost:$EDGE_PORT/api/transcripts")
echo "$MP" | grep -q "multipart/form-data" || fail "multipart content-type 应透传"
echo "$MP" | grep -q "bytes=" || fail "multipart body 应到达 API"

SSE=$(node -e '
const http = require("http");
const t0 = Date.now();
const req = http.get(process.argv[1], (res) => {
  res.once("data", () => {
    const dt = Date.now() - t0;
    console.log(dt <= 800 ? "SSE_STREAMING" : `SSE_BUFFERED ${dt}ms`);
    req.destroy();
  });
});
req.on("error", () => console.log("SSE_ERR"));
' "http://localhost:$EDGE_PORT/api/stream")
echo "$SSE" | grep -q "SSE_STREAMING" || fail "SSE 应流式透传（未缓冲）：$SSE"

rm -f /tmp/warmap-verify-multipart.bin "$CADDYFILE"
echo "Caddy 边界验证全部通过：/、/api/*、/mcp/*、multipart、SSE"
