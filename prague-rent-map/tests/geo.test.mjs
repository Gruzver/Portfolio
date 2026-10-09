import test from 'node:test';
import assert from 'node:assert/strict';
import { parseListing } from '../js/parse.js';
import { CENTER, UNLOCATED, findPlace, isLocated, offlineFallback, distanceKm } from '../js/geo.js';
import { distancesTo } from '../js/places.js';

test('towns just outside Prague are recognised from the post text', () => {
  const cases = [
    ['Pronájem bytu 2+kk, Hostivice, Praha-západ, 15 000 Kč', 'Hostivice'],
    ['Room in Černošice near Prague, 9 000 CZK', 'Černošice'],
    ['byt Jesenice u Prahy', 'Jesenice'],
    ['Říčany - Praha východ, 3+1', 'Říčany'],
    ['Průhonice, 2kk', 'Průhonice'],
    ['Zbraslav 1+kk', 'Zbraslav'],
  ];
  for (const [text, name] of cases) {
    const p = findPlace(text);
    assert.equal(p?.name, name, text);
    assert.ok(distanceKm(p, CENTER) < 25, `${name} should be within 25 km of the centre`);
  }
  // the table answers offline, flagged as approximate
  const r = offlineFallback({ text: 'Hostivice, Praha-západ', district: '' });
  assert.deepEqual([r.name, r.precision, r.source], ['Hostivice', 'area', 'table']);
});

test('existing neighbourhoods are not stolen by the new town names', () => {
  assert.equal(findPlace('Hostivař, Praha 15')?.name, 'Hostivař');
  assert.equal(findPlace('na Žižkově')?.name, 'Žižkov');
  assert.equal(findPlace('Vinohradská 125')?.name, 'Vinohrady');
});

test('a post that names no location stays unlocated (nothing invented)', () => {
  const text = 'Byt k pronájmu, 20 000 Kč měsíčně, volné od ledna.\nKontakt přes zprávu.';
  const p = parseListing(text);
  assert.equal(p.district, '');
  assert.equal(offlineFallback({ text, district: p.district }), null);
});

test('the unlocated marker keeps numeric coordinates but is never treated as a place', () => {
  assert.equal(typeof UNLOCATED.lat, 'number');
  assert.equal(typeof UNLOCATED.lng, 'number');
  assert.equal(UNLOCATED.precision, 'unknown');
  assert.equal(isLocated(UNLOCATED), false);
  for (const precision of ['exact', 'street', 'area', 'manual', undefined]) {
    assert.equal(isLocated({ lat: 50, lng: 14, precision }), true, String(precision));
  }
  assert.deepEqual(distancesTo({ ...UNLOCATED }), []);
  const located = distancesTo({ lat: 50.0875, lng: 14.4213, precision: 'area' });
  assert.deepEqual(located.map((d) => d.id), ['f4f', 'mrs']);
  assert.ok(located.every((d) => d.km > 0 && d.km < 2));
});
