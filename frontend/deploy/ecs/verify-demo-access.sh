#!/usr/bin/env bash
set -euo pipefail

password="${1:?access password required}"
base_url="http://127.0.0.1:3120"
host_header="Host: demo.tokenkingos.com"
cookie_jar="$(mktemp)"
headers="$(mktemp)"
body="$(mktemp)"
trap 'rm -f "$cookie_jar" "$headers" "$body"' EXIT

root_status="$(curl -sS -o /dev/null -D "$headers" -w '%{http_code}' -H "$host_header" "$base_url/")"
root_location="$(awk 'BEGIN{IGNORECASE=1} /^location:/{sub(/\r$/, "", $2); print $2}' "$headers" | tail -n 1)"
health_status="$(curl -sS -o /dev/null -w '%{http_code}' -H "$host_header" "$base_url/api/health")"
api_status="$(curl -sS -o /dev/null -w '%{http_code}' -H "$host_header" "$base_url/api/data")"

wrong_status="$(curl -sS -o /dev/null -w '%{http_code}' \
  -H "$host_header" -H 'Content-Type: application/json' \
  --data '{"password":"definitely-wrong"}' "$base_url/api/access")"

uppercase_password="$(printf '%s' "$password" | tr '[:lower:]' '[:upper:]')"
payload="$(printf '{"password":"%s"}' "$uppercase_password")"
login_status="$(curl -sS -o /dev/null -w '%{http_code}' \
  -c "$cookie_jar" -H "$host_header" -H 'Content-Type: application/json' \
  --data "$payload" "$base_url/api/access")"

protected_status="$(curl -sS -o "$body" -w '%{http_code}' \
  -b "$cookie_jar" -H "$host_header" "$base_url/")"
brand_present="no"
if grep -q 'TKOS' "$body"; then brand_present="yes"; fi

printf 'unauthenticated_root=%s\n' "$root_status"
printf 'redirect_location=%s\n' "$root_location"
printf 'public_health=%s\n' "$health_status"
printf 'unauthenticated_api=%s\n' "$api_status"
printf 'wrong_password=%s\n' "$wrong_status"
printf 'uppercase_password=%s\n' "$login_status"
printf 'authenticated_root=%s\n' "$protected_status"
printf 'tkos_brand_present=%s\n' "$brand_present"

test "$root_status" = "307"
test "$root_location" = "/access?next=%2F"
test "$health_status" = "200"
test "$api_status" = "401"
test "$wrong_status" = "401"
test "$login_status" = "200"
test "$protected_status" = "200"
test "$brand_present" = "yes"
