#!/usr/bin/env bash
#
# convert-bench.sh — fire N simultaneous avatar conversions and time them.
#
# Usage:
#   ./tools/convert-bench.sh                      # defaults
#   USER_ID=156 FORMATS="glb gltf fbx" ./tools/convert-bench.sh
#   BASE_URL=http://162.19.133.164:7860 ./tools/convert-bench.sh
#   DOWNLOAD=0 ./tools/convert-bench.sh           # skip the download step
#
# Configuration comes from (lowest to highest precedence):
#   1. defaults below
#   2. tools/.env            (gitignored; copy from tools/.env.example)
#   3. environment variables (e.g. USER_ID=156 ./tools/convert-bench.sh)
#   4. the file named by ENV_FILE, if set
#
# Env knobs (all optional):
#   ENV_FILE      path to an alternate env file to load
#   BASE_URL      API base (default https://api.harrycore.web.id)
#   USER_ID       Roblox user ID (default 4437958744)
#   FORMATS       space-separated formats (default "glb gltf fbx")
#   SUBDIVISION   mesh quality 0-4 (default 2)
#   RIG           1 to auto-rig (default 1)
#   MORE_JOINTS   1 for R6 extra bones (default 0)
#   DOWNLOAD      1 download/cache the avatar first, 0 skip (default 1)
#   OUT_DIR       directory for output files (default /tmp/convert-bench)
#   ROUNDS        repeat the whole batch this many times (default 1)

set -u

# --- load .env files -------------------------------------------------------
# Values already present in the environment win over file values, so
# `USER_ID=156 ./tools/convert-bench.sh` still overrides tools/.env.
load_env() {
    local f="$1"
    [ -f "$f" ] || return 0
    while IFS= read -r line || [ -n "$line" ]; do
        # strip comments and blank lines
        line="${line%%#*}"
        case "$line" in *[![:space:]]*) ;; *) continue ;; esac
        # key=value -> key, value
        local key="${line%%=*}"
        local val="${line#*=}"
        key="${key#"${key%%[![:space:]]*}"}"   # ltrim
        key="${key%"${key##*[![:space:]]}"}"   # rtrim
        # strip one pair of surrounding quotes from value
        case "$val" in
            \"*\") val="${val#\"}"; val="${val%\"}" ;;
            \'*\') val="${val#\'}"; val="${val%\'}" ;;
        esac
        # only set when not already provided by the caller/environment
        if [ -z "${!key+x}" ] && [ -n "$key" ]; then
            export "$key=$val"
        fi
    done < "$f"
}

load_env "${ENV_FILE:-}"
load_env "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.env"

BASE_URL="${BASE_URL:-https://api.harrycore.web.id}"
USER_ID="${USER_ID:-4437958744}"
FORMATS="${FORMATS:-glb gltf fbx}"
SUBDIVISION="${SUBDIVISION:-2}"
RIG="${RIG:-1}"
MORE_JOINTS="${MORE_JOINTS:-0}"
DOWNLOAD="${DOWNLOAD:-1}"
OUT_DIR="${OUT_DIR:-/tmp/convert-bench}"
ROUNDS="${ROUNDS:-1}"

TS_DIR="$(date +%Y%m%d-%H%M%S)"
OUT_DIR="$OUT_DIR/$TS_DIR"

say()  { printf '\033[36m[bench]\033[0m %s\n' "$*"; }
ok()   { printf '\033[32m[ok]\033[0m %s\n' "$*"; }
warn() { printf '\033[33m[warn]\033[0m %s\n' "$*"; }
err()  { printf '\033[31m[err]\033[0m %s\n' "$*"; }

command -v curl >/dev/null 2>&1 || { err "curl is required"; exit 1; }

mkdir -p "$OUT_DIR"

say "Base URL   : $BASE_URL"
say "User ID    : $USER_ID"
say "Formats    : $FORMATS"
say "Subdivision: $SUBDIVISION  |  rig=$RIG  moreJoints=$MORE_JOINTS"
say "Rounds     : $ROUNDS"
say "Output dir : $OUT_DIR"

# --- optional warm-up download -------------------------------------------
if [ "$DOWNLOAD" = "1" ]; then
    say "Downloading avatar to cache it..."
    dl_t0=$(date +%s.%N)
    dl_code=$(curl -s -o "$OUT_DIR/download.json" -w '%{http_code}' \
        "$BASE_URL/api/roblox/download/$USER_ID")
    dl_t1=$(date +%s.%N)
    dl_ms=$(awk "BEGIN{printf \"%.0f\", ($dl_t1-$dl_t0)*1000}")
    if [ "$dl_code" = "200" ]; then
        ok "download 200 (${dl_ms} ms) -> $OUT_DIR/download.json"
    else
        err "download failed (HTTP $dl_code) -> $OUT_DIR/download.json"
        err "aborted; /convert needs a cached avatar"
        exit 1
    fi
fi

# --- build query string once ---------------------------------------------
QS="subdivision=$SUBDIVISION&rig=$RIG&moreJoints=$MORE_JOINTS"

run_round() {
    local round="$1"
    local count
    count=$(set -- $FORMATS; echo $#)
    say "--- round $round/$ROUNDS: $count conversions in parallel ---"
    local round_t0 round_t1
    round_t0=$(date +%s.%N)

    local pids=()
    local i=0
    for fmt in $FORMATS; do
        i=$((i+1))
        local out="$OUT_DIR/r${round}_${i}_${fmt}"
        local url="$BASE_URL/api/roblox/convert/$USER_ID/$fmt?$QS"
        # meta fields: HTTP code, TTFB (s), total (s), bytes
        curl -s -o "${out}.bin" \
            -w '%{http_code} %{time_starttransfer} %{time_total} %{size_download}\n' \
            "$url" > "${out}.meta" 2>/dev/null &
        pids+=("$!")
    done

    local fail=0
    for pid in "${pids[@]}"; do
        if ! wait "$pid"; then
            fail=$((fail+1))
        fi
    done

    round_t1=$(date +%s.%N)
    local wall_ms
    wall_ms=$(awk "BEGIN{printf \"%.0f\", ($round_t1-$round_t0)*1000}")

    printf '%s\n' "------------------------------------------------------------------------------------------------"
    printf '%-8s %-6s %-10s %-10s %-8s %-9s %-10s\n' \
        "FORMAT" "HTTP" "TTFB(ms)" "TOTAL(ms)" "SERVER" "NETWORK" "BYTES"
    local n=0
    local sum_ttfb=0 sum_total=0
    for fmt in $FORMATS; do
        n=$((n+1))
        local meta="$OUT_DIR/r${round}_${n}_${fmt}.meta"
        read -r code ttfb tsec bytes < "$meta" 2>/dev/null || { code="?"; ttfb="0"; tsec="0"; bytes="0"; }
        local ttfb_ms total_ms net_ms server_s net_s
        ttfb_ms=$(awk "BEGIN{printf \"%.0f\", $ttfb*1000}")
        total_ms=$(awk "BEGIN{printf \"%.0f\", $tsec*1000}")
        # TTFB ~ server compute (connect+queue+build until first byte).
        # NETWORK = total - ttfb = time spent downloading the payload.
        net_ms=$(awk "BEGIN{d=$tsec-$ttfb; if(d<0)d=0; printf \"%.0f\", d*1000}")
        server_s=$(awk "BEGIN{printf \"%.1fs\", $ttfb}")
        net_s=$(awk "BEGIN{d=$tsec-$ttfb; if(d<0)d=0; printf \"%.1fs\", d}")
        sum_ttfb=$(awk "BEGIN{printf \"%.3f\", $sum_ttfb+$ttfb}")
        sum_total=$(awk "BEGIN{printf \"%.3f\", $sum_total+$tsec}")
        local flag=""
        [ "$code" != "200" ] && { flag=" <== FAIL"; fail=$((fail+1)); }
        printf '%-8s %-6s %-10s %-10s %-8s %-9s %-10s%s\n' \
            "$fmt" "$code" "$ttfb_ms" "$total_ms" "$server_s" "$net_s" "$bytes" "$flag"
    done
    local avg_server avg_net
    avg_server=$(awk -v s="$sum_ttfb" -v n="$n" 'BEGIN{printf "%.1fs", (n>0)?s/n:0}')
    avg_net=$(awk -v s="$sum_total" -v t="$sum_ttfb" -v n="$n" 'BEGIN{printf "%.1fs", (n>0)?(s-t)/n:0}')
    printf '%s\n' "------------------------------------------------------------------------------------------------"
    printf 'per-req avg: server ~%s  network ~%s  |  wall %s ms\n' \
        "$avg_server" "$avg_net" "$wall_ms"
    printf 'sequential sum: ~%s ms (all formats one-at-a-time)\n' \
        "$(awk -v t="$sum_total" 'BEGIN{printf "%.0f", t*1000}')"

    return "$fail"
}

total_fail=0
r=0
while [ "$r" -lt "$ROUNDS" ]; do
    r=$((r+1))
    run_round "$r" || total_fail=$((total_fail+1))
done

echo
if [ "$total_fail" -eq 0 ]; then
    ok "all rounds completed with HTTP 200"
    ok "files in: $OUT_DIR"
else
    err "$total_fail round(s) had failures; inspect $OUT_DIR"
    exit 1
fi