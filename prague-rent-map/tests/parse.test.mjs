import test from 'node:test';
import assert from 'node:assert/strict';
import { parseListing, findPrices } from '../js/parse.js';
import { findPlace, buildQueries, districtCenter, offlineFallback } from '../js/geo.js';

test('Czech post: price, deposit, fees, layout, size, street, district', () => {
  const p = parseListing(`Pronájem bytu 2+kk, 55 m², Praha 2 - Vinohrady
Vinohradská 125
Nájemné: 24 500 Kč měsíčně + 3 000 Kč poplatky
Kauce: 49 000 Kč
Volné od 1.11.2026
Minimálně 6 měsíců. Zvířata ne. Bez provize.
Zařízený byt.`);
  assert.equal(p.price, 24500);
  assert.equal(p.currency, 'CZK');
  assert.equal(p.deposit, 49000);
  assert.equal(p.fees, 3000);
  assert.equal(p.layout, '2+kk');
  assert.equal(p.size, 55);
  assert.equal(p.street, 'Vinohradská 125');
  assert.equal(p.district, 'Praha 2');
  assert.equal(p.minMonths, 6);
  assert.equal(p.pets, 'no');
  assert.equal(p.utilities, 'excluded');
  assert.match(p.available, /1\.11\.2026/);
  assert.ok(p.extras.includes('Sin comisión de agencia'));
  assert.ok(p.extras.includes('Amueblado'));
  assert.match(p.title, /Pronájem bytu/);
});

test('English post in euros with utilities included', () => {
  const p = parseListing(`Room for rent near Flora metro
€ 650 per month, all inclusive
Deposit 650 EUR
Pets allowed. Minimum 3 months. Available from 15/12`);
  assert.equal(p.price, 650);
  assert.equal(p.currency, 'EUR');
  assert.equal(p.deposit, 650);
  assert.equal(p.utilities, 'included');
  assert.equal(p.pets, 'yes');
  assert.equal(p.minMonths, 3);
  assert.equal(p.layout, 'Habitación');
  assert.equal(p.metro, 'Flora');
  assert.match(p.available, /15\/12/);
});

test('Marketplace style price on its own line, thousands separators', () => {
  assert.equal(parseListing('Kč18,000\nApartment 1+1').price, 18000);
  assert.equal(parseListing('CZK 21 000\n1+kk').price, 21000);
  assert.equal(parseListing('Cena 15000 Kč').price, 15000);
  assert.equal(parseListing('18.000,-').price, 18000);
});

test('implausible numbers are not taken as rent', () => {
  const p = parseListing('Tel 777 123 456\nPatro 3, 55 m2\nCena 20 000 Kč');
  assert.equal(p.price, 20000);
  assert.equal(findPrices('Kauce 40 000 Kč')[0].kind, 'deposit');
});

test('street detection avoids price lines and handles prepositions / squares', () => {
  assert.equal(parseListing('Cena 25 000 Kč\nKauce 50 000 Kč').street, '');
  assert.equal(parseListing('Byt na Na Příkopě 22 v centru').street, 'Na Příkopě 22');
  assert.equal(parseListing('Adresa: Korunní 810/104, Praha 10').street, 'Korunní 810/104, Praha 10');
  assert.match(parseListing('náměstí Míru 12').street, /náměstí Míru 12/);
});

test('long minimum stay is detected', () => {
  assert.equal(parseListing('Minimum lease 12 months').minMonths, 12);
  assert.equal(parseListing('min. 1 year contract').minMonths, 12);
  assert.equal(parseListing('nájem na 6 měsíců').minMonths, 6);
});

test('neighbourhood lookup copes with Czech declension and diacritics', () => {
  assert.equal(findPlace('byt na Vinohradech').name, 'Vinohrady');
  assert.equal(findPlace('bydlení na Žižkově').name, 'Žižkov');
  assert.equal(findPlace('v Holešovicích u metra').name, 'Holešovice');
  assert.equal(findPlace('Praha 6 - Dejvice').name, 'Dejvice');
  assert.equal(findPlace('nic zajimaveho'), null);
  assert.equal(districtCenter('Praha 7').name, 'Praha 7');
});

test('offline fallback and query building', () => {
  assert.equal(offlineFallback({ text: 'Smíchov', district: '' }).precision, 'area');
  assert.equal(offlineFallback({ text: '', district: 'Praha 3' }).name, 'Praha 3');
  assert.equal(offlineFallback({ text: '', district: '' }), null);
  const q = buildQueries({ street: 'Vinohradská 125', place: 'Vinohrady', district: 'Praha 2', metro: 'Flora' });
  assert.equal(q[0], 'Vinohradská 125, Vinohrady, Praha');
  assert.ok(q.length <= 4);
});

test('real OCR output of an English shared-room post (January to June, all inclusive)', () => {
  const p = parseListing(`8:02 četl] ll CH
X Posts O &.
4 SHARED APARTMENT ON ZELIVSKY — JANUARY
TO JUNE | 7,940 CZK ALL INCLUSIVE
From January to June, | am offering a place in a
shared room in a flat on Zelivského because | am
moving to Finland for Erasmus.
The apartment is for 4 boys, the rooms are always for
two people. We are looking for a student, ideally
someone from VŠE - Želivského is very well
accessible to the center and public transport thanks
to the metro and public transport.
© Location: Želivského, Prague
Availability: January- June
+8 Apartment: 4 boys, rooms for two
@ Price: 7,940 CZK monthly including all fees and
utilities.
If interested, please send a message, | will send
photos, exact address and more information.`);
  assert.equal(p.price, 7940);
  assert.equal(p.currency, 'CZK');
  assert.equal(p.utilities, 'included');
  assert.equal(p.layout, 'Habitación');
  assert.equal(p.street, 'Želivského, Prague');
  assert.equal(p.metro, '');
  assert.equal(p.available, 'January–June');
  assert.ok(p.extras.includes('Habitación compartida con otra persona'));
  assert.ok(p.extras.includes('Prefieren estudiantes'));
});

test('availability as a month range in Czech and English', () => {
  assert.equal(parseListing('Available from September to January').available, 'September–January');
  assert.equal(parseListing('Volné od 1.12.').available, '1.12');
});
