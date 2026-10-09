#!/usr/bin/env python3
"""Rent-map server: serves the static app and keeps the listings as JSON files, so every
device that opens the app sees the same list. Python 3.10+, standard library only.

By default there is NO authentication: the listings contain third-party phone numbers and
screenshots, so the server must only be reachable from a private network (ZeroTier).
For that reason it refuses to bind to 0.0.0.0 unless you pass --allow-any-interface, and it
only answers requests whose Host header is one it expects (protects against DNS rebinding).

If the server is going to be reachable from the internet (for example through a tunnel), set
the RENTMAP_PASSWORD environment variable: every request, static files included, then needs
HTTP Basic auth with that password (any user name). Add --require-password so the server
refuses to start at all when no password is configured, instead of silently running open.

API (all JSON, paths relative to the server root):
  GET    /api/ping
  GET    /api/index                  -> {"listings": [{id, updatedAt}], "deleted": [{id, deletedAt}]}
  GET    /api/listings/<id>
  PUT    /api/listings/<id>          body: the listing; 409 if the stored one is newer
  DELETE /api/listings/<id>?at=<ms>  records a tombstone; 409 if the stored one is newer
"""

import argparse
import base64
import hmac
import ipaddress
import json
import math
import os
import re
import shutil
import sys
import threading
import time
from datetime import date, timedelta
from functools import partial
from http import HTTPStatus
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlsplit

ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,80}$")
INDEX_MARKER = '<meta name="rentmap-server" content="1">'  # read by js/sync.js
LONG_CACHE_PREFIXES = ("/vendor/", "/assets/")  # never change in place: the browser may keep them a day
MIN_PASSWORD_LENGTH = 8
FAIL_DELAY_S = 0.5  # pause after a wrong password; behind a tunnel every client shares one address, so no per-IP limit
DEFAULT_MAX_BODY_MB = 40
MAX_LISTINGS = 5000
BACKUP_KEEP_DAYS = 14


def now_ms():
    return int(time.time() * 1000)


def is_number(value):
    return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value)


class Conflict(Exception):
    def __init__(self, current):
        super().__init__("stored version is newer")
        self.current = current


class Store:
    """Listings as <data>/listings/<id>.json and tombstones as <data>/deleted/<id>.json."""

    def __init__(self, root):
        self.root = Path(root)
        self.listings_dir = self.root / "listings"
        self.deleted_dir = self.root / "deleted"
        self.backups_dir = self.root / "backups"
        for d in (self.listings_dir, self.deleted_dir, self.backups_dir):
            d.mkdir(parents=True, exist_ok=True)
        self.lock = threading.RLock()
        self.index = {}    # id -> updatedAt (ms)
        self.deleted = {}  # id -> deletedAt (ms)
        self._load()

    # -- startup ------------------------------------------------------------------------
    def _load(self):
        for path in self.listings_dir.glob("*.json"):
            try:
                data = json.loads(path.read_text(encoding="utf-8"))
                self.index[path.stem] = int(data.get("updatedAt") or data.get("createdAt") or path.stat().st_mtime * 1000)
            except (OSError, ValueError):
                print(f"warning: skipping unreadable {path}", file=sys.stderr)
        for path in self.deleted_dir.glob("*.json"):
            try:
                self.deleted[path.stem] = int(json.loads(path.read_text(encoding="utf-8"))["deletedAt"])
            except (OSError, ValueError, KeyError):
                print(f"warning: skipping unreadable {path}", file=sys.stderr)

    # -- helpers ------------------------------------------------------------------------
    @staticmethod
    def _write_atomic(path, data):
        tmp = path.with_name(f".{path.name}.tmp")
        with open(tmp, "wb") as fh:
            fh.write(data)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, path)

    def snapshot(self):
        with self.lock:
            return (
                [{"id": i, "updatedAt": t} for i, t in sorted(self.index.items())],
                [{"id": i, "deletedAt": t} for i, t in sorted(self.deleted.items())],
            )

    # -- operations ---------------------------------------------------------------------
    def read(self, listing_id):
        path = self.listings_dir / f"{listing_id}.json"
        with self.lock:
            if listing_id not in self.index:
                return None
            return path.read_bytes()

    def put(self, listing_id, listing):
        updated = int(listing["updatedAt"])
        with self.lock:
            current = self.index.get(listing_id)
            if current is not None and updated < current:
                raise Conflict(current)
            if current is None and len(self.index) >= MAX_LISTINGS:
                raise ValueError("too many listings")
            self._write_atomic(self.listings_dir / f"{listing_id}.json", json.dumps(listing, ensure_ascii=False).encode("utf-8"))
            self.index[listing_id] = updated
            if listing_id in self.deleted and self.deleted[listing_id] <= updated:
                (self.deleted_dir / f"{listing_id}.json").unlink(missing_ok=True)
                del self.deleted[listing_id]
            return updated

    def delete(self, listing_id, deleted_at):
        with self.lock:
            current = self.index.get(listing_id)
            if current is not None and current > deleted_at:
                raise Conflict(current)
            if current is not None:
                (self.listings_dir / f"{listing_id}.json").unlink(missing_ok=True)
                del self.index[listing_id]
            known = self.deleted.get(listing_id, 0)
            stamp = max(known, deleted_at)
            self._write_atomic(self.deleted_dir / f"{listing_id}.json", json.dumps({"id": listing_id, "deletedAt": stamp}).encode("utf-8"))
            self.deleted[listing_id] = stamp
            return stamp

    # -- backups ------------------------------------------------------------------------
    def backup_if_needed(self):
        today = date.today().isoformat()
        target = self.backups_dir / today
        with self.lock:
            if target.exists() or not (self.index or self.deleted):
                return None
            tmp = self.backups_dir / f".{today}.tmp"
            shutil.rmtree(tmp, ignore_errors=True)
            shutil.copytree(self.listings_dir, tmp / "listings")
            shutil.copytree(self.deleted_dir, tmp / "deleted")
            os.replace(tmp, target)
        cutoff = (date.today() - timedelta(days=BACKUP_KEEP_DAYS)).isoformat()
        for old in self.backups_dir.iterdir():
            if re.fullmatch(r"\d{4}-\d{2}-\d{2}", old.name) and old.name < cutoff:
                shutil.rmtree(old, ignore_errors=True)
        return target


def validate_listing(listing_id, data):
    if not isinstance(data, dict):
        return "body must be a JSON object"
    if data.get("id") != listing_id:
        return "id in body does not match the URL"
    if not is_number(data.get("lat")) or not is_number(data.get("lng")):
        return "lat and lng must be numbers"
    if "updatedAt" in data and not is_number(data["updatedAt"]):
        return "updatedAt must be a number (ms since epoch)"
    return None


def check_basic_auth(header, password):
    """True if `header` is HTTP Basic auth whose password matches. Any user name is accepted.
    The comparison takes the same time wherever the first difference is."""
    if not header or not header.lower().startswith("basic "):
        return False
    try:
        decoded = base64.b64decode(header[6:].strip(), validate=True).decode("utf-8")
    except (ValueError, UnicodeDecodeError):
        return False
    _, colon, supplied = decoded.partition(":")
    return bool(colon) and hmac.compare_digest(supplied.encode("utf-8"), password)


class Handler(SimpleHTTPRequestHandler):
    server_version = "RentMap/1.0"

    # -- plumbing -----------------------------------------------------------------------
    @property
    def store(self):
        return self.server.store

    def log_message(self, fmt, *args):
        # keep the log short: API writes and anything that is not a plain success
        status = str(args[1]) if len(args) > 1 else ""
        if self.command in ("PUT", "DELETE") or not status.startswith(("2", "3")):
            super().log_message(fmt, *args)

    def send_response(self, code, message=None):
        self._status = int(code)
        super().send_response(code, message)

    def end_headers(self):
        self.send_header("X-Content-Type-Options", "nosniff")
        if not self.path.startswith("/api/"):
            # every request counts against a metered tunnel (ngrok free: 20k/month), so the
            # heavy static files get a day of cache; everything else is revalidated
            long_lived = self.path.startswith(LONG_CACHE_PREFIXES) and getattr(self, "_status", 0) == 200
            self.send_header("Cache-Control", "public, max-age=86400" if long_lived else "no-cache")
        super().end_headers()

    def send_json(self, status, payload):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def require_auth(self):
        """True when the request was refused (a 401 has already been sent): the caller must stop."""
        password = self.server.password
        if password is None:
            return False
        header = self.headers.get("Authorization")
        if check_basic_auth(header, password):
            return False
        if header:  # a wrong password, as opposed to the browser's first try without credentials
            time.sleep(self.server.fail_delay)
        body = json.dumps({"error": "password required"}).encode("utf-8")
        self.close_connection = True  # any request body was not read
        self.send_response(HTTPStatus.UNAUTHORIZED)
        self.send_header("WWW-Authenticate", 'Basic realm="Mapa de alquiler", charset="UTF-8"')
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
        return True

    def host_allowed(self):
        host = (self.headers.get("Host") or "").lower()
        return host in self.server.allowed_hosts

    def is_api(self):
        return urlsplit(self.path).path.startswith("/api/")

    def serve_index(self):
        """index.html with a marker, so the app only probes /api when this server sent it
        (on a static host the probe would just be a noisy 404). Returns False to fall back."""
        if urlsplit(self.path).path not in ("/", "/index.html"):
            return False
        try:
            html = (Path(self.directory) / "index.html").read_text(encoding="utf-8")
        except OSError:
            return False
        if INDEX_MARKER not in html:
            html = html.replace("<head>", f"<head>\n  {INDEX_MARKER}", 1)
        body = html.encode("utf-8")
        self.send_response(HTTPStatus.OK)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)
        return True

    def route(self):
        parts = urlsplit(self.path).path.split("/")  # ['', 'api', 'listings', '<id>']
        return parts[2:] if len(parts) > 2 else []

    # -- verbs --------------------------------------------------------------------------
    def do_GET(self):
        if self.require_auth():
            return None
        if not self.is_api():
            return None if self.serve_index() else super().do_GET()
        if not self.host_allowed():
            return self.send_json(HTTPStatus.FORBIDDEN, {"error": "host not allowed"})
        route = self.route()
        if route == ["ping"]:
            return self.send_json(HTTPStatus.OK, {"ok": True, "app": "prague-rent-map-server", "version": 1})
        if route == ["index"]:
            listings, deleted = self.store.snapshot()
            return self.send_json(HTTPStatus.OK, {"listings": listings, "deleted": deleted})
        if len(route) == 2 and route[0] == "listings" and ID_RE.match(route[1]):
            data = self.store.read(route[1])
            if data is None:
                return self.send_json(HTTPStatus.NOT_FOUND, {"error": "not found"})
            self.send_response(HTTPStatus.OK)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(data)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(data)
            return None
        return self.send_json(HTTPStatus.NOT_FOUND, {"error": "unknown endpoint"})

    def do_HEAD(self):
        if self.require_auth():
            return None
        if self.is_api():
            return self.send_json(HTTPStatus.METHOD_NOT_ALLOWED, {"error": "use GET"})
        return None if self.serve_index() else super().do_HEAD()

    def do_PUT(self):
        if self.require_auth():
            return None
        route = self.route() if self.is_api() else []
        if not (len(route) == 2 and route[0] == "listings" and ID_RE.match(route[1])):
            return self.send_json(HTTPStatus.NOT_FOUND, {"error": "unknown endpoint"})
        if not self.host_allowed():
            return self.send_json(HTTPStatus.FORBIDDEN, {"error": "host not allowed"})
        if (self.headers.get("Content-Type") or "").split(";")[0].strip().lower() != "application/json":
            return self.send_json(HTTPStatus.UNSUPPORTED_MEDIA_TYPE, {"error": "Content-Type must be application/json"})
        length = self.headers.get("Content-Length")
        if length is None or not length.isdigit():
            return self.send_json(HTTPStatus.LENGTH_REQUIRED, {"error": "Content-Length required"})
        if int(length) > self.server.max_body:
            self.close_connection = True
            return self.send_json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"error": "body too large"})
        raw = self.rfile.read(int(length))
        try:
            data = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, ValueError):
            return self.send_json(HTTPStatus.BAD_REQUEST, {"error": "invalid JSON"})
        error = validate_listing(route[1], data)
        if error:
            return self.send_json(HTTPStatus.BAD_REQUEST, {"error": error})
        data.setdefault("updatedAt", now_ms())
        try:
            updated = self.store.put(route[1], data)
        except Conflict as exc:
            return self.send_json(HTTPStatus.CONFLICT, {"error": "stored version is newer", "updatedAt": exc.current})
        except ValueError as exc:
            return self.send_json(HTTPStatus.INSUFFICIENT_STORAGE, {"error": str(exc)})
        return self.send_json(HTTPStatus.OK, {"ok": True, "updatedAt": updated})

    def do_DELETE(self):
        if self.require_auth():
            return None
        route = self.route() if self.is_api() else []
        if not (len(route) == 2 and route[0] == "listings" and ID_RE.match(route[1])):
            return self.send_json(HTTPStatus.NOT_FOUND, {"error": "unknown endpoint"})
        if not self.host_allowed():
            return self.send_json(HTTPStatus.FORBIDDEN, {"error": "host not allowed"})
        at = parse_qs(urlsplit(self.path).query).get("at", [""])[0]
        try:
            deleted_at = int(at) if at else now_ms()
        except ValueError:
            return self.send_json(HTTPStatus.BAD_REQUEST, {"error": "at must be an integer (ms since epoch)"})
        try:
            stamp = self.store.delete(route[1], deleted_at)
        except Conflict as exc:
            return self.send_json(HTTPStatus.CONFLICT, {"error": "stored version is newer", "updatedAt": exc.current})
        return self.send_json(HTTPStatus.OK, {"ok": True, "deletedAt": stamp})

    def do_POST(self):
        if self.require_auth():
            return None
        return self.send_json(HTTPStatus.METHOD_NOT_ALLOWED, {"error": "method not allowed"})

    do_PATCH = do_POST


class RentMapServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, address, handler, store, allowed_hosts, max_body, password=None):
        super().__init__(address, handler)
        self.store = store
        self.password = password  # bytes, or None for no authentication
        self.fail_delay = FAIL_DELAY_S
        self.allowed_hosts = {h.lower() for h in allowed_hosts}
        self.max_body = max_body


def build_server(bind, port, web_root, data_dir, extra_hosts=(), max_body_mb=DEFAULT_MAX_BODY_MB, allow_any_interface=False,
                 password=None, require_password=False):
    if password is None and require_password:
        raise SystemExit("--require-password is set but no password is configured (RENTMAP_PASSWORD). Not starting.")
    if password is not None and len(password) < MIN_PASSWORD_LENGTH:
        raise SystemExit(f"The password must have at least {MIN_PASSWORD_LENGTH} characters (an empty RENTMAP_PASSWORD "
                         "is refused too, so a failed environment load cannot leave the server open).")
    address = ipaddress.ip_address(bind)
    if address.is_unspecified and not allow_any_interface:
        raise SystemExit("Refusing to listen on all interfaces: the data has no password. "
                         "Bind to the ZeroTier IP, or pass --allow-any-interface if you really mean it.")
    web_root = Path(web_root).resolve()
    data_dir = Path(data_dir).resolve()
    if data_dir == web_root or web_root in data_dir.parents:
        raise SystemExit(f"The data directory ({data_dir}) must not be inside the web root ({web_root}).")
    store = Store(data_dir)
    hosts = set(extra_hosts)
    for name in {bind, "localhost", "127.0.0.1"}:
        hosts.update({name, f"{name}:{port}"})
    handler = partial(Handler, directory=str(web_root))
    server = RentMapServer((bind, port), handler, store, hosts, max_body_mb * 1024 * 1024,
                           None if password is None else password.encode("utf-8"))
    if port == 0:  # tests: the real port is only known after binding
        real = server.server_address[1]
        for name in {bind, "localhost", "127.0.0.1"}:
            server.allowed_hosts.add(f"{name}:{real}".lower())
    return server


def backup_loop(store):
    while True:
        try:
            made = store.backup_if_needed()
            if made:
                print(f"backup written: {made}", file=sys.stderr, flush=True)
        except OSError as exc:
            print(f"backup failed: {exc}", file=sys.stderr, flush=True)
        time.sleep(3600)


def main():
    here = Path(__file__).resolve().parent
    parser = argparse.ArgumentParser(description="Rent map server (static app + listings storage)")
    parser.add_argument("--bind", required=True, help="IP to listen on (use the ZeroTier IP)")
    parser.add_argument("--port", type=int, default=8789)
    parser.add_argument("--web", default=str(here.parent), help="folder with index.html (default: the app folder)")
    parser.add_argument("--data", default=str(Path.home() / "rent-map-data"), help="where listings and backups are stored")
    parser.add_argument("--allow-host", action="append", default=[], help="extra Host header to accept (e.g. a DNS name)")
    parser.add_argument("--max-body-mb", type=int, default=DEFAULT_MAX_BODY_MB)
    parser.add_argument("--allow-any-interface", action="store_true", help="allow 0.0.0.0 (NOT recommended unless a password is set)")
    parser.add_argument("--require-password", action="store_true",
                        help="refuse to start unless RENTMAP_PASSWORD is set (use it whenever the server is reachable from the internet)")
    args = parser.parse_args()

    server = build_server(args.bind, args.port, args.web, args.data, args.allow_host, args.max_body_mb, args.allow_any_interface,
                          password=os.environ.get("RENTMAP_PASSWORD"), require_password=args.require_password)
    threading.Thread(target=backup_loop, args=(server.store,), daemon=True).start()
    print(f"serving {Path(args.web).resolve()} on http://{args.bind}:{args.port}/  data: {Path(args.data).resolve()}  "
          f"password: {'required' if server.password is not None else 'none'}", flush=True)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


if __name__ == "__main__":
    main()
