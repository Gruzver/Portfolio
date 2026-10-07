// Optional sync with the rent-map server (server/server.py). When the app is opened from
// that server, every device sees the same listings; anywhere else (GitHub Pages, a plain
// static server) the ping fails and the app simply stays local.
//
// Merge rule, per listing: the newest change wins (updatedAt for edits, deletedAt for
// deletions; a tie goes to the deletion). Local data is always kept, so the app keeps
// working offline and catches up on the next successful sync.

export const stamp = (listing) => Number(listing.updatedAt) || Number(listing.createdAt) || 0;

// Pure: decides what to copy where. Inputs are [{id, updatedAt}] / [{id, deletedAt}] lists.
export function planSync({ local, localTombs, remote, remoteTombs }) {
  const L = new Map(local.map((x) => [x.id, x.updatedAt]));
  const R = new Map(remote.map((x) => [x.id, x.updatedAt]));
  const LT = new Map(localTombs.map((x) => [x.id, x.deletedAt]));
  const RT = new Map(remoteTombs.map((x) => [x.id, x.deletedAt]));
  const plan = { push: [], pull: [], deleteLocal: [], deleteRemote: [], tombLocal: [] };

  for (const id of new Set([...L.keys(), ...R.keys(), ...LT.keys(), ...RT.keys()])) {
    const lu = L.get(id);
    const ru = R.get(id);
    const lt = LT.get(id);
    const rt = RT.get(id);
    const alive = Math.max(lu ?? -1, ru ?? -1);
    const dead = Math.max(lt ?? -1, rt ?? -1);

    if (dead >= 0 && dead >= alive) {
      if (lu !== undefined) plan.deleteLocal.push({ id, at: dead });
      if (ru !== undefined || rt === undefined || rt < dead) plan.deleteRemote.push({ id, at: dead });
      if (lu === undefined && (lt === undefined || lt < dead)) plan.tombLocal.push({ id, deletedAt: dead });
    } else if (alive >= 0) {
      if (lu === undefined || (ru !== undefined && ru > lu)) plan.pull.push(id);
      else if (ru === undefined || lu > ru) plan.push.push(id);
    }
  }
  return plan;
}

const TIMEOUT_MS = 20000;

// Private network (ZeroTier, LAN, localhost): poll every 30 s as before. Anything else is the
// internet through a tunnel whose free plan counts requests, so poll every 5 minutes and let
// a tab/focus event trigger at most one sync a minute. Edits are still pushed right away.
export function isPrivateHost(hostname) {
  const h = String(hostname).replace(/^\[|\]$/g, '').toLowerCase();
  if (h === 'localhost' || h === '::1' || h.endsWith('.local')) return true;
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const [a, b] = [Number(m[1]), Number(m[2])];
  return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
}

export const pollTiming = (hostname) => (isPrivateHost(hostname)
  ? { pollMs: 30000, minGapMs: 0 }
  : { pollMs: 300000, minGapMs: 60000 });

export function createSync({ db, onChange = () => {}, onStatus = () => {}, fetchFn = (...args) => fetch(...args) }) {
  const url = (path) => new URL(`api/${path}`, document.baseURI).href;
  let mode = 'unknown'; // 'server' | 'none' | 'unreachable'
  let running = false;
  let again = false;
  let timer = null;
  let interval = null;
  let lastSync = 0;
  let lastStart = 0;

  async function request(path, options = {}, timeout = TIMEOUT_MS) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeout);
    try {
      return await fetchFn(url(path), { ...options, signal: ac.signal, cache: 'no-store' });
    } finally {
      clearTimeout(t);
    }
  }

  const status = (state, extra = {}) => onStatus({ state, lastSync, ...extra });

  async function detect() {
    // only the rent-map server adds this marker to index.html: on a static host (GitHub Pages)
    // there is nothing to probe, so skip the request instead of logging a 404
    if (!document.querySelector('meta[name="rentmap-server"]')) return 'none';
    try {
      const res = await request('ping', {}, 3000);
      if (!res.ok) return 'none'; // a static host answers 404: there is no server here
      const body = await res.json();
      return body && body.app === 'prague-rent-map-server' ? 'server' : 'none';
    } catch (err) {
      return err instanceof SyntaxError ? 'none' : 'unreachable';
    }
  }

  async function pass() {
    const res = await request('index');
    if (!res.ok) throw new Error(`index ${res.status}`);
    const remote = await res.json();
    const all = await db.loadAll();
    const plan = planSync({
      local: all.map((l) => ({ id: l.id, updatedAt: stamp(l) })),
      localTombs: await db.loadTombstones(),
      remote: remote.listings || [],
      remoteTombs: remote.deleted || [],
    });
    let changed = false;

    for (const id of plan.pull) {
      const r = await request(`listings/${encodeURIComponent(id)}`);
      if (r.status === 404) continue;
      if (!r.ok) throw new Error(`pull ${r.status}`);
      await db.save(await r.json());
      changed = true;
    }
    for (const { id, at } of plan.deleteLocal) {
      await db.remove(id, at);
      changed = true;
    }
    for (const tomb of plan.tombLocal) await db.saveTombstone(tomb);

    for (const id of plan.push) {
      const listing = all.find((l) => l.id === id);
      if (!listing) continue;
      if (!listing.updatedAt) { listing.updatedAt = stamp(listing) || Date.now(); await db.save(listing); }
      const r = await request(`listings/${encodeURIComponent(id)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(listing),
      });
      if (r.status === 409) { again = true; continue; } // the server has a newer one: the next pass pulls it
      if (!r.ok) throw new Error(`push ${r.status}`);
    }
    for (const { id, at } of plan.deleteRemote) {
      const r = await request(`listings/${encodeURIComponent(id)}?at=${at}`, { method: 'DELETE' });
      if (r.status === 409) { again = true; continue; }
      if (!r.ok) throw new Error(`delete ${r.status}`);
    }
    if (changed) await onChange();
  }

  async function syncNow() {
    if (mode === 'none') return;
    if (running) { again = true; return; }
    running = true;
    lastStart = Date.now();
    status('syncing');
    try {
      if (mode !== 'server') {
        mode = await detect();
        if (mode === 'none') { status('disabled'); return; }
        if (mode === 'unreachable') { status('offline'); return; }
      }
      let guard = 0;
      do {
        again = false;
        await pass();
        guard += 1;
      } while (again && guard < 3);
      lastSync = Date.now();
      status('ok');
    } catch (err) {
      console.warn('sync:', err);
      if (mode === 'server') status('offline', { error: String(err.message || err) });
      else { mode = 'unknown'; status('offline'); }
    } finally {
      running = false;
    }
  }

  return {
    syncNow,
    // after a local change: wait a moment so several quick edits go out together
    schedule() {
      if (mode === 'none') return;
      clearTimeout(timer);
      timer = setTimeout(syncNow, 600);
    },
    async start() {
      await syncNow();
      if (mode === 'none') return;
      const { pollMs, minGapMs } = pollTiming(location.hostname);
      const tick = () => {
        if (document.visibilityState !== 'visible' || Date.now() - lastStart < minGapMs) return;
        syncNow();
      };
      interval = setInterval(tick, pollMs);
      document.addEventListener('visibilitychange', tick);
      window.addEventListener('focus', tick);
      window.addEventListener('online', syncNow);
    },
    stop() { clearInterval(interval); clearTimeout(timer); },
    get mode() { return mode; },
  };
}
