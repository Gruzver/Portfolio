// Listings live in IndexedDB (photos are stored inline as data URLs), so they survive
// reloads without any server. Falls back to memory if the browser blocks IndexedDB.
// Deletions leave a small "tombstone" so a sync can tell "deleted" from "never had it".

const DB_NAME = 'prague-rent-map';
const LISTINGS = 'listings';
const TOMBS = 'tombstones';

let dbPromise = null;
const memory = new Map();
const memoryTombs = new Map();
export let persistent = true;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (!('indexedDB' in window)) return reject(new Error('IndexedDB no disponible'));
      const req = indexedDB.open(DB_NAME, 2);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains(LISTINGS)) db.createObjectStore(LISTINGS, { keyPath: 'id' });
        if (!db.objectStoreNames.contains(TOMBS)) db.createObjectStore(TOMBS, { keyPath: 'id' });
      };
      req.onsuccess = () => {
        // let a future upgrade proceed even if this tab is still open
        req.result.onversionchange = () => req.result.close();
        resolve(req.result);
      };
      req.onerror = () => reject(req.error);
      req.onblocked = () => console.warn('Cierra las otras pestañas de esta web para terminar la actualización de datos.');
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

const done = (tx) => new Promise((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error);
});

export async function loadAll() {
  const db = await open();
  if (!db) return [...memory.values()];
  return wrap(db.transaction(LISTINGS).objectStore(LISTINGS).getAll());
}

export async function loadTombstones() {
  const db = await open();
  if (!db) return [...memoryTombs.values()];
  return wrap(db.transaction(TOMBS).objectStore(TOMBS).getAll());
}

// Saving a listing also removes any older tombstone for it (it is alive again).
export async function save(listing) {
  const db = await open();
  if (!db) {
    memory.set(listing.id, listing);
    memoryTombs.delete(listing.id);
    return;
  }
  const tx = db.transaction([LISTINGS, TOMBS], 'readwrite');
  tx.objectStore(LISTINGS).put(listing);
  tx.objectStore(TOMBS).delete(listing.id);
  await done(tx);
}

export async function remove(id, at = Date.now()) {
  const db = await open();
  if (!db) {
    memory.delete(id);
    memoryTombs.set(id, { id, deletedAt: at });
    return;
  }
  const tx = db.transaction([LISTINGS, TOMBS], 'readwrite');
  tx.objectStore(LISTINGS).delete(id);
  tx.objectStore(TOMBS).put({ id, deletedAt: at });
  await done(tx);
}

export async function saveTombstone(tomb) {
  const db = await open();
  if (!db) { memoryTombs.set(tomb.id, tomb); return; }
  const tx = db.transaction(TOMBS, 'readwrite');
  tx.objectStore(TOMBS).put(tomb);
  await done(tx);
}
