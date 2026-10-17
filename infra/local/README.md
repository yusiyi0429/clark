# 本地准生产环境

以下命令都在仓库根目录、Git Bash 里执行。需要 Docker Desktop 已启动。测试分层见 [test-plan.md](test-plan.md)。

## 1. 装 mkcert、加 hosts

1. 安装 mkcert（任选其一）：`winget install FiloSottile.mkcert`、`scoop install mkcert`、`choco install mkcert`。
2. 安装本地根证书（只需一次，会弹确认框）：`mkcert -install`。装完重开 Git Bash 与浏览器。
3. 用管理员身份打开记事本，编辑 `C:\Windows\System32\drivers\etc\hosts`，末尾加一行：
   ```
   127.0.0.1 tk.local.test
   ```
4. 看 443 是否被占用：`netstat -ano | grep ":443 " | grep LISTEN`。有输出就在第 2 步用 8443。

## 2. 准备 env

1. `cp infra/local/.env.local.example infra/local/.env.local`
2. 把 `POSTGRES_PASSWORD`、`SESSION_SECRET`、`DRI_SERVICE_TOKEN`、`COMPANY_MEMORY_MCP_TOKEN` 各换成 `openssl rand -base64 32` 生成的值。
3. 模型网关填测试 key 和模型名；不想外呼就把 `PI_BASE_URL` 写成 `http://127.0.0.1:9/v1`。
4. 本体只填测试 scope，或留空；博查、LangSmith 不需要就留空。
5. 443 被占用时：`LOCAL_HTTPS_PORT=8443`，`PUBLIC_DOMAIN=tk.local.test:8443`，下文的地址都带上 `:8443`。

## 3. 起环境

1. `bash infra/local/up.sh`
   - 第一次会用 mkcert 在 `infra/local/certs/` 生成证书，并按生产 Dockerfile 构建 web、api（10 分钟左右）。
   - 最后打印 `就绪：https://tk.local.test` 和 `/api/healthz` 的内容。
   - 代码没改、只想重启时：`bash infra/local/up.sh --no-build`。
2. 空库第一次起来后发初始码：
   ```bash
   docker compose -f infra/docker-compose.yml -f infra/local/compose.local.yml --env-file infra/local/.env.local \
     exec api pnpm --filter @warmap/api access:issue
   ```
3. 浏览器打开 https://tk.local.test ，用表格里的 ID 和初始码登录，按提示改成自己的 4 位口令。
4. 看日志：`docker compose -p warmap-local logs -f api`。
5. 停：`bash infra/local/down.sh`（保留数据）。`bash infra/local/down.sh -v` 会删掉本地数据库和附件卷。

## 4. 把线上备份恢复到本地

1. 自己从火山主机 `/srv/tokenhub/backups/tianshu` 拿同一批次的 `warmap-*.dump.age` 和对应 `.sha256`，放到本机一个目录，例如 `C:/Users/<你>/tianshu-backup`。
2. 从 `TokenkingOS/tkos-secrets` 的 `tianshu/backup-age.key` 取 age 私钥，放进同一目录；恢复完立刻删掉。
3. 真实人员名单放到 `seed/company-people.json`（不入库），并在 `.env.local` 写 `COMPANY_PEOPLE_SEED=/repo/seed/company-people.json`。
4. 先断开外呼：`.env.local` 里 `PI_BASE_URL=http://127.0.0.1:9/v1`，本体变量留空或只填测试 scope，`BOCHA_API_KEY` 留空。
5. 清掉本地旧数据，只起空库：
   ```bash
   bash infra/local/down.sh -v
   C="docker compose -f infra/docker-compose.yml -f infra/local/compose.local.yml --env-file infra/local/.env.local"
   $C up -d postgres
   ```
6. 用 `restore.sh` 恢复（先 dry-run，通过后把末尾加上 `--execute` 再跑一次）：
   ```bash
   BK="C:/Users/<你>/tianshu-backup"   # 第 1 步的目录
   DUMP=warmap-<批次>.dump.age          # 第 1 步的文件名
   PGPASSWORD=$(sed -n 's/^POSTGRES_PASSWORD=//p' infra/local/.env.local) MSYS_NO_PATHCONV=1 \
   docker run --rm -e PGPASSWORD --network warmap-local_default \
     -v "$(pwd -W)/infra/backup:/scripts:ro" -v "$BK:/backup:ro" postgres:17-alpine \
     sh -c "apk add --no-cache age bash >/dev/null && tr -d '\r' < /scripts/restore.sh > /tmp/restore.sh && bash /tmp/restore.sh \
       --backup /backup/$DUMP --target-url postgres://warmap@postgres:5432/warmap \
       --age-identity /backup/backup-age.key"
   ```
   这是数据库-only 恢复：会前材料、会话附件、录音文件不在里面，打开这些文件会缺失。
7. `bash infra/local/up.sh`，用自己在线上的 ID 和口令登录。
8. 核对迁移：
   ```bash
   $C exec postgres psql -U warmap -d warmap -Atc "SELECT max(id) FROM schema_migrations"
   ls apps/api/migrations | tail -1
   ```
   两者编号一致。
9. 删掉备份目录里的 `backup-age.key`。

## 5. 跑 smoke.sh 和 verify.sh

1. 先确认 curl 信任本地证书：`curl -sS https://tk.local.test/api/healthz`。Git Bash 的 curl 用 Windows 证书库，第 1 节做过 `mkcert -install` 就不用再配；报证书错误时重做 `mkcert -install` 并重开 Git Bash。
2. smoke（登录 ID 与口令只在当前 shell 输入）：
   ```bash
   read -p "登录 ID: " CEO_LOGIN_ID; read -s -p "口令: " CEO_PASSCODE; echo
   PUBLIC_ORIGIN=https://tk.local.test CEO_LOGIN_ID="$CEO_LOGIN_ID" CEO_PASSCODE="$CEO_PASSCODE" \
     bash infra/staging/smoke.sh
   ```
   账号必须已改过初始码（第 3 步第 3 条），否则登录这一项不会拿到 Cookie。
3. verify.sh（用 stub 验证 Caddy 分流、SSE、multipart；需要 node 和 docker，占用 4101、4102、8080 端口）：在 WSL、macOS 或 Linux 里执行 `bash infra/caddy/verify.sh`。Git Bash 下 docker 挂载路径会被改写，目前跑不通。

## 6. 飞书

1. 在飞书开放平台的**测试应用**（不要用线上应用）→ 安全设置 → 重定向 URL，加上本地域名下的回调地址：与线上回调路径相同，只把 `https://tk.tokenkingos.com` 换成 `https://tk.local.test`（用 8443 时带端口）。
2. 测试应用的 App ID / Secret 按飞书集成使用的变量名填进 `.env.local`（当前 main 的 compose 还没有飞书变量，集成合入后再做这一步），然后 `bash infra/local/up.sh --no-build`。
3. 事件订阅用长连接方式：本地 API 主动连飞书，不需要公网地址，起来后直接能收到事件。
4. 同一个测试应用如果在预发也开着长连接，事件只会推给其中一个连接；本地测事件时先停掉预发那边，或给本地单独建一个测试应用。
