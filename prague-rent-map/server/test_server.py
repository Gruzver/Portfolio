"""Tests for server.py. Run with:  python3 -m unittest discover -s server -v"""

import http.client
import json
import tempfile
import threading
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

    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        base = Path(self.tmp.name)
        self.web = base / "web"
        self.web.mkdir()
        (self.web / "index.html").write_text("<html><head><title>t</title></head><body><h1>mapa</h1></body></html>", encoding="utf-8")
        self.data = base / "data"
        self.server = srv.build_server("127.0.0.1", 0, self.web, self.data, max_body_mb=self.max_body_mb)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
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


class StoreAndStartupTests(unittest.TestCase):
    def test_refuses_all_interfaces_without_flag(self):
        with tempfile.TemporaryDirectory() as tmp:
            web = Path(tmp) / "web"
            web.mkdir()
            with self.assertRaises(SystemExit):
                srv.build_server("0.0.0.0", 0, web, Path(tmp) / "data")
            server = srv.build_server("0.0.0.0", 0, web, Path(tmp) / "data", allow_any_interface=True)
            server.server_close()

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
