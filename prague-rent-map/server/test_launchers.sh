#!/usr/bin/env bash
# Tests for run.sh and ngrok.sh with stub `ip` and `ngrok` commands (no real ZeroTier or ngrok needed).
#   bash server/test_launchers.sh
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
T="$(mktemp -d)"
PIDS=()
cleanup() { for p in "${PIDS[@]+"${PIDS[@]}"}"; do kill "$p" 2>/dev/null; done; rm -rf "$T"; }
trap cleanup EXIT
FAILED=0
check() { if [ "$2" = ok ]; then echo "PASS  $1"; else echo "FAIL  $1 ${3:-}"; FAILED=1; fi; }
free_port() { python3 -c 'import socket;s=socket.socket();s.bind(("127.0.0.1",0));print(s.getsockname()[1]);s.close()'; }
code() { curl -s -o /dev/null -w '%{http_code}' -m 3 "$@" 2>/dev/null; }

mkdir -p "$T/bin" "$T/bin-old"
# `ip` stub: shows a ZeroTier interface (on loopback so we can bind it) only from the 4th call on
cat > "$T/bin/ip" <<'STUB'
#!/usr/bin/env bash
n=$(cat "$STUB_COUNT" 2>/dev/null || echo 0); n=$((n + 1)); echo "$n" > "$STUB_COUNT"
echo "lo               UNKNOWN        127.0.0.1/8"
echo "wlp2s0           UP             192.168.0.129/24"
[ "$n" -ge 4 ] && echo "zteywshgyb       UNKNOWN        127.0.0.1/24"
exit 0
STUB
cat > "$T/bin-old/ip" <<'STUB'
#!/usr/bin/env bash
echo "lo               UNKNOWN        127.0.0.1/8"
echo "wlp2s0           UP             192.168.0.129/24"
STUB
# `ngrok` stubs: a recent one (has --url) and an old one (only --domain)
cat > "$T/bin/ngrok" <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" = http ] && [ "${2:-}" = --help ]; then echo "  --url string   --domain string (deprecated)"; exit 0; fi
echo "$@" > "$NGROK_ARGS"
STUB
mkdir -p "$T/bin-oldngrok"
cat > "$T/bin-oldngrok/ngrok" <<'STUB'
#!/usr/bin/env bash
if [ "${1:-}" = http ] && [ "${2:-}" = --help ]; then echo "  --domain string"; exit 0; fi
echo "$@" > "$NGROK_ARGS"
STUB
chmod +x "$T"/bin/* "$T"/bin-old/* "$T"/bin-oldngrok/*

PORT="$(free_port)"
DOMAIN="demo.ngrok-free.app"
export STUB_COUNT="$T/count" NGROK_ARGS="$T/ngrok.args" RENTMAP_WAIT_SECS=0.2

echo "--- run.sh waits for the ZeroTier interface, binds to it and accepts the tunnel's Host"
PATH="$T/bin:$PATH" RENTMAP_PORT="$PORT" RENTMAP_DATA="$T/data" RENTMAP_NGROK_DOMAIN="$DOMAIN" bash "$HERE/run.sh" > "$T/run.log" 2>&1 &
PIDS+=($!)
for _ in $(seq 60); do [ "$(code "http://127.0.0.1:$PORT/api/ping")" = 200 ] && break; sleep 0.25; done
[ "$(code "http://127.0.0.1:$PORT/api/ping")" = 200 ] && check "server comes up on the interface found after waiting" ok || check "server comes up" no "$(cat "$T/run.log")"
[ "$(cat "$T/count")" -ge 4 ] && check "it polled for the interface until it appeared ($(cat "$T/count") calls)" ok || check "it polled for the interface" no
[ "$(code -H "Host: $DOMAIN" "http://127.0.0.1:$PORT/api/ping")" = 200 ] && check "the tunnel's public name is accepted" ok || check "tunnel Host accepted" no
[ "$(code -H "Host: evil.example.com" "http://127.0.0.1:$PORT/api/ping")" = 403 ] && check "any other name is refused (403)" ok || check "other Host refused" no

echo "--- run.sh never falls back to every interface"
PATH="$T/bin-old:$PATH" RENTMAP_PORT="$(free_port)" RENTMAP_DATA="$T/data2" RENTMAP_WAIT_SECS=0.01 bash "$HERE/run.sh" > "$T/norun.log" 2>&1
rc=$?
{ [ "$rc" = 1 ] && grep -q "must never listen on every interface" "$T/norun.log"; } && check "refuses to start without a ZeroTier interface" ok || check "refuses without interface" no "rc=$rc"

echo "--- ngrok.sh"
RENTMAP_NGROK_DOMAIN="" bash "$HERE/ngrok.sh" > "$T/n1.log" 2>&1; rc=$?
{ [ "$rc" = 1 ] && grep -q "RENTMAP_NGROK_DOMAIN" "$T/n1.log"; } && check "asks for the domain when it is missing" ok || check "asks for the domain" no
rm -f "$T/ngrok.args"
PATH="$T/bin:$PATH" RENTMAP_BIND=127.0.0.1 RENTMAP_PORT="$PORT" RENTMAP_NGROK_DOMAIN="$DOMAIN" bash "$HERE/ngrok.sh" > "$T/n2.log" 2>&1
[ "$(cat "$T/ngrok.args" 2>/dev/null)" = "http --url=https://$DOMAIN 127.0.0.1:$PORT" ] && check "recent ngrok: tunnel to the server's own address with --url" ok || check "recent ngrok args" no "$(cat "$T/ngrok.args" 2>/dev/null)"
rm -f "$T/ngrok.args"
PATH="$T/bin-oldngrok:$PATH" RENTMAP_BIND=127.0.0.1 RENTMAP_PORT="$PORT" RENTMAP_NGROK_DOMAIN="$DOMAIN" bash "$HERE/ngrok.sh" > "$T/n3.log" 2>&1
[ "$(cat "$T/ngrok.args" 2>/dev/null)" = "http --domain=$DOMAIN 127.0.0.1:$PORT" ] && check "older ngrok: falls back to --domain" ok || check "old ngrok args" no "$(cat "$T/ngrok.args" 2>/dev/null)"
rm -f "$T/ngrok.args"
PATH="$T/bin:$PATH" RENTMAP_BIND=127.0.0.1 RENTMAP_PORT="$(free_port)" RENTMAP_WAIT_SECS=0.02 RENTMAP_NGROK_DOMAIN="$DOMAIN" bash "$HERE/ngrok.sh" > "$T/n4.log" 2>&1
rc=$?
{ [ "$rc" = 1 ] && [ ! -e "$T/ngrok.args" ] && grep -q "not opening the tunnel" "$T/n4.log"; } && check "does not open a public tunnel when the server is down" ok || check "no tunnel without server" no "rc=$rc"

echo
[ "$FAILED" = 0 ] && echo "all launcher tests passed" || echo "SOME LAUNCHER TESTS FAILED"
exit "$FAILED"
