#!/usr/bin/env bash
# Serves dist/ on a loopback port, drives the real page in headless Chrome,
# tears both down.
#
#   test/run-browser-check.sh <rom> [outdir]
#
# Three things here are load-bearing and were learned the hard way elsewhere on
# this fleet:
#
#  * --remote-debugging-port=0 plus a private --user-data-dir. A fixed debug
#    port lets your harness attach to a DIFFERENT agent's Chrome on a shared
#    box, and then you grade someone else's page as if it were yours.
#  * a nonce in the page URL that the target must echo back, so the tab that is
#    attached to is provably the one that was just opened.
#  * every existing page target is closed first. A leftover tab keeps an
#    IndexedDB connection open, deleteDatabase() in the new tab then blocks
#    forever, and the page hangs on its first write and never boots -- which
#    looks exactly like a broken emulator core.
#
# Chrome also gets --mute-audio as a second line of defence; the page itself
# creates no AudioContext unless asked, and the harness asserts that.
set -euo pipefail

ROM="${1:?usage: run-browser-check.sh <rom> [outdir]}"
OUT="${2:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DIST="$HERE/../dist"
TMP="$(mktemp -d)"

# Chrome spawns zygote/gpu/renderer children that outlive a SIGTERM to the
# parent, so it gets its own process group and the whole group is signalled.
kill_group() {
  local pid="$1"
  [ -n "$pid" ] || return 0
  kill -TERM "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
  for _ in $(seq 1 20); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.1
  done
  kill -KILL "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
}
cleanup() {
  kill_group "${CHROME_PID:-}"
  kill_group "${HTTP_PID:-}"
  wait 2>/dev/null || true
  rm -rf "$TMP" 2>/dev/null || true
}
trap cleanup EXIT

[ -f "$DIST/index.html" ] || { echo "no $DIST/index.html -- run 'make' first" >&2; exit 1; }

PORT=$(python3 -c "import socket;s=socket.socket();s.bind(('127.0.0.1',0));print(s.getsockname()[1]);s.close()")
# Launched directly, not inside a ( ... ) subshell: backgrounding a subshell makes
# $! the subshell's pid, so the trap would kill the wrapper and leave python
# serving dist/ forever.
python3 -m http.server "$PORT" --bind 127.0.0.1 --directory "$DIST" >"$TMP/httpd.log" 2>&1 &
HTTP_PID=$!

setsid google-chrome --headless=new --remote-debugging-port=0 --user-data-dir="$TMP/profile" \
  --no-first-run --no-default-browser-check --disable-gpu --mute-audio \
  --window-size=960,720 about:blank >"$TMP/chrome.log" 2>&1 &
CHROME_PID=$!

for _ in $(seq 1 60); do
  [ -s "$TMP/profile/DevToolsActivePort" ] && break
  sleep 0.2
done
[ -s "$TMP/profile/DevToolsActivePort" ] || { echo "Chrome never published a debug port" >&2; exit 1; }
CPORT=$(head -1 "$TMP/profile/DevToolsActivePort")
echo "chrome debug port $CPORT (ephemeral), http port $PORT, profile $TMP/profile"

curl -s "http://127.0.0.1:$CPORT/json/list" \
  | python3 -c "import sys,json;[print(t['id']) for t in json.load(sys.stdin) if t['type']=='page']" \
  | while read -r id; do curl -s "http://127.0.0.1:$CPORT/json/close/$id" >/dev/null; done

# /json/new has been PUT-only since Chrome 111.
WS=$(curl -s -X PUT "http://127.0.0.1:$CPORT/json/new?about:blank" \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['webSocketDebuggerUrl'])")

CDP_URL="$WS" node "$HERE/browser-check.mjs" "http://127.0.0.1:$PORT/index.html" "$ROM" ${OUT:+"$OUT"}
