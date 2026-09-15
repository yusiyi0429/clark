#!/usr/bin/env bash
set -euo pipefail

password="${1:?access password required}"
env_file="/etc/tokenhub/clark-main.env"
temp_file="$(mktemp)"
trap 'rm -f "$temp_file"' EXIT

test -s "$env_file"
grep -vE '^(TKOS_ACCESS_PASSWORD|TKOS_ACCESS_SECRET)=' "$env_file" > "$temp_file"

secret="$(openssl rand -hex 32)"
printf 'TKOS_ACCESS_PASSWORD=%s\n' "$password" >> "$temp_file"
printf 'TKOS_ACCESS_SECRET=%s\n' "$secret" >> "$temp_file"

install -o root -g root -m 600 "$temp_file" "$env_file"
printf 'access_configured=yes\n'
