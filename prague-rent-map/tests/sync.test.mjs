import test from 'node:test';
import assert from 'node:assert/strict';
import { planSync, stamp } from '../js/sync.js';

const plan = (o) => planSync({ local: [], localTombs: [], remote: [], remoteTombs: [], ...o });
const L = (id, updatedAt) => ({ id, updatedAt });
const T = (id, deletedAt) => ({ id, deletedAt });

test('new on one side is copied to the other', () => {
  const p = plan({ local: [L('a', 10)], remote: [L('b', 20)] });
  assert.deepEqual(p.push, ['a']);
  assert.deepEqual(p.pull, ['b']);
  assert.deepEqual([p.deleteLocal, p.deleteRemote, p.tombLocal], [[], [], []]);
});

test('the newer edit wins in either direction, equal does nothing', () => {
  const p = plan({ local: [L('a', 30), L('b', 10), L('c', 5)], remote: [L('a', 20), L('b', 40), L('c', 5)] });
  assert.deepEqual(p.push, ['a']);
  assert.deepEqual(p.pull, ['b']);
});

test('a remote deletion removes the older local copy and remembers the tombstone', () => {
  const p = plan({ local: [L('a', 10)], remoteTombs: [T('a', 20)] });
  assert.deepEqual(p.deleteLocal, [{ id: 'a', at: 20 }]);
  assert.deepEqual(p.push, []);
  assert.deepEqual(p.deleteRemote, []);          // the server already knows
});

test('a local deletion is sent to the server and removes the remote copy', () => {
  const p = plan({ remote: [L('a', 10)], localTombs: [T('a', 20)] });
  assert.deepEqual(p.deleteRemote, [{ id: 'a', at: 20 }]);
  assert.deepEqual(p.pull, []);
});

test('an edit made after a deletion brings the listing back', () => {
  const pushed = plan({ local: [L('a', 30)], remoteTombs: [T('a', 20)] });
  assert.deepEqual(pushed.push, ['a']);
  assert.deepEqual(pushed.deleteLocal, []);
  const pulled = plan({ localTombs: [T('a', 20)], remote: [L('a', 30)] });
  assert.deepEqual(pulled.pull, ['a']);
  assert.deepEqual(pulled.deleteRemote, []);
});

test('a tie between an edit and a deletion goes to the deletion', () => {
  const p = plan({ local: [L('a', 20)], remoteTombs: [T('a', 20)] });
  assert.deepEqual(p.deleteLocal, [{ id: 'a', at: 20 }]);
});

test('a tombstone only on one side is propagated to the other', () => {
  const toServer = plan({ localTombs: [T('a', 20)] });
  assert.deepEqual(toServer.deleteRemote, [{ id: 'a', at: 20 }]);
  const toLocal = plan({ remoteTombs: [T('a', 20)] });
  assert.deepEqual(toLocal.tombLocal, [{ id: 'a', deletedAt: 20 }]);
  assert.deepEqual(toLocal.deleteRemote, []);
});

test('already-synced state is a no-op', () => {
  const p = plan({ local: [L('a', 10)], remote: [L('a', 10)], localTombs: [T('x', 5)], remoteTombs: [T('x', 5)] });
  assert.deepEqual(p, { push: [], pull: [], deleteLocal: [], deleteRemote: [], tombLocal: [] });
});

test('stamp falls back to createdAt and then 0', () => {
  assert.equal(stamp({ updatedAt: 5, createdAt: 1 }), 5);
  assert.equal(stamp({ createdAt: 1 }), 1);
  assert.equal(stamp({}), 0);
});
