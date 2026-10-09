// Fixed places of interest (the workplaces) drawn on the map and used for distances.
// Positions are approximate until Nominatim confirms them; a confirmed position is
// cached in localStorage and only accepted if it lands close to the built-in one.

import { distanceKm, isLocated, locate } from './geo.js';

export const POIS = [
  {
    id: 'f4f',
    short: 'F4F',
    name: 'Fly4Future',
    address: 'Lazarská 13/8, Nové Město, 120 00 Praha 2',
    queries: ['Lazarská 13/8, Praha', 'Lazarská 13, Praha'],
    lat: 50.0790,
    lng: 14.4192,
  },
  {
    id: 'mrs',
    short: 'MRS',
    name: 'MRS',
    address: 'Karlovo nám. 13, 120 00 Nové Město',
    queries: ['Karlovo náměstí 13, Praha', 'Karlovo náměstí, Praha'],
    lat: 50.0756,
    lng: 14.4178,
  },
];

const CACHE_KEY = 'prm.pois.v1';
const TRIED_KEY = 'prm.pois.tried';
const MAX_SHIFT_KM = 0.7;

const readCache = () => {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; } catch { return {}; }
};

export function applyCachedPois() {
  const cache = readCache();
  for (const p of POIS) {
    if (cache[p.id]) { p.lat = cache[p.id].lat; p.lng = cache[p.id].lng; }
  }
}

// Asks Nominatim for the exact spot, once per browser. Returns true if any position moved.
export async function refinePois() {
  try {
    if (sessionStorage.getItem(TRIED_KEY)) return false;
    sessionStorage.setItem(TRIED_KEY, '1');
  } catch { /* storage blocked: just try */ }
  const cache = readCache();
  let changed = false;
  for (const p of POIS) {
    if (cache[p.id]) continue;
    for (const q of p.queries) {
      try {
        const r = await locate({ address: q });
        if (r && r.source === 'nominatim' && r.precision !== 'area' && distanceKm(r, p) <= MAX_SHIFT_KM) {
          p.lat = r.lat;
          p.lng = r.lng;
          cache[p.id] = { lat: r.lat, lng: r.lng };
          changed = true;
          break;
        }
      } catch { /* offline: keep the built-in position */ }
    }
  }
  if (changed) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify(cache)); } catch { /* ignore */ }
  }
  return changed;
}

export const distancesTo = (point) => (isLocated(point) ? POIS.map((p) => ({ id: p.id, short: p.short, km: distanceKm(point, p) })) : []);

export const fmtKm = (km) => `${km.toFixed(1).replace('.', ',')} km`;
