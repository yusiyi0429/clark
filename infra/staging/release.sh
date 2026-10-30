#!/usr/bin/env bash
# 天枢火山主机发布：先备份、留回退，再切换并核对。整理自 2026-10-08 实际执行的三次发布。
#
#   sudo infra/staging/release.sh prepare <完整提交SHA> <源码包.tgz>   # 解包、构建候选镜像，不碰现网
#   sudo infra/staging/release.sh switch  <完整提交SHA>                # 备份 → 切换 → 健康与数据核对，失败自动回退；成功后清理旧版本
#   sudo infra/staging/release.sh cleanup <当前完整提交SHA>            # 只清理旧版本；DRY_RUN=1 只列出、不删除
#
# 源码包在本机生成后上传：git archive --format=tar.gz -o source-<短SHA>.tgz <完整SHA>
# 本脚本不读取、不打印 infra/.env 里的任何值；compose 只做 config --quiet。
#
# 可选环境变量（默认即旧栈 api/web 发布）：
#   TIANSHU_APP     部署目录，默认 /srv/tokenhub/apps/tianshu
#   BUILD_SERVICES  本次构建并切换的服务，默认 "api web"；只改前端时 "web"
#   EXTRA_COMPOSE   追加的 compose 文件（仓库相对路径），例如 M2："infra/m2.override.yml"
#   COPY_INFRA      从本次发布装到现网 infra 的文件，例如 M2："infra/m2.override.yml infra/caddy/Caddyfile.m2"
#   BACKUP_ROOT     备份目录，默认 /srv/tokenhub/backups/tianshu
#   ALLOW_MIGRATION 本次含新迁移时必须显式设为 1；含迁移时失败不自动回退（旧镜像不能跑新 schema）
#   KEEP_RELEASES   保留最近几次发布（含当前）的镜像、源码目录和回退目录，默认 3，最少 2
#   IMAGES_TAR      本机 build-images.sh 打好的镜像包：prepare 只 docker load、不在主机上构建（构建会占满现网 CPU）
set -Eeuo pipefail
umask 077

usage() { sed -n '2,8p' "$0" >&2; exit 2; }
[ $# -ge 2 ] || usage
keep_releases=${KEEP_RELEASES:-3}
[[ "$keep_releases" =~ ^[0-9]+$ ]] && (( keep_releases >= 2 )) || { echo "KEEP_RELEASES 至少为 2（当前版本 + 一次回退）" >&2; exit 2; }
action=$1
revision=$2
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || { echo "需要 40 位完整提交 SHA" >&2; exit 2; }
short=${revision:0:7}

app=${TIANSHU_APP:-/srv/tokenhub/apps/tianshu}
backup_root=${BACKUP_ROOT:-/srv/tokenhub/backups/tianshu}
read -r -a build_services <<< "${BUILD_SERVICES:-api web}"
read -r -a extra_compose <<< "${EXTRA_COMPOSE:-}"
read -r -a copy_infra <<< "${COPY_INFRA:-}"
release="$app/releases/$short"
cd "$app"

# 现网 compose 文件清单。首次运行时按 10/8 的现网组合生成；之后切换和回退都以它为准。
files_list=infra/compose-files
[ -e "$files_list" ] || printf '%s\n' infra/docker-compose.yml infra/volcano.override.yml > "$files_list"
compose_with() {
  local list=$1; shift
  local args=() file
  while read -r file; do [ -n "$file" ] && args+=(-f "$file"); done < "$list"
  docker compose "${args[@]}" --env-file infra/.env "$@"
}
compose() { compose_with "$files_list" "$@"; }

image_name() { case $1 in m2) echo "tianshu-m2:$2" ;; *) echo "warmap-$1:$2" ;; esac; }

health_sha() {  # $1 = api | web，读当前 buildSha
  local path=/healthz
  [ "$1" = api ] && path=/api/healthz
  curl -fsS --max-time 5 "http://127.0.0.1:3130$path" | python3 -c 'import json,sys; print(json.load(sys.stdin)["buildSha"])'
}

prepare() {
  local archive=$1
  test ! -e "$release"
  test -s "$archive"
  install -d -m 700 "$release"
  tar -xzf "$archive" -C "$release"
  printf '%s\n' "$revision" > "$release/REVISION"
  sha256sum "$archive" > "$release/SOURCE.sha256"
  # Windows 上打包的脚本可能带 CRLF：统一成 LF 并逐个 bash -n
  python3 - "$release/infra" <<'PY'
from pathlib import Path
import subprocess, sys
for file in Path(sys.argv[1]).rglob('*.sh'):
    file.write_bytes(file.read_bytes().replace(b'\r\n', b'\n'))
    subprocess.run(['bash', '-n', str(file)], check=True)
PY
  # 固定本次镜像标签、构建目录与 BUILD_SHA；本次不构建的服务沿用现网 pin 里原有的段。相对路径以 infra/ 为基准
  python3 - "$release/release.pin.yml" infra/release.pin.yml "$revision" "$short" "${build_services[@]}" <<'PY'
import os, re, sys
target, live, revision, short, *services = sys.argv[1:]
lines = ['# 由 infra/staging/release.sh 生成：固定现网各服务的镜像与构建来源。', 'services:']
# 现网 pin 按服务分段：从两空格缩进的服务名到下一个服务名
keep = False
for line in (open(live).read().splitlines() if os.path.exists(live) else []):
    match = re.fullmatch(r'  ([\w-]+):\s*', line)
    if match:
        keep = match[1] not in services
    if keep:
        lines.append(line)
for service in services:
    assert service in ('api', 'web', 'm2'), service
    image = f'tianshu-m2:{short}' if service == 'm2' else f'warmap-{service}:{short}'
    lines += [f'  {service}:', f'    image: {image}', '    build:', f'      context: ../releases/{short}',
              '      labels:', f'        tianshu.revision: "{revision}"']
    if service != 'm2':
        lines += ['    environment:', f'      BUILD_SHA: "{short}"']
open(target, 'w').write('\n'.join(lines) + '\n')
PY
  { cat "$files_list"; for f in "${extra_compose[@]}"; do echo "$release/$f"; done; echo "$release/release.pin.yml"; } \
    | grep -v '^infra/release.pin.yml$' > "$release/compose-files.build"
  compose_with "$release/compose-files.build" config --quiet
  if [ -n "${IMAGES_TAR:-}" ]; then
    test -s "$IMAGES_TAR"
    gunzip -c "$IMAGES_TAR" | docker load
  else
    compose_with "$release/compose-files.build" build "${build_services[@]}"
  fi
  local service
  for service in "${build_services[@]}"; do
    test "$(docker image inspect "$(image_name "$service" "$short")" --format '{{index .Config.Labels "tianshu.revision"}}')" = "$revision"
  done
  echo "prepare=ready release=$release images=${build_services[*]} production_unchanged=true"
}

snapshot() {  # 只读事务：账号、口令摘要与主要业务表内容摘要
  compose exec -T postgres psql -U warmap -d warmap -X -q -A -t -v ON_ERROR_STOP=1 <<'SQL'
BEGIN READ ONLY;
SET LOCAL TIME ZONE 'UTC';
SELECT json_build_object(
  'schemaVersion',(SELECT max(id) FROM schema_migrations),
  'accounts',(SELECT count(*) FROM member_access),
  'missions',(SELECT count(*) FROM missions),
  'credentials',(SELECT md5(COALESCE(string_agg(json_build_array(person_id,login_id,passcode_hash,must_change,session_version)::text,'|' ORDER BY person_id),'')) FROM member_access),
  'battlefieldConfig',(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY to_jsonb(t)::text),'')) FROM battlefield_config t),
  'capabilityConfig',(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY to_jsonb(t)::text),'')) FROM capability_config t),
  'companyConfig',(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY to_jsonb(t)::text),'')) FROM company_strategy_config t),
  'plans',(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY to_jsonb(t)::text),'')) FROM monthly_plans t),
  'rounds',(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY to_jsonb(t)::text),'')) FROM mission_rounds t),
  'personalCards',(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY to_jsonb(t)::text),'')) FROM personal_mission_cards t),
  'missionContent',(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY to_jsonb(t)::text),'')) FROM missions t),
  'onboarding',(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY to_jsonb(t)::text),'')) FROM person_onboarding t),
  'guideMarks',(SELECT md5(COALESCE(string_agg(to_jsonb(t)::text,'|' ORDER BY to_jsonb(t)::text),'')) FROM person_seen_marks t)
);
ROLLBACK;
SQL
}

switch() {
  local previous="$app/releases/before-$short" service
  test "$(cat "$release/REVISION")" = "$revision"
  test ! -e "$previous"
  for service in "${build_services[@]}"; do
    test "$(docker image inspect "$(image_name "$service" "$short")" --format '{{index .Config.Labels "tianshu.revision"}}')" = "$revision"
  done
  for f in "${copy_infra[@]}"; do test -f "$release/$f"; done

  # 当前版本必须健康，记下它的 buildSha 作为回退目标
  local old_api old_web
  old_api=$(health_sha api); old_web=$(health_sha web)
  local expect_api=$old_api expect_web=$old_web
  for service in "${build_services[@]}"; do
    [ "$service" = api ] && expect_api=$short
    [ "$service" = web ] && expect_web=$short
  done

  # 有新迁移时必须显式确认；迁移只向前，失败后不能只换回旧镜像
  local before_schema release_schema migrating=0
  before_schema=$(compose exec -T postgres psql -U warmap -d warmap -XAtc 'SELECT max(id) FROM schema_migrations')
  release_schema=$(ls "$release/apps/api/migrations" | sed -n 's/^0*\([0-9][0-9]*\)_.*\.sql$/\1/p' | sort -n | tail -1)
  if (( release_schema > before_schema )); then
    [ "${ALLOW_MIGRATION:-0}" = 1 ] || { echo "本次含迁移 $before_schema→$release_schema，确认后以 ALLOW_MIGRATION=1 重跑" >&2; exit 2; }
    migrating=1
  fi

  # 保留现网 infra（含 compose 清单、env 与旧固定文件）和 seed 摘要，生成回退脚本
  install -d -m 700 "$previous"
  cp -a infra "$previous/"
  sha256sum seed/company-people.json infra/.env > "$previous/preserved-files.sha256"
  docker inspect warmap-api-1 warmap-web-1 --format '{{.Name}} {{.Image}}' > "$previous/images.txt"
  compose config --services | sort > "$previous/services.txt"
  cat > "$previous/rollback.sh" <<ROLLBACK
#!/usr/bin/env bash
# 换回 api=$old_api web=$old_web 的镜像与原 infra；不恢复数据库，不删除任何卷。
set -euo pipefail
cd "$app"
compose_with() { local args=() f; while read -r f; do [ -n "\$f" ] && args+=(-f "\$f"); done < "\$1"; shift; docker compose "\${args[@]}" --env-file infra/.env "\$@"; }
# 本次新增、旧组合没有的服务（例如 m2）先停下，保留其数据卷
comm -13 "$previous/services.txt" <(compose_with infra/compose-files config --services | sort) | while read -r s; do
  compose_with infra/compose-files rm -sf "\$s"
done
rm -rf infra && cp -a "$previous/infra" infra
compose_with infra/compose-files config --quiet
compose_with infra/compose-files up -d --no-build --no-deps api web
compose_with infra/compose-files up -d --no-build --no-deps --force-recreate edge
for attempt in \$(seq 1 40); do
  api=\$(curl -fsS --max-time 5 http://127.0.0.1:3130/api/healthz | python3 -c 'import json,sys; print(json.load(sys.stdin)["buildSha"])' || true)
  web=\$(curl -fsS --max-time 5 http://127.0.0.1:3130/healthz | python3 -c 'import json,sys; print(json.load(sys.stdin)["buildSha"])' || true)
  if [ "\$api" = "$old_api" ] && [ "\$web" = "$old_web" ]; then
    echo 'rollback=healthy database_restore=not_performed'; exit 0
  fi
  sleep 2
done
echo 'rollback_health_check=failed' >&2; exit 1
ROLLBACK
  chmod 700 "$previous/rollback.sh"
  bash -n "$previous/rollback.sh"

  # 新的 compose 清单：原清单 + 追加文件 + 本次固定文件
  { grep -v '^infra/release.pin.yml$' "$files_list"; printf '%s\n' "${extra_compose[@]}"; echo infra/release.pin.yml; } \
    | awk 'NF && !seen[$0]++' > "$release/compose-files"

  # 部署前加密备份（数据库 + 四个卷 + manifest），逐份校验
  set -a; source infra/backup.env; set +a
  bash infra/backup/backup.sh > "$release/backup.log" 2>&1
  local batch
  batch=$(find "$backup_root" -maxdepth 1 -name 'warmap-*.manifest.json' -printf '%f\n' | sort | tail -1)
  batch=${batch%.manifest.json}
  test -n "$batch"
  (cd "$backup_root"; sha256sum -c "$batch"*.sha256)
  printf '%s\n' "$batch" > "$release/BACKUP_BATCH"
  if docker volume inspect warmap_m2_state > /dev/null 2>&1; then
    # 主机拉不到 Docker Hub，用已有的 postgres 镜像里的 tar
    docker run --rm --network none --entrypoint tar -v warmap_m2_state:/data:ro -v "$previous":/out postgres:17-alpine -czf /out/m2_state.tgz -C /data .
  fi
  snapshot > "$previous/before-state.json"

  local rollback_enabled=0
  on_error() {
    local code=$?
    trap - ERR
    if (( rollback_enabled )); then
      if (( migrating )); then
        echo "release_verification=failed 已执行迁移，未自动回退；按 runbook §3/§6 用备份 $batch 处理，回退脚本 $previous/rollback.sh" >&2
      else
        echo 'release_verification=failed restoring_previous_release' >&2
        bash "$previous/rollback.sh" || echo "rollback_needs_attention=$previous/rollback.sh" >&2
      fi
    fi
    exit "$code"
  }
  trap on_error ERR
  rollback_enabled=1

  for f in "${copy_infra[@]}"; do install -D -m 644 "$release/$f" "$f"; done
  cp "$release/release.pin.yml" infra/release.pin.yml
  cp "$release/compose-files" "$files_list"
  compose config --quiet
  # 只动本次构建的服务和新增服务；--no-deps 避免重跑 storage-init 等依赖。改了 compose 组合时最后重建 edge
  local up_services
  mapfile -t up_services < <({ printf '%s\n' "${build_services[@]}"; comm -13 "$previous/services.txt" <(compose config --services | sort); } | awk 'NF && !seen[$0]++')
  compose up -d --no-build --no-deps "${up_services[@]}"
  if (( ${#extra_compose[@]} + ${#copy_infra[@]} )); then compose up -d --no-build --no-deps --force-recreate edge; fi
  local ready=0 api web m2_ok
  for attempt in $(seq 1 60); do
    api=$(health_sha api || true); web=$(health_sha web || true); m2_ok=1
    if compose config --services | grep -qx m2; then
      [ "$(curl -s -o /dev/null --max-time 5 -w '%{http_code}' http://127.0.0.1:3130/m2/api/session)" != 404 ] || m2_ok=0
      [ "$(docker inspect "$(compose ps -q m2)" --format '{{.State.Health.Status}}' 2>/dev/null)" = healthy ] || m2_ok=0
    fi
    if [ "$api" = "$expect_api" ] && [ "$web" = "$expect_web" ] && (( m2_ok )); then ready=1; break; fi
    sleep 3
  done
  test "$ready" = 1
  snapshot > "$release/after-state.json"
  python3 - "$previous/before-state.json" "$release/after-state.json" "$migrating" <<'PY'
import json, sys
before, after = (json.load(open(path)) for path in sys.argv[1:3])
migrating = sys.argv[3] == '1'
strict = ('accounts', 'missions', 'credentials')
keys = strict if migrating else [key for key in before if key != 'schemaVersion']
changed = [key for key in keys if before[key] != after.get(key)]
assert not changed, changed
assert after['schemaVersion'] >= before['schemaVersion']
print(json.dumps({'schemaVersion': after['schemaVersion'], 'accounts': after['accounts'], 'missions': after['missions'],
                  'contentHashesCompared': not migrating, 'credentialsAndBusinessStatePreserved': True}))
PY
  sha256sum -c "$previous/preserved-files.sha256"
  rollback_enabled=0
  trap - ERR
  compose ps
  echo "release=deployed api=$expect_api web=$expect_web backup=$batch rollback=$previous/rollback.sh"
}

# 每次发布都会留下镜像（warmap-api/web、tianshu-m2 各一个标签）、releases/<短SHA> 源码目录和 releases/before-<短SHA> 回退目录。
# 只保留最近 KEEP_RELEASES 次发布（当前发布一定保留），其余删除；正被任何容器使用的镜像、留下的回退目录要用的镜像不删。
# 只动本脚本建的东西：带 tianshu.revision 标签的镜像和 releases/ 下的目录。其他项目的镜像、构建缓存、数据卷和备份（备份按 backup.sh 的保留天数）一概不碰。
cleanup() {
  local dry=${DRY_RUN:-0} keep dir name tag repo id ids in_use f
  test -f "$release/REVISION"
  # 按发布时间（REVISION 文件的修改时间）从新到旧排，当前发布放第一位
  keep=$({ echo "$short"; for f in $(ls -1t "$app"/releases/*/REVISION 2>/dev/null); do basename "$(dirname "$f")"; done; } \
    | grep -E '^[0-9a-f]{7}$' | awk '!seen[$0]++' | head -n "$keep_releases")
  echo "cleanup keep=$(echo $keep) dry_run=$dry"
  is_kept() { grep -qx "$1" <<< "$keep"; }
  remove() { echo "remove $*"; if [ "$dry" != 1 ]; then "$@"; fi; }
  local survivors=()
  for dir in "$app"/releases/*/; do
    [ -d "$dir" ] || continue
    name=$(basename "$dir"); tag=${name#before-}
    if [[ "$tag" =~ ^[0-9a-f]{7}$ ]] && ! is_kept "$tag"; then remove rm -rf -- "$app/releases/$name"; continue; fi
    [[ "$name" == before-* ]] && survivors+=("$dir")
  done
  # 留下的回退目录（含 M2 单独切换留下的 before-m2-<短SHA>/）回退时要用的镜像也不删：
  # 它们的固定文件、回退脚本里写的 仓库:短SHA 标签，以及 images.txt 记的镜像 ID。
  local rollback_tags='' rollback_ids=''
  if (( ${#survivors[@]} )); then
    rollback_tags=$(grep -rhoE '(warmap-api|warmap-web|tianshu-m2):[0-9a-f]{7}' "${survivors[@]}" 2>/dev/null | sort -u || true)
    rollback_ids=$(grep -rhoE 'sha256:[0-9a-f]{64}' "${survivors[@]}" 2>/dev/null | sort -u || true)
  fi
  ids=$(docker ps -aq)
  in_use=$({ [ -z "$ids" ] || docker inspect --format '{{.Image}}' $ids; echo "$rollback_ids"; } | sort -u)
  for repo in warmap-api warmap-web tianshu-m2; do
    for tag in $(docker image ls "$repo" --format '{{.Tag}}'); do
      [[ "$tag" =~ ^[0-9a-f]{7}$ ]] || continue
      is_kept "$tag" && continue
      if grep -qx "$repo:$tag" <<< "$rollback_tags"; then echo "keep $repo:$tag rollback"; continue; fi
      [ -n "$(docker image inspect "$repo:$tag" --format '{{index .Config.Labels "tianshu.revision"}}' 2>/dev/null)" ] || continue
      id=$(docker image inspect "$repo:$tag" --format '{{.Id}}')
      if grep -qx "$id" <<< "$in_use"; then echo "keep $repo:$tag in_use"; continue; fi
      remove docker image rm "$repo:$tag"
    done
  done
  # 本脚本构建后失去标签的悬空镜像
  if [ "$dry" = 1 ]; then docker image ls -f dangling=true -f label=tianshu.revision --format 'dangling {{.ID}}'
  else docker image prune -f --filter label=tianshu.revision > /dev/null; fi
  df -h "$app" | tail -1
}

case $action in
  prepare) [ $# -eq 3 ] || usage; prepare "$3" ;;
  switch) [ $# -eq 2 ] || usage; switch; cleanup || echo "cleanup=failed release_unaffected=true" >&2 ;;
  cleanup) [ $# -eq 2 ] || usage; cleanup ;;
  *) usage ;;
esac
