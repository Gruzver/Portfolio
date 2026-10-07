// Listings live in IndexedDB (photos are stored inline as data URLs), so they survive
// reloads without any server. Falls back to memory if the browser blocks IndexedDB.

const DB_NAME = 'prague-rent-map';
const STORE = 'listings';

let dbPromise = null;
const memory = new Map();
export let persistent = true;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDB no disponible'));
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE, { keyPath: 'id' });
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    }).catch((err) => {
      persistent = false;
      console.warn('Sin almacenamiento persistente:', err);
      return null;
    });
  }
  return dbPromise;
}

const wrap = (req) => new Promise((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

export async function loadAll() {
  const db = await open();
  if (!db) return [...memory.values()];
  return wrap(db.transaction(STORE).objectStore(STORE).getAll());
}

export async function save(listing) {
  const db = await open();
  if (!db) { memory.set(listing.id, listing); return; }
  await wrap(db.transaction(STORE, 'readwrite').objectStore(STORE).put(listing));
}

export async function remove(id) {
  const db = await open();
  if (!db) { memory.delete(id); return; }
  await wrap(db.transaction(STORE, 'readwrite').objectStore(STORE).delete(id));
}
