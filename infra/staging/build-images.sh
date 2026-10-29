#!/usr/bin/env bash
# 在本机构建发布镜像并打包，正式主机只加载（release.sh prepare 配 IMAGES_TAR），不在现网上跑 npm 和 next build。
#
#   infra/staging/build-images.sh <完整提交SHA> [服务...]   # 服务默认 api web
#
# 在仓库根目录运行，产出 source-<短SHA>.tgz、images-<短SHA>.tar.gz 和它的 .sha256。
# 镜像标签与 release.sh 一致：warmap-<服务>:<短SHA>，带 tianshu.revision=<完整SHA>。
set -Eeuo pipefail

[ $# -ge 1 ] || { sed -n '2,7p' "$0" >&2; exit 2; }
revision=$1; shift
[[ "$revision" =~ ^[0-9a-f]{40}$ ]] || { echo "需要 40 位完整提交 SHA" >&2; exit 2; }
short=${revision:0:7}
read -r -a services <<< "${*:-api web}"

git -c core.autocrlf=false archive --format=tar.gz -o "source-$short.tgz" "$revision"
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
tar -xzf "source-$short.tgz" -C "$work"

images=()
for service in "${services[@]}"; do
  case $service in api|web) ;; *) echo "只支持 api、web：$service" >&2; exit 2 ;; esac
  docker build --platform linux/amd64 -f "$work/apps/$service/Dockerfile" \
    ${NPM_CONFIG_REGISTRY:+--build-arg NPM_CONFIG_REGISTRY="$NPM_CONFIG_REGISTRY"} \
    --label tianshu.revision="$revision" -t "warmap-$service:$short" "$work"
  images+=("warmap-$service:$short")
done

docker save "${images[@]}" | gzip -1 > "images-$short.tar.gz"
sha256sum "images-$short.tar.gz" > "images-$short.tar.gz.sha256"
echo "built=${images[*]} images=images-$short.tar.gz source=source-$short.tgz"
