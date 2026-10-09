"""Tests for server.py. Run with:  python3 -m unittest discover -s server -v"""

import base64
import http.client
import json
import tempfile
import threading
import time
import unittest
from datetime import date
from pathlib import Path

import server as srv


def listing(listing_id="a1", updated=1000, **extra):
    data = {"id": listing_id, "title": "2+kk", "lat": 50.07, "lng": 14.43, "updatedAt": updated, "photos": []}
    data.update(extra)
    return data


class ServerCase(unittest.TestCase):
    max_body_mb = 5
    password = None
    min_password_length = srv.MIN_PASSWORD_LENGTH

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.web = base / "web"
        self.web.mkdir()
        (self.web / "index.html").write_text("<html><head><title>t</title></head><body><h1>mapa</h1></body></html>", encoding="utf-8")
        self.data = base / "data"
        self.server = srv.build_server("127.0.0.1", 0, self.web, self.data, max_body_mb=self.max_body_mb, password=self.password,
                                       min_password_length=self.min_password_length)
        self.server.fail_delay = 0  # keep the suite fast; the delay itself is tested separately
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        self.thread.start()

    def tearDown(self):
        self.server.shutdown()
        self.server.server_close()
        self.tmp.cleanup()

    def call(self, method, path, body=None, headers=None, host=None):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        hdrs = dict(headers or {})
        if host:
            hdrs["Host"] = host
        payload = body
        if isinstance(body, (dict, list)):
            payload = json.dumps(body).encode("utf-8")
            hdrs.setdefault("Content-Type", "application/json")
        conn.request(method, path, body=payload, headers=hdrs)
        res = conn.getresponse()
        raw = res.read()
        conn.close()
        try:
            return res.status, json.loads(raw), res
        except ValueError:
            return res.status, raw, res


class ApiTests(ServerCase):
    def test_ping_and_empty_index(self):
        status, body, _ = self.call("GET", "/api/ping")
        self.assertEqual((status, body["ok"]), (200, True))
        status, body, _ = self.call("GET", "/api/index")
        self.assertEqual(body, {"listings": [], "deleted": []})

    def test_listing_without_a_location_is_stored_like_any_other(self):
        data = listing("u1", 1000, precision="unknown", address="")
        self.assertEqual(self.call("PUT", "/api/listings/u1", data)[0], 200)
        status, body, _ = self.call("GET", "/api/listings/u1")
        self.assertEqual((status, body["precision"]), (200, "unknown"))

    def test_put_get_roundtrip_and_index(self):
        status, body, _ = self.call("PUT", "/api/listings/a1", listing("a1", 1000, notes="ñandú ✓"))
        self.assertEqual((status, body["updatedAt"]), (200, 1000))
        status, body, res = self.call("GET", "/api/listings/a1")
        self.assertEqual(status, 200)
        self.assertEqual(body["notes"], "ñandú ✓")
        self.assertEqual(res.getheader("Cache-Control"), "no-store")
        _, index, _ = self.call("GET", "/api/index")
        self.assertEqual(index["listings"], [{"id": "a1", "updatedAt": 1000}])

    def test_missing_updated_at_is_filled_in(self):
        data = listing("a1")
        del data["updatedAt"]
        status, body, _ = self.call("PUT", "/api/listings/a1", data)
        self.assertEqual(status, 200)
        self.assertGreater(body["updatedAt"], 1_600_000_000_000)

    def test_unknown_listing_is_404(self):
        self.assertEqual(self.call("GET", "/api/listings/nope")[0], 404)
        self.assertEqual(self.call("GET", "/api/whatever")[0], 404)

    def test_validation(self):
        self.assertEqual(self.call("PUT", "/api/listings/a1", listing("other"))[0], 400)           # id mismatch
        self.assertEqual(self.call("PUT", "/api/listings/a1", listing("a1", lat="50.1"))[0], 400)    # lat as string
        self.assertEqual(self.call("PUT", "/api/listings/a1", listing("a1", lng=True))[0], 400)      # bool is not a number
        self.assertEqual(self.call("PUT", "/api/listings/a1", listing("a1", updatedAt="x"))[0], 400)
        self.assertEqual(self.call("PUT", "/api/listings/a1", [1, 2])[0], 400)
        self.assertEqual(self.call("PUT", "/api/listings/a1", b"{not json", {"Content-Type": "application/json"})[0], 400)
        self.assertEqual(self.call("PUT", "/api/listings/a1", b"{}", {"Content-Type": "text/plain"})[0], 415)

    def test_path_traversal_and_bad_ids_are_rejected(self):
        for bad in ("..", "..%2F..%2Fetc%2Fpasswd", "a.b", "a%20b", "x" * 81):
            self.assertEqual(self.call("PUT", f"/api/listings/{bad}", listing("a1"))[0], 404, bad)
            self.assertEqual(self.call("GET", f"/api/listings/{bad}")[0], 404, bad)
            self.assertEqual(self.call("DELETE", f"/api/listings/{bad}")[0], 404, bad)
        self.assertEqual([p.name for p in (self.data / "listings").iterdir()], [])

    def test_older_put_conflicts_equal_is_idempotent_newer_wins(self):
        self.call("PUT", "/api/listings/a1", listing("a1", 2000, title="nuevo"))
        status, body, _ = self.call("PUT", "/api/listings/a1", listing("a1", 1500, title="viejo"))
        self.assertEqual((status, body["updatedAt"]), (409, 2000))
        self.assertEqual(self.call("PUT", "/api/listings/a1", listing("a1", 2000, title="nuevo"))[0], 200)
        self.assertEqual(self.call("PUT", "/api/listings/a1", listing("a1", 3000, title="más nuevo"))[0], 200)
        self.assertEqual(self.call("GET", "/api/listings/a1")[1]["title"], "más nuevo")

    def test_delete_creates_tombstone_and_removes_listing(self):
        self.call("PUT", "/api/listings/a1", listing("a1", 1000))
        status, body, _ = self.call("DELETE", "/api/listings/a1?at=2000")
        self.assertEqual((status, body["deletedAt"]), (200, 2000))
        self.assertEqual(self.call("GET", "/api/listings/a1")[0], 404)
        _, index, _ = self.call("GET", "/api/index")
        self.assertEqual((index["listings"], index["deleted"]), ([], [{"id": "a1", "deletedAt": 2000}]))

    def test_delete_older_than_listing_conflicts(self):
        self.call("PUT", "/api/listings/a1", listing("a1", 5000))
        self.assertEqual(self.call("DELETE", "/api/listings/a1?at=4000")[0], 409)
        self.assertEqual(self.call("GET", "/api/listings/a1")[0], 200)
        self.assertEqual(self.call("DELETE", "/api/listings/a1?at=abc")[0], 400)

    def test_listing_newer_than_tombstone_clears_it(self):
        self.call("DELETE", "/api/listings/a1?at=2000")
        self.call("PUT", "/api/listings/a1", listing("a1", 3000))
        _, index, _ = self.call("GET", "/api/index")
        self.assertEqual((index["listings"], index["deleted"]), ([{"id": "a1", "updatedAt": 3000}], []))

    def test_delete_of_unknown_id_still_records_tombstone(self):
        self.assertEqual(self.call("DELETE", "/api/listings/ghost?at=10")[0], 200)
        self.assertEqual(self.call("GET", "/api/index")[1]["deleted"], [{"id": "ghost", "deletedAt": 10}])

    def test_unexpected_host_header_is_refused(self):
        self.assertEqual(self.call("GET", "/api/ping", host="evil.example.com")[0], 403)
        self.assertEqual(self.call("PUT", "/api/listings/a1", listing("a1"), host="evil.example.com")[0], 403)
        self.assertEqual(self.call("DELETE", "/api/listings/a1", host="evil.example.com")[0], 403)
        self.assertEqual(self.call("GET", "/api/ping", host=f"localhost:{self.port}")[0], 200)

    def test_other_methods_are_refused(self):
        self.assertEqual(self.call("POST", "/api/listings/a1", listing("a1"))[0], 405)
        self.assertEqual(self.call("HEAD", "/api/ping")[0], 405)

    def test_no_temp_files_left_behind(self):
        for i in range(5):
            self.call("PUT", f"/api/listings/id{i}", listing(f"id{i}", 100 + i))
        names = [p.name for p in (self.data / "listings").iterdir()]
        self.assertEqual(sorted(names), [f"id{i}.json" for i in range(5)])


class SmallBodyTests(ServerCase):
    max_body_mb = 1

    def test_oversized_body_is_rejected(self):
        big = listing("a1", notes="x" * (1024 * 1024 + 10))
        try:
            status, _, _ = self.call("PUT", "/api/listings/a1", big)
            self.assertEqual(status, 413)
        except (BrokenPipeError, ConnectionResetError):
            pass  # the server answered 413 and hung up before the client finished sending: also a refusal
        self.assertEqual(self.call("GET", "/api/listings/a1")[0], 404)


class StaticTests(ServerCase):
    def test_serves_the_app_and_sets_nosniff(self):
        status, body, res = self.call("GET", "/")
        self.assertEqual(status, 200)
        self.assertIn(b"<h1>mapa</h1>", body)
        self.assertEqual(res.getheader("X-Content-Type-Options"), "nosniff")
        self.assertEqual(res.getheader("Cache-Control"), "no-cache")

    def test_vendor_and_assets_are_cacheable_but_code_is_revalidated(self):
        (self.web / "vendor").mkdir()
        (self.web / "vendor" / "lib.js").write_text("x", encoding="utf-8")
        (self.web / "app.js").write_text("y", encoding="utf-8")
        self.assertEqual(self.call("GET", "/vendor/lib.js")[2].getheader("Cache-Control"), "public, max-age=86400")
        self.assertEqual(self.call("GET", "/app.js")[2].getheader("Cache-Control"), "no-cache")
        # an error under /vendor/ must not be cached for a day
        status, _, res = self.call("GET", "/vendor/missing.js")
        self.assertEqual((status, res.getheader("Cache-Control")), (404, "no-cache"))
        self.assertEqual(self.call("GET", "/api/ping")[2].getheader("Cache-Control"), "no-store")

    def test_index_carries_the_marker_the_client_looks_for(self):
        for path in ("/", "/index.html"):
            status, body, res = self.call("GET", path)
            self.assertEqual(status, 200)
            self.assertIn(b'<meta name="rentmap-server" content="1">', body)
            self.assertEqual(int(res.getheader("Content-Length")), len(body))
        status, _, res = self.call("HEAD", "/")
        self.assertEqual((status, res.getheader("Content-Type")), (200, "text/html; charset=utf-8"))

    def test_data_is_not_reachable_through_the_web_root(self):
        self.call("PUT", "/api/listings/a1", listing("a1"))
        self.assertEqual(self.call("GET", "/listings/a1.json")[0], 404)
        self.assertEqual(self.call("GET", "/../data/listings/a1.json")[0], 404)
        self.assertEqual(self.call("GET", "/%2e%2e/data/listings/a1.json")[0], 404)


def basic(user, password):
    token = base64.b64encode(f"{user}:{password}".encode("utf-8")).decode("ascii")
    return {"Authorization": f"Basic {token}"}


class PasswordTests(ServerCase):
    password = "correct horse"

    def assertDenied(self, method, path, body=None, headers=None):
        status, payload, res = self.call(method, path, body, headers)
        self.assertEqual(status, 401, f"{method} {path}")
        self.assertTrue(res.getheader("WWW-Authenticate", "").startswith("Basic realm="), f"{method} {path}")
        return payload

    def test_every_route_and_verb_needs_the_password(self):
        for method, path in [("GET", "/"), ("GET", "/index.html"), ("GET", "/missing.js"), ("GET", "/api/ping"),
                             ("GET", "/api/index"), ("GET", "/api/listings/a1"), ("HEAD", "/"), ("HEAD", "/api/ping"),
                             ("DELETE", "/api/listings/a1"), ("POST", "/api/ping"), ("PATCH", "/api/ping")]:
            self.assertDenied(method, path)
        self.assertDenied("PUT", "/api/listings/a1", listing("a1"))

    def test_denied_requests_have_no_side_effects_and_leak_nothing(self):
        payload = self.assertDenied("GET", "/")
        self.assertEqual(payload, {"error": "password required"})
        self.assertDenied("PUT", "/api/listings/a1", listing("a1", notes="secret"))
        self.assertDenied("DELETE", "/api/listings/a1?at=5")
        status, body, _ = self.call("GET", "/api/index", headers=basic("gr", self.password))
        self.assertEqual((status, body), (200, {"listings": [], "deleted": []}))

    def test_head_denial_has_no_body(self):
        conn = http.client.HTTPConnection("127.0.0.1", self.port, timeout=5)
        conn.request("HEAD", "/")
        res = conn.getresponse()
        self.assertEqual((res.status, res.read()), (401, b""))
        conn.close()

    def test_right_password_works_for_any_user_name(self):
        for user in ("gr", "", "otro usuario", "ñ"):
            status, body, _ = self.call("GET", "/api/ping", headers=basic(user, self.password))
            self.assertEqual((status, body["ok"]), (200, True), repr(user))
        status, page, _ = self.call("GET", "/", headers=basic("gr", self.password))
        self.assertEqual(status, 200)
        self.assertIn(b"mapa", page)
        self.assertIn(srv.INDEX_MARKER.encode(), page)

    def test_full_sync_cycle_behind_the_password(self):
        auth = basic("gr", self.password)
        self.assertEqual(self.call("PUT", "/api/listings/a1", listing("a1", 1000, notes="ñandú"), auth)[0], 200)
        status, body, _ = self.call("GET", "/api/listings/a1", headers=auth)
        self.assertEqual((status, body["notes"]), (200, "ñandú"))
        self.assertEqual(self.call("DELETE", "/api/listings/a1?at=2000", headers=auth)[0], 200)
        status, body, _ = self.call("GET", "/api/index", headers=auth)
        self.assertEqual(body, {"listings": [], "deleted": [{"id": "a1", "deletedAt": 2000}]})

    def test_wrong_or_malformed_credentials_are_refused(self):
        good = base64.b64encode(f"gr:{self.password}".encode()).decode()
        bad_headers = [
            basic("gr", "wrong password"),
            basic("gr", self.password + "x"),          # longer
            basic("gr", self.password[:-1]),           # prefix
            basic("gr", ""),
            basic(self.password, "wrong"),              # the password given as the user name
            {"Authorization": "Basic"},
            {"Authorization": "Basic "},
            {"Authorization": "Basic !!!not-base64!!!"},
            {"Authorization": "Basic " + base64.b64encode(self.password.encode()).decode()},  # no colon
            {"Authorization": "Basic " + base64.b64encode(b"gr:\xff\xfe").decode()},          # not UTF-8
            {"Authorization": "Bearer " + good},
            {"Authorization": good},
            {"Authorization": "Digest username=gr"},
        ]
        for headers in bad_headers:
            self.assertDenied("GET", "/api/ping", headers=headers)
            self.assertDenied("PUT", "/api/listings/a1", listing("a1"), headers)

    def test_scheme_name_is_case_insensitive(self):
        token = base64.b64encode(f"gr:{self.password}".encode()).decode()
        status, _, _ = self.call("GET", "/api/ping", headers={"Authorization": f"basic {token}"})
        self.assertEqual(status, 200)

    def test_host_check_still_applies_after_login(self):
        auth = basic("gr", self.password)
        status, _, _ = self.call("GET", "/api/ping", headers=auth, host="evil.example")
        self.assertEqual(status, 403)
        # and a wrong Host never gets past the password either
        self.assertDenied("GET", "/api/ping", headers={})

    def test_delay_only_after_a_wrong_password(self):
        self.server.fail_delay = 0.4
        started = time.monotonic()
        self.assertDenied("GET", "/api/ping")  # the browser's first try carries no credentials
        self.assertLess(time.monotonic() - started, 0.3)
        started = time.monotonic()
        self.assertDenied("GET", "/api/ping", headers=basic("gr", "wrong password"))
        self.assertGreaterEqual(time.monotonic() - started, 0.35)
        started = time.monotonic()
        self.assertEqual(self.call("GET", "/api/ping", headers=basic("gr", self.password))[0], 200)
        self.assertLess(time.monotonic() - started, 0.3)


class ShortPasswordTests(ServerCase):
    """A short password is allowed only on purpose, through min_password_length (RENTMAP_MIN_PASSWORD)."""
    password = "gr"
    min_password_length = 2

    def test_short_password_works_once_allowed(self):
        self.assertEqual(self.call("GET", "/api/ping")[0], 401)
        self.assertEqual(self.call("GET", "/api/ping", headers=basic("gr", "gr"))[0], 200)
        self.assertEqual(self.call("GET", "/api/ping", headers=basic("gr", "g"))[0], 401)
        self.assertEqual(self.call("GET", "/api/ping", headers=basic("gr", "grr"))[0], 401)


class FailureThrottleTests(ServerCase):
    password = "correct horse"

    def test_wrong_guesses_are_answered_one_at_a_time(self):
        self.server.fail_delay = 0.2
        results = []

        def guess(n):
            started = time.monotonic()
            status = self.call("GET", "/api/ping", headers=basic("gr", f"wrong-{n}"))[0]
            results.append((status, time.monotonic() - started))

        threads = [threading.Thread(target=guess, args=(n,)) for n in range(6)]
        started = time.monotonic()
        for t in threads:
            t.start()
        # while the failures queue up, the right password is not held back
        quick = time.monotonic()
        self.assertEqual(self.call("GET", "/api/ping", headers=basic("gr", self.password))[0], 200)
        self.assertLess(time.monotonic() - quick, 0.15)
        for t in threads:
            t.join()
        total = time.monotonic() - started
        self.assertEqual([r[0] for r in results], [401] * 6)
        # six parallel guesses at 0.2 s each take about 1.2 s in sequence (side by side they would take 0.2 s)
        self.assertGreaterEqual(total, 1.0)
        self.assertGreaterEqual(max(r[1] for r in results), 1.0)


class PasswordWithSymbolsTests(ServerCase):
    password = "pässwörd: con dos puntos ✓"

    def test_colon_and_non_ascii_password(self):
        self.assertEqual(self.call("GET", "/api/ping", headers=basic("gr", self.password))[0], 200)
        self.assertEqual(self.call("GET", "/api/ping", headers=basic("gr", "pässwörd"))[0], 401)
        self.assertEqual(self.call("GET", "/api/ping", headers=basic("gr", " con dos puntos ✓"))[0], 401)


class NoPasswordTests(ServerCase):
    def test_open_server_never_asks_for_credentials(self):
        status, _, res = self.call("GET", "/api/ping")
        self.assertEqual(status, 200)
        self.assertIsNone(res.getheader("WWW-Authenticate"))
        # credentials sent to an open server are simply ignored
        self.assertEqual(self.call("GET", "/api/ping", headers=basic("gr", "anything"))[0], 200)


class StoreAndStartupTests(unittest.TestCase):
    def test_refuses_all_interfaces_without_flag(self):
        with tempfile.TemporaryDirectory() as tmp:
            web = Path(tmp) / "web"
            web.mkdir()
            with self.assertRaises(SystemExit):
                srv.build_server("0.0.0.0", 0, web, Path(tmp) / "data")
            server = srv.build_server("0.0.0.0", 0, web, Path(tmp) / "data", allow_any_interface=True)
            server.server_close()

    def test_password_rules_at_startup(self):
        with tempfile.TemporaryDirectory() as tmp:
            web = Path(tmp) / "web"
            web.mkdir()
            data = Path(tmp) / "data"
            for bad in ("", "short", "1234567"):  # empty included: a failed env-file load must not leave it open
                with self.assertRaises(SystemExit, msg=repr(bad)):
                    srv.build_server("127.0.0.1", 0, web, data, password=bad)
            with self.assertRaises(SystemExit):
                srv.build_server("127.0.0.1", 0, web, data, require_password=True)
            with self.assertRaises(SystemExit):
                srv.build_server("127.0.0.1", 0, web, data, password="", require_password=True)
            for kwargs in ({"password": "12345678"}, {"password": "12345678", "require_password": True}, {}):
                server = srv.build_server("127.0.0.1", 0, web, data, **kwargs)
                self.assertEqual(server.password, kwargs["password"].encode() if "password" in kwargs else None)
                server.server_close()

    def test_minimum_password_length_can_be_lowered_on_purpose(self):
        with tempfile.TemporaryDirectory() as tmp:
            web = Path(tmp) / "web"
            web.mkdir()
            data = Path(tmp) / "data"
            with self.assertRaises(SystemExit):  # the default still refuses a short one
                srv.build_server("127.0.0.1", 0, web, data, password="gr")
            server = srv.build_server("127.0.0.1", 0, web, data, password="gr", min_password_length=2)
            self.assertEqual(server.password, b"gr")
            server.server_close()
            with self.assertRaises(SystemExit):  # lowered to 2, one character is still too short
                srv.build_server("127.0.0.1", 0, web, data, password="g", min_password_length=2)
            for empty_ok_attempt in (1, 2):  # empty is never accepted, whatever the minimum
                with self.assertRaises(SystemExit):
                    srv.build_server("127.0.0.1", 0, web, data, password="", min_password_length=empty_ok_attempt)
            for bad in (0, -1, "2", None, 1.5):
                with self.assertRaises(SystemExit, msg=repr(bad)):
                    srv.build_server("127.0.0.1", 0, web, data, password="gr", min_password_length=bad)

    def test_min_password_setting_is_read_strictly(self):
        self.assertEqual(srv.min_password_from_env(None), srv.MIN_PASSWORD_LENGTH)
        self.assertEqual(srv.min_password_from_env(""), srv.MIN_PASSWORD_LENGTH)
        self.assertEqual(srv.min_password_from_env("  "), srv.MIN_PASSWORD_LENGTH)
        self.assertEqual(srv.min_password_from_env(" 2 "), 2)
        for bad in ("abc", "2.5", "two"):
            with self.assertRaises(SystemExit, msg=bad):
                srv.min_password_from_env(bad)

    def test_refuses_data_inside_web_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            web = Path(tmp) / "web"
            web.mkdir()
            with self.assertRaises(SystemExit):
                srv.build_server("127.0.0.1", 0, web, web / "data")
            with self.assertRaises(SystemExit):
                srv.build_server("127.0.0.1", 0, web, web)

    def test_state_survives_restart(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = srv.Store(tmp)
            store.put("a1", listing("a1", 1000))
            store.put("a2", listing("a2", 2000))
            store.delete("a2", 3000)
            again = srv.Store(tmp)
            self.assertEqual(again.index, {"a1": 1000})
            self.assertEqual(again.deleted, {"a2": 3000})

    def test_corrupt_file_is_skipped_not_fatal(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = srv.Store(tmp)
            store.put("a1", listing("a1", 1000))
            (Path(tmp) / "listings" / "broken.json").write_text("{oops", encoding="utf-8")
            self.assertEqual(srv.Store(tmp).index, {"a1": 1000})

    def test_daily_backup_is_written_once_and_old_ones_pruned(self):
        with tempfile.TemporaryDirectory() as tmp:
            store = srv.Store(tmp)
            self.assertIsNone(store.backup_if_needed())          # nothing to back up yet
            store.put("a1", listing("a1", 1000))
            old = store.backups_dir / "2000-01-01"
            old.mkdir()
            made = store.backup_if_needed()
            self.assertEqual(made.name, date.today().isoformat())
            self.assertTrue((made / "listings" / "a1.json").exists())
            self.assertIsNone(store.backup_if_needed())          # only once a day
            self.assertFalse(old.exists())                       # pruned


if __name__ == "__main__":
    unittest.main()
