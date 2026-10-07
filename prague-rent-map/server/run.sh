#!/usr/bin/env bash
# Starts the rent-map server bound ONLY to this machine's ZeroTier address.
# Meant for cron:   @reboot /path/to/prague-rent-map/server/run.sh >> ~/rent-map-data/server.log 2>&1
#
# Environment overrides (all optional):
#   RENTMAP_PORT       port to listen on                 (default 8789)
#   RENTMAP_DATA       where listings/backups are kept   (default ~/rent-map-data)
#   RENTMAP_BIND       fixed IP instead of auto-detection (handy for testing: 127.0.0.1)
#   RENTMAP_WAIT_SECS  seconds between interface checks   (default 5; tries 60 times)
set -u

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
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
exec "$PY" "$HERE/server.py" --bind "$IP" --port "$PORT" --data "$DATA"
