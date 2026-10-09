// Turns the place hints found in a post into map coordinates.
// 1) Nominatim (OpenStreetMap) is asked, from most to least specific.
// 2) If that fails (offline, rate-limited, no match) an offline table of Prague
//    neighbourhoods (and a few towns just outside) gives an approximate position, flagged as such.
// 3) If nothing is recognised, locate() returns null: the listing can still be saved, as
//    «unknown» (see UNLOCATED), and it is never drawn or measured as if it were in the centre.

import { norm } from './parse.js';

export const CENTER = { lat: 50.0875, lng: 14.4213, label: 'Staroměstské nám.' };

// A listing whose post gave no usable location. The server needs numeric lat/lng, so these hold
// the centre only to fill the field; precision 'unknown' means: not on the map, no distances.
export const UNLOCATED = { lat: CENTER.lat, lng: CENTER.lng, precision: 'unknown' };
export const isLocated = (listing) => listing.precision !== 'unknown';
const VIEWBOX = '14.22,50.18,14.71,49.94'; // left,top,right,bottom around Prague
const AREA_TYPES = new Set(['suburb', 'neighbourhood', 'quarter', 'city_district', 'district', 'borough', 'city', 'town', 'village', 'municipality', 'state', 'county', 'region', 'postcode']);
const STREET_TYPES = new Set(['road', 'highway', 'footway', 'pedestrian', 'path', 'residential', 'street']);

// [display name, normalized stems (word-start match), lat, lng] — approximate centroids.
const PLACES = [
  ['Staré Město', ['stare mesto', 'old town', 'staromest'], 50.0880, 14.4210],
  ['Nové Město', ['nove mesto', 'new town'], 50.0790, 14.4250],
  ['Malá Strana', ['mala strana', 'lesser town'], 50.0880, 14.4030],
  ['Hradčany', ['hradcan'], 50.0910, 14.3990],
  ['Vyšehrad', ['vysehrad'], 50.0640, 14.4180],
  ['Vinohrady', ['vinohrad'], 50.0770, 14.4500],
  ['Žižkov', ['zizk'], 50.0850, 14.4620],
  ['Anděl', ['andel'], 50.0709, 14.4035],
  ['Smíchov', ['smichov'], 50.0690, 14.4030],
  ['Karlín', ['karlin'], 50.0930, 14.4500],
  ['Florenc', ['florenc'], 50.0905, 14.4390],
  ['Holešovice', ['holesovic'], 50.1020, 14.4400],
  ['Letná', ['letn'], 50.0960, 14.4220],
  ['Bubeneč', ['bubenec'], 50.1030, 14.4100],
  ['Dejvice', ['dejvic'], 50.1010, 14.3920],
  ['Střešovice', ['stresovic'], 50.0990, 14.3720],
  ['Břevnov', ['brevnov'], 50.0860, 14.3600],
  ['Vokovice', ['vokovic'], 50.1000, 14.3500],
  ['Veleslavín', ['veleslavin'], 50.0970, 14.3490],
  ['Košíře', ['kosir'], 50.0720, 14.3770],
  ['Motol', ['motol'], 50.0750, 14.3400],
  ['Radlice', ['radlic'], 50.0570, 14.3880],
  ['Jinonice', ['jinonic'], 50.0510, 14.3780],
  ['Nové Butovice', ['butovic'], 50.0490, 14.3500],
  ['Stodůlky', ['stodulk'], 50.0480, 14.3330],
  ['Hlubočepy', ['hlubocep'], 50.0330, 14.3860],
  ['Barrandov', ['barrandov'], 50.0340, 14.3720],
  ['Zličín', ['zlicin'], 50.0540, 14.2900],
  ['Řepy', ['repy'], 50.0770, 14.3160],
  ['Nusle', ['nusl'], 50.0580, 14.4350],
  ['Pankrác', ['pankrac'], 50.0520, 14.4400],
  ['Michle', ['michle'], 50.0560, 14.4520],
  ['Krč', ['krc'], 50.0390, 14.4450],
  ['Braník', ['branik'], 50.0190, 14.4140],
  ['Modřany', ['modran'], 50.0050, 14.4170],
  ['Chodov', ['chodov'], 50.0310, 14.4900],
  ['Háje', ['haje'], 50.0310, 14.5260],
  ['Vršovice', ['vrsovic'], 50.0670, 14.4540],
  ['Strašnice', ['strasnic'], 50.0720, 14.4900],
  ['Malešice', ['malesic'], 50.0830, 14.5050],
  ['Záběhlice', ['zabehlic'], 50.0510, 14.4850],
  ['Hostivař', ['hostivar'], 50.0600, 14.5400],
  ['Libeň', ['liben', 'libni'], 50.1070, 14.4690],
  ['Vysočany', ['vysocan'], 50.1100, 14.5010],
  ['Prosek', ['prosek'], 50.1230, 14.5050],
  ['Kobylisy', ['kobylis'], 50.1260, 14.4650],
  ['Bohnice', ['bohnic'], 50.1290, 14.4150],
  ['Troja', ['troj'], 50.1150, 14.4170],
  ['Letňany', ['letnan'], 50.1280, 14.5140],
  ['Černý Most', ['cerny most'], 50.1090, 14.5760],
  ['Radotín', ['radotin'], 49.9900, 14.3600],
  ['Uhříněves', ['uhrineves'], 50.0300, 14.5970],
  ['Zbraslav', ['zbraslav'], 49.9733, 14.3922],
  // just outside Prague (okres Praha-západ / Praha-východ), often advertised as «near Prague»
  ['Hostivice', ['hostivic'], 50.0803, 14.2578],
  ['Černošice', ['cernosic'], 49.9617, 14.3200],
  ['Jesenice', ['jesenic'], 49.9644, 14.5106],
  ['Říčany', ['ricany'], 49.9917, 14.6567],
  ['Průhonice', ['pruhonic'], 49.9967, 14.5547],
  ['Roztoky', ['roztok'], 50.1594, 14.4025],
  ['náměstí Míru', ['namesti miru'], 50.0753, 14.4378],
  ['Václavské náměstí', ['vaclavske nam', 'wenceslas sq'], 50.0810, 14.4270],
  ['Karlovo náměstí', ['karlovo nam'], 50.0756, 14.4175],
];

const DISTRICTS = {
  1: [50.0875, 14.4210], 2: [50.0720, 14.4400], 3: [50.0830, 14.4600], 4: [50.0400, 14.4400], 5: [50.0650, 14.3800],
  6: [50.1000, 14.3700], 7: [50.1000, 14.4300], 8: [50.1200, 14.4600], 9: [50.1150, 14.5100], 10: [50.0700, 14.4900],
  11: [50.0310, 14.4950], 12: [50.0050, 14.4170], 13: [50.0480, 14.3330], 14: [50.1090, 14.5700], 15: [50.0600, 14.5400],
  16: [49.9900, 14.3600], 17: [50.0770, 14.3160], 18: [50.1280, 14.5140], 19: [50.1260, 14.5380], 20: [50.1070, 14.5920],
  21: [50.0820, 14.6590], 22: [50.0300, 14.5970],
};

const STEMS = PLACES.flatMap(([name, stems, lat, lng]) => stems.map((s) => ({ name, stem: s, lat, lng })))
  .sort((a, b) => b.stem.length - a.stem.length);

export function findPlace(text) {
  const n = ` ${norm(text)}`;
  for (const p of STEMS) {
    const i = n.search(new RegExp(`[^a-z]${p.stem}`));
    if (i >= 0) return { name: p.name, lat: p.lat, lng: p.lng };
  }
  return null;
}

export function districtCenter(label) {
  const m = /(\d{1,2})/.exec(label || '');
  const c = m && DISTRICTS[Number(m[1])];
  return c ? { name: `Praha ${m[1]}`, lat: c[0], lng: c[1] } : null;
}

export function offlineFallback({ text = '', district = '' }) {
  const place = findPlace(text);
  if (place) return { ...place, precision: 'area', source: 'table' };
  const d = districtCenter(district);
  if (d) return { ...d, precision: 'area', source: 'table' };
  return null;
}

export function buildQueries({ address = '', street = '', metro = '', place = '', district = '' }) {
  const withCity = (q) => (/praha|prague|praga/i.test(q) ? q : `${q}, Praha`);
  const queries = [];
  const add = (q) => { if (q && !queries.includes(q)) queries.push(q); };
  if (address.trim()) add(withCity(address.trim()));
  if (street) {
    add(withCity([street, place].filter(Boolean).join(', ')));
    add(withCity(street));
  }
  if (metro) add(`${metro} (metro), Praha`);
  if (place) add(withCity(place));
  if (district) add(`${district}, Praha`);
  return queries.slice(0, 4);
}

const cache = new Map();
let lastCall = 0;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function nominatim(q, signal) {
  if (cache.has(q)) return cache.get(q);
  const wait = lastCall + 1100 - Date.now(); // Nominatim usage policy: max 1 request/second
  if (wait > 0) await sleep(wait);
  lastCall = Date.now();
  const url = `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=1&countrycodes=cz&bounded=1&viewbox=${VIEWBOX}&accept-language=cs&q=${encodeURIComponent(q)}`;
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Nominatim ${res.status}`);
  const rows = await res.json();
  const hit = rows[0]
    ? { lat: Number(rows[0].lat), lng: Number(rows[0].lon), type: rows[0].addresstype || rows[0].type, label: rows[0].display_name }
    : null;
  cache.set(q, hit);
  return hit;
}

function precisionOf(type) {
  if (AREA_TYPES.has(type)) return 'area';
  if (STREET_TYPES.has(type)) return 'street';
  return 'exact';
}

export async function locate(hints, { signal, onTry } = {}) {
  const queries = buildQueries(hints);
  for (const q of queries) {
    onTry?.(q);
    try {
      const hit = await nominatim(q, signal);
      if (hit) return { lat: hit.lat, lng: hit.lng, precision: precisionOf(hit.type), source: 'nominatim', query: q, label: hit.label };
    } catch (err) {
      if (err.name === 'AbortError') throw err;
      break; // network problem: go straight to the offline table
    }
  }
  const text = [hints.place, hints.street, hints.address, hints.metro].filter(Boolean).join(' ');
  return offlineFallback({ text, district: hints.district });
}

export function distanceKm(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}
