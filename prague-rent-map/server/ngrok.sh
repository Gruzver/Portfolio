#!/usr/bin/env bash
# OPTIONAL: exposes the rent-map server to the internet through an ngrok tunnel.
# The server keeps listening ONLY on the ZeroTier address; the ngrok agent runs on this same
# machine and connects to it from inside, so no port is opened on the router.
#
# Needs: ngrok installed, its authtoken configured (`ngrok config add-authtoken ...`, never
# put the token in a script or in git) and RENTMAP_NGROK_DOMAIN set to your ngrok domain.
# The same variable must be set for run.sh so the server accepts that name.
# Meant for cron:  @reboot /path/to/prague-rent-map/server/ngrok.sh >> ~/rent-map-data/ngrok.log 2>&1
#
# Environment (all optional except the domain): RENTMAP_PORT (8789), RENTMAP_BIND, RENTMAP_WAIT_SECS (5)
set -u

DOMAIN="${RENTMAP_NGROK_DOMAIN:-}"
PORT="${RENTMAP_PORT:-8789}"
WAIT="${RENTMAP_WAIT_SECS:-5}"
IP="${RENTMAP_BIND:-}"

if [ -z "$DOMAIN" ]; then
  echo "rent-map: set RENTMAP_NGROK_DOMAIN to your ngrok domain (for example name.ngrok-free.app)" >&2
  exit 1
fi

# same ZeroTier lookup as run.sh (cron @reboot runs before the interface exists)
for _ in $(seq 60); do
  [ -n "$IP" ] && break
  IP="$(ip -4 -brief addr show 2>/dev/null | awk '$1 ~ /^zt/ {split($3,a,"/"); print a[1]; exit}')"
  [ -n "$IP" ] && break
  sleep "$WAIT"
done
if [ -z "$IP" ]; then
  echo "rent-map: no ZeroTier interface found after waiting; not opening the tunnel" >&2
  exit 1
fi

# do not open a public tunnel to a server that is not up (401 = up, but asking for its password)
up=""
for _ in $(seq 60); do
  case "$(curl -s -o /dev/null -w '%{http_code}' -m 3 "http://$IP:$PORT/api/ping" 2>/dev/null)" in
    200|401) up=1; break ;;
  esac
  sleep "$WAIT"
done
if [ -z "$up" ]; then
  echo "rent-map: the server is not answering on $IP:$PORT; not opening the tunnel" >&2
  exit 1
fi

# ngrok renamed the flag: recent agents use --url, older ones --domain
if ngrok http --help 2>&1 | grep -q -- '--url'; then
  exec ngrok http --url="https://$DOMAIN" "$IP:$PORT"
fi
exec ngrok http --domain="$DOMAIN" "$IP:$PORT"
