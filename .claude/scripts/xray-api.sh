#!/usr/bin/env bash
# Thin wrapper around the Xray Cloud REST/GraphQL API.
#
#   xray-api.sh check              verify credentials + connectivity
#   xray-api.sh token              print a bearer token (cached ~20h)
#   xray-api.sh gql [file|-]       run a GraphQL query from a file or stdin
#
# Requires XRAY_CLIENT_ID and XRAY_CLIENT_SECRET in the environment.
# Override the region with XRAY_BASE_URL (default: https://xray.cloud.getxray.app).
set -euo pipefail

XRAY_BASE_URL="${XRAY_BASE_URL:-https://xray.cloud.getxray.app}"
TOKEN_CACHE="${TMPDIR:-/tmp}/.xray-token-$(id -u)"
TOKEN_MAX_AGE=72000 # 20h; Xray tokens are valid for 24h

die() { printf 'xray-api: %s\n' "$*" >&2; exit 1; }

file_mtime() { stat -f %m "$1" 2>/dev/null || stat -c %Y "$1"; }

# Split a `curl -w '\n%{http_code}'` response into body + status.
http_status() { printf '%s' "$1" | tail -n1; }
http_body()   { printf '%s' "$1" | sed '$d'; }

get_token() {
  if [ -s "$TOKEN_CACHE" ]; then
    local age=$(( $(date +%s) - $(file_mtime "$TOKEN_CACHE") ))
    if [ "$age" -lt "$TOKEN_MAX_AGE" ]; then cat "$TOKEN_CACHE"; return 0; fi
  fi

  [ -n "${XRAY_CLIENT_ID:-}" ]     || die "XRAY_CLIENT_ID is not set (see .claude/qa/README.md)"
  [ -n "${XRAY_CLIENT_SECRET:-}" ] || die "XRAY_CLIENT_SECRET is not set (see .claude/qa/README.md)"

  local req resp code body
  req=$(jq -nc --arg id "$XRAY_CLIENT_ID" --arg secret "$XRAY_CLIENT_SECRET" \
        '{client_id:$id, client_secret:$secret}')
  resp=$(curl -sS -w '\n%{http_code}' -X POST "$XRAY_BASE_URL/api/v2/authenticate" \
         -H 'Content-Type: application/json' -d "$req")
  code=$(http_status "$resp"); body=$(http_body "$resp")
  [ "$code" = "200" ] || die "authenticate failed (HTTP $code): $body"

  # A successful response is a JSON string (quote-delimited) holding the JWT.
  printf '%s' "$body" | jq -r . > "$TOKEN_CACHE"
  chmod 600 "$TOKEN_CACHE"
  cat "$TOKEN_CACHE"
}

run_gql() {
  local src="${1:--}" query token req resp code body
  if [ "$src" = "-" ]; then query=$(cat); else
    [ -f "$src" ] || die "no such query file: $src"
    query=$(cat "$src")
  fi
  [ -n "$query" ] || die "empty GraphQL query"

  token=$(get_token)
  req=$(jq -nc --arg q "$query" '{query:$q}')
  resp=$(curl -sS -w '\n%{http_code}' -X POST "$XRAY_BASE_URL/api/v2/graphql" \
         -H "Authorization: Bearer $token" \
         -H 'Content-Type: application/json' -d "$req")
  code=$(http_status "$resp"); body=$(http_body "$resp")

  [ "$code" = "200" ] || die "graphql HTTP $code: $body"
  # GraphQL reports application errors with a 200 status, so inspect the payload.
  if printf '%s' "$body" | jq -e '(.errors // []) | length > 0' >/dev/null; then
    die "graphql errors: $(printf '%s' "$body" | jq -c '.errors')"
  fi
  printf '%s\n' "$body"
}

case "${1:-}" in
  token) get_token ;;
  gql)   shift; run_gql "${1:--}" ;;
  check)
    get_token >/dev/null
    printf 'auth OK (%s)\n' "$XRAY_BASE_URL"
    run_gql - <<'GQL' | jq -r '"API OK — reachable as project-scoped user"'
{ getTests(limit: 1) { total } }
GQL
    ;;
  *) awk 'NR>1 && /^#/ { sub(/^# ?/, ""); print; next } NR>1 { exit }' "$0"; exit 1 ;;
esac
