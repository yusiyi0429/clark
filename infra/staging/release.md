# 火山主机发布模板

`release.sh` 整理自 2026-10-08 在 tk.tokenkingos.com 实际执行的三次发布（2644721、7b4fca3、f4ca6d3）：先加密备份，保留旧 infra 与回退脚本，再切换，最后核对健康、buildSha 与业务数据摘要；核对失败自动回退。脚本不读取、不打印 `infra/.env` 的值。

## 现网事实（2026-10-14 核对）

- 主机 tokenhub-prod-app-01（115.191.26.230），SSH 端口 22，ED25519 主机指纹 `SHA256:Uf7EHr9mioshiiqsNA54//XLSHRvT8W9QnVi0yLrU7E`。
- 目录 `/srv/tokenhub/apps/tianshu`；宿主机 Nginx 把 tk.tokenkingos.com 整域名转给 `127.0.0.1:3130`（edge/Caddy）。
- 现网 compose 组合：`infra/docker-compose.yml` + `infra/volcano.override.yml`。10/8 的发布把 api/web 的镜像、构建目录与 BUILD_SHA 写进了现网 `volcano.override.yml`（与仓库版不同，不要用仓库版覆盖它）。
- 每个版本的源码解在 `releases/<短SHA>`，镜像在主机上构建；部署目录本身不是 Git 工作区。

脚本首次运行时生成 `infra/compose-files`，记下现网 compose 组合；之后切换会把本次的 `infra/release.pin.yml`（固定镜像与构建目录）追加进去。只发部分服务时，pin 里其他服务沿用现网 pin 原来的固定。**此后手工执行 compose 时也按这份清单带全部 `-f`**，否则会回到旧镜像或丢掉 M2 路由：

```bash
cd /srv/tokenhub/apps/tianshu
sudo docker compose $(sed 's/^/-f /' infra/compose-files) --env-file infra/.env ps
```

## 步骤

1. 本机打包合入 main 的提交并上传（不经聊天或 Git 以外的渠道）：
   ```bash
   git archive --format=tar.gz -o source-<短SHA>.tgz <完整SHA>
   scp source-<短SHA>.tgz <用户>@115.191.26.230:/tmp/
   ```
2. 服务器上从源码包取出同版脚本：`tar -xzf /tmp/source-<短SHA>.tgz -O infra/staging/release.sh > /tmp/release.sh`，以下命令里的 `release.sh` 指它。新变量先写进 `infra/.env`（`sudo` 编辑，保持 600），因为构建前的 `config` 会检查必填变量。
3. 候选构建，不碰现网：
   ```bash
   sudo env BUILD_SERVICES="api web" bash release.sh prepare <完整SHA> /tmp/source-<短SHA>.tgz
   ```
   主机直连 Docker Hub/npm 不稳定时，按 `runbook.md` §0.5 配镜像源；仍失败就在本机构建同标签镜像后 `docker save | gzip`，上传校验 SHA-256 再 `docker load`，镜像须带 `tianshu.revision=<完整SHA>` 标签。
4. 切换（会先停 api 做一次加密备份，前台有一两分钟不可用）：
   ```bash
   sudo env BUILD_SERVICES="api web" bash release.sh switch <完整SHA>
   ```
   成功时最后一行是 `release=deployed ... rollback=<路径>`。失败会自动执行回退脚本并说明结果。
5. 外网复核：`https://tk.tokenkingos.com/api/healthz` 的 buildSha；按 `runbook.md` §1.4–1.5 跑 smoke。

本次含新迁移时 `switch` 会停下，要求 `ALLOW_MIGRATION=1`。含迁移的版本失败后**不自动回退**，因为迁移只向前、旧镜像不能跑新 schema，按 `runbook.md` §3、§6 用部署前备份处理。

## M2 内部试用（PR #5）

API 无改动，只构建 web 与 m2，并把 M2 的 compose 文件和 Caddyfile 装进现网 infra：

```bash
export BUILD_SERVICES="web m2" EXTRA_COMPOSE="infra/m2.override.yml" \
       COPY_INFRA="infra/m2.override.yml infra/caddy/Caddyfile.m2"
sudo -E bash release.sh prepare 57e51cdd8fc57b849d980fa7a256f7a5b9ce1103 /tmp/source-57e51cd.tgz
sudo -E bash release.sh switch  57e51cdd8fc57b849d980fa7a256f7a5b9ce1103
```

- `infra/.env` 需先有 `M2_SEED_DIR`、`M2_INTERNAL_TOKEN`、`M2_MODEL_KEY`（及可选 `M2_WORLD_READ_TOKEN`），见 [`docs/guides/m2-trial.md`](../../docs/guides/m2-trial.md)。
- `m2.override.yml` 的构建目录写的是 `..`，在主机上会指向旧代码；`release.pin.yml` 把它改成 `releases/<短SHA>`，所以不要绕过脚本直接 `compose build m2`。
- 切换时额外核对 m2 容器 healthy、`/m2/api/session` 不再是 404；已有 `m2_state` 卷时先打包到回退目录。
- 回退会停掉 m2 容器（保留 `m2_state` 卷与私有 seed）、恢复原 infra 和 Caddyfile、重建 edge。

## 回退

切换成功后仍可手动回退：`sudo bash releases/before-<短SHA>/rollback.sh`。它换回切换前的 api/web 镜像与整套 infra（含 compose 清单），停掉本次新增的服务，不恢复数据库、不删卷。需要回到旧数据时按 `runbook.md` §6 用 `releases/<短SHA>/BACKUP_BATCH` 记录的备份批次恢复。
