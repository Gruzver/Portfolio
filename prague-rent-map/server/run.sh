#!/usr/bin/env bash
# Starts the rent-map server bound ONLY to this machine's ZeroTier address.
# Meant for cron:   @reboot /path/to/prague-rent-map/server/run.sh >> ~/rent-map-data/server.log 2>&1
#
# Environment overrides (all optional):
#   RENTMAP_PORT       port to listen on                 (default 8789)
#   RENTMAP_DATA       where listings/backups are kept   (default ~/rent-map-data)
#   RENTMAP_BIND       fixed IP instead of auto-detection (handy for testing: 127.0.0.1)
#   RENTMAP_WAIT_SECS  seconds between interface checks   (default 5; tries 60 times)
#   RENTMAP_NGROK_DOMAIN  your ngrok domain (name.ngrok-free.app): accepted as a valid Host
#   RENTMAP_ALLOW_HOST    other Host names to accept, comma separated
#   RENTMAP_PASSWORD   if set (8+ characters), every request needs this password (HTTP Basic, any user name)
#   RENTMAP_MIN_PASSWORD  shortest password accepted (default 8); lower it only on purpose, it is a risk
#   RENTMAP_ENV_FILE   file of KEY=value lines (chmod 600) loaded first; keeps the password out of crontab and git
#   RENTMAP_REQUIRE_PASSWORD  1 = refuse to start when no password ends up configured (use it with a public tunnel)
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -n "${RENTMAP_ENV_FILE:-}" ]; then
  if [ ! -r "$RENTMAP_ENV_FILE" ]; then
    echo "rent-map: RENTMAP_ENV_FILE=$RENTMAP_ENV_FILE is not readable; not starting" >&2
    exit 1
  fi
  perms="$(stat -c %a "$RENTMAP_ENV_FILE" 2>/dev/null || echo 600)"
  case "$perms" in *[1-7]?|*?[1-7]) echo "rent-map: warning: $RENTMAP_ENV_FILE is readable by other users (chmod 600 it)" >&2 ;; esac
  set -a
  # shellcheck disable=SC1090
  . "$RENTMAP_ENV_FILE"
  set +a
fi
PORT="${RENTMAP_PORT:-8789}"
DATA="${RENTMAP_DATA:-$HOME/rent-map-data}"
WAIT="${RENTMAP_WAIT_SECS:-5}"
IP="${RENTMAP_BIND:-}"
PY="$(command -v python3 || echo /usr/bin/python3)"

# cron @reboot runs BEFORE ZeroTier has an interface: wait (up to ~5 min) and resolve the IP
# on every start instead of hard-coding it, so it survives ZeroTier re-assigning the address.
for _ in $(seq 60); do
  [ -n "$IP" ] && break
  IP="$(ip -4 -brief addr show 2>/dev/null | awk '$1 ~ /^zt/ {split($3,a,"/"); print a[1]; exit}')"
  [ -n "$IP" ] && break
  sleep "$WAIT"
done

if [ -z "$IP" ]; then
  echo "rent-map: no ZeroTier interface found after waiting; not starting (it must never listen on every interface)" >&2
  exit 1
fi

mkdir -p "$DATA"

# Host names the server accepts besides the bind IP and localhost (needed when a tunnel forwards
# requests that carry its public name in the Host header)
EXTRA=()
[ "${RENTMAP_REQUIRE_PASSWORD:-}" = 1 ] && EXTRA+=(--require-password)
[ -n "${RENTMAP_NGROK_DOMAIN:-}" ] && EXTRA+=(--allow-host "$RENTMAP_NGROK_DOMAIN")
if [ -n "${RENTMAP_ALLOW_HOST:-}" ]; then
  IFS=',' read -ra HOSTS <<< "$RENTMAP_ALLOW_HOST"
  for h in "${HOSTS[@]}"; do [ -n "$h" ] && EXTRA+=(--allow-host "$h"); done
fi

exec "$PY" "$HERE/server.py" --bind "$IP" --port "$PORT" --data "$DATA" ${EXTRA[@]+"${EXTRA[@]}"}
