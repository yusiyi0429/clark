#!/bin/sh
# 天枢本机程序 · macOS 一行安装：curl -fsSL <下载源>/install.sh | sh
# 装到本人目录（不要 sudo），注册 LaunchAgent 开机自启并启动；检查 Claude Code，没装就装，没登录就登录。
# 可调的环境变量：TIANSHU_LOCAL_DOWNLOAD_BASE、TIANSHU_LOCAL_FILE、TIANSHU_LOCAL_SKIP_CLAUDE=1、TIANSHU_LOCAL_NO_OPEN=1（同 Windows 版）。
# 注意：Mac 版 12 月实测，这份脚本还没在 Mac 上跑过。
set -eu

BASE="${TIANSHU_LOCAL_DOWNLOAD_BASE:-https://tk.tokenkingos.com/downloads/local}"
TIANSHU_URL="https://tk.tokenkingos.com"
DIR="$HOME/Library/Application Support/Tianshu/bin"
EXE="$DIR/tianshu-local"

say() { printf '  %s\n' "$1"; }
printf '\n天枢本机程序 · 安装\n'
[ "$(uname -s)" = "Darwin" ] || { echo "这份脚本只给 macOS 用"; exit 1; }
[ "$(id -u)" -ne 0 ] || { echo "不要用 sudo 跑"; exit 1; }
case "$(uname -m)" in arm64) ARCH=arm64 ;; x86_64) ARCH=x64 ;; *) echo "不支持的芯片 $(uname -m)"; exit 1 ;; esac
mkdir -p "$DIR"

# 1. 停掉旧版本（只停装在这个位置的那个）
launchctl bootout "gui/$(id -u)/com.tokenkingos.tianshu-local" 2>/dev/null || true
pkill -f "^$EXE" 2>/dev/null || true

# 2. 取程序：下载并核对 SHA256，或用本地文件
TMP="$(mktemp -t tianshu-local)"
if [ -n "${TIANSHU_LOCAL_FILE:-}" ]; then
  cp "$TIANSHU_LOCAL_FILE" "$TMP"
else
  say "下载 $BASE/tianshu-local-darwin-$ARCH …"
  curl -fsSL "$BASE/tianshu-local-darwin-$ARCH" -o "$TMP"
  WANT="$(curl -fsSL "$BASE/SHA256SUMS" | grep "tianshu-local-darwin-$ARCH" | awk '{print $1}')"
  GOT="$(shasum -a 256 "$TMP" | awk '{print $1}')"
  [ -n "$WANT" ] && [ "$WANT" = "$GOT" ] || { rm -f "$TMP"; echo "下载的文件校验不通过，没有安装"; exit 1; }
fi
mv "$TMP" "$EXE"
chmod 755 "$EXE"
# curl 下载的文件没有隔离属性；本地拷来的可能有，去掉。Bun 交叉编译的产物已带临时签名（Apple 芯片必需）。
xattr -d com.apple.quarantine "$EXE" 2>/dev/null || true
curl -fsSL "$BASE/uninstall.sh" -o "$DIR/uninstall.sh" 2>/dev/null && chmod 755 "$DIR/uninstall.sh" || true

# 3. 开机自启（LaunchAgent，加载时即启动）
"$EXE" autostart on >/dev/null
i=0
while [ $i -lt 40 ]; do
  if curl -fsS -m 2 -H "Origin: $TIANSHU_URL" http://127.0.0.1:47610/v1/health 2>/dev/null | grep -q tianshu-local; then say "已启动，菜单栏里有「天枢」"; break; fi
  sleep 0.5; i=$((i + 1))
done

# 4. Claude Code
if [ "${TIANSHU_LOCAL_SKIP_CLAUDE:-}" != "1" ]; then
  CLAUDE="$HOME/.local/bin/claude"
  if [ ! -x "$CLAUDE" ]; then
    say "没找到 Claude Code，正在用官方脚本安装…"
    curl -fsSL https://claude.ai/install.sh | bash
  fi
  if [ -x "$CLAUDE" ]; then
    if "$CLAUDE" auth status --json 2>/dev/null | grep -q '"loggedIn": *true'; then
      say "Claude Code 已登录"
    else
      say "接下来登录 Claude：浏览器会打开，点「授权」即可"
      "$CLAUDE" auth login </dev/tty || true
    fi
  else
    say "Claude Code 没装上：可能连不上 downloads.claude.ai，之后可以在天枢网页里再装"
  fi
fi

printf '\n装好了。\n'
say "程序：$EXE"
say "卸载：sh \"$DIR/uninstall.sh\""
[ "${TIANSHU_LOCAL_NO_OPEN:-}" = "1" ] || open "$TIANSHU_URL"
