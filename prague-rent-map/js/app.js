import * as db from './db.js';
import { createSync } from './sync.js';
import { createEditor } from './editor.js';
import { CENTER, distanceKm } from './geo.js';
import { el, money, inCzk, safeUrl, toast, STATUS, STAY_MONTHS } from './dom.js';
import { POIS, applyCachedPois, refinePois, distancesTo, fmtKm } from './places.js';

const $ = (id) => document.getElementById(id);
const PRAGUE = [50.0755, 14.4378];

const store = {
  get(key) { try { return localStorage.getItem(key); } catch { return null; } },
  set(key, value) { try { localStorage.setItem(key, value); } catch { /* storage blocked */ } },
};

const OSM_LINK = '<a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
const streets = L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', { maxZoom: 19, attribution: `© ${OSM_LINK}` });
// ÖPNVKarte (memomaps.de): the same OSM data styled to show metro, tram, bus and train lines with their names.
const transit = L.tileLayer('https://tileserver.memomaps.de/tilegen/{z}/{x}/{y}.png', {
  maxNativeZoom: 18,
  maxZoom: 19,
  attribution: `Map © <a href="https://memomaps.de/" target="_blank" rel="noopener">memomaps.de</a> <a href="https://creativecommons.org/licenses/by-sa/2.0/" target="_blank" rel="noopener">CC-BY-SA</a>, data © ${OSM_LINK} contributors`,
});

const map = L.map('map', { zoomControl: true, maxZoom: 19 }).setView(PRAGUE, 12);
L.circleMarker([CENTER.lat, CENTER.lng], { radius: 6, weight: 2, color: '#1f2937', fillColor: '#fff', fillOpacity: 1 })
  .bindTooltip(`Centro · ${CENTER.label}`, { direction: 'top' })
  .addTo(map);

// Extra buttons under the zoom control.
function mapButton(glyph, title, onClick) {
  const Control = L.Control.extend({
    options: { position: 'topleft' },
    onAdd() {
      const bar = L.DomUtil.create('div', 'leaflet-bar leaflet-control');
      const a = L.DomUtil.create('a', 'map-btn', bar);
      a.href = '#';
      a.setAttribute('role', 'button');
      a.title = title;
      a.setAttribute('aria-label', title);
      a.textContent = glyph;
      L.DomEvent.disableClickPropagation(bar);
      L.DomEvent.on(a, 'click', (e) => { L.DomEvent.preventDefault(e); onClick(a); });
      return bar;
    },
  });
  const control = new Control();
  control.addTo(map);
  return control.getContainer().querySelector('a');
}

const appEl = document.querySelector('.app');
function setSidebar(hidden) {
  appEl.classList.toggle('collapsed', hidden);
  sidebarBtn.setAttribute('aria-pressed', String(!hidden));
  sidebarBtn.title = hidden ? 'Mostrar la lista' : 'Ocultar la lista';
  sidebarBtn.setAttribute('aria-label', sidebarBtn.title);
  store.set('prm.sidebar', hidden ? 'hidden' : 'shown');
  setTimeout(() => map.invalidateSize(), 60);
}
const sidebarBtn = mapButton('☰', 'Ocultar la lista', () => setSidebar(!appEl.classList.contains('collapsed')));
mapButton('＋', 'Añadir una captura', () => $('file-input').click());

const TRANSIT_OFF = 'Ver líneas de metro, tranvía, bus y tren';
function setTransit(on) {
  if (on) { map.removeLayer(streets); transit.addTo(map); } else { map.removeLayer(transit); streets.addTo(map); }
  transitBtn.classList.toggle('active', on);
  transitBtn.setAttribute('aria-pressed', String(on));
  transitBtn.title = on ? 'Volver al mapa de calles' : TRANSIT_OFF;
  transitBtn.setAttribute('aria-label', transitBtn.title);
  store.set('prm.transit', on ? '1' : '0');
}
const transitBtn = mapButton('🚇', TRANSIT_OFF, () => setTransit(!transitBtn.classList.contains('active')));

// Workplaces: always on the map, never filtered.
const poiMarkers = new Map();
function drawPois() {
  for (const p of POIS) {
    const existing = poiMarkers.get(p.id);
    if (existing) { existing.setLatLng([p.lat, p.lng]); continue; }
    const popup = el('div', { class: 'poi-pop' },
      el('strong', {}, p.name),
      el('div', {}, p.address),
      el('a', { href: `https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lng}`, target: '_blank', rel: 'noopener noreferrer' }, 'Google Maps'));
    const marker = L.marker([p.lat, p.lng], {
      icon: L.divIcon({ className: 'pin', html: el('span', { class: 'poi' }, `💼 ${p.short}`), iconSize: [0, 0] }),
      title: `${p.name} · ${p.address}`,
      zIndexOffset: 500,
    }).bindPopup(popup).addTo(map);
    poiMarkers.set(p.id, marker);
  }
}

const editor = createEditor();

// Server sync (only active when the app is served by server/server.py).
const syncLabel = {
  syncing: () => '↻ Sincronizando con tu servidor…',
  ok: ({ lastSync }) => `☁ Sincronizado con tu servidor · ${new Date(lastSync).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })}`,
  offline: () => '⚠ Sin conexión con el servidor. Los cambios se guardan aquí y se enviarán al reconectar.',
};
const PRIVACY_LOCAL = 'Todo se procesa en tu navegador y se guarda solo en este dispositivo. Las capturas no se suben a ningún servidor; solo se envía a OpenStreetMap el texto de la dirección para ubicarla en el mapa.';
const PRIVACY_SERVER = 'Todo se procesa en tu navegador. Los anuncios se guardan en este dispositivo y en tu servidor privado. Las capturas no se suben a ningún otro sitio; solo se envía a OpenStreetMap el texto de la dirección para ubicarla en el mapa.';
const sync = createSync({
  db,
  onChange: async () => {
    const wasEmpty = listings.length === 0;
    listings = await db.loadAll();
    render();
    if (wasEmpty && listings.length) $('fit-btn').click(); // first listings arriving on a new device
    const open = listings.find((l) => l.id === selectedId);
    if (open) renderDrawer(open);
  },
  onStatus: (s) => {
    const line = $('sync-status');
    line.hidden = s.state === 'disabled';
    line.dataset.state = s.state;
    if (s.state !== 'disabled') line.textContent = syncLabel[s.state](s);
    document.querySelector('.privacy').textContent = s.state === 'disabled' ? PRIVACY_LOCAL : PRIVACY_SERVER;
  },
});
let listings = [];
let selectedId = null;
const markers = new Map();
const markerLayer = L.layerGroup().addTo(map);

// ---- helpers ----------------------------------------------------------------------------
const kmToCenter = (l) => distanceKm(l, CENTER);

function visible() {
  const hide = $('hide-discarded').checked;
  const list = listings.filter((l) => !(hide && l.status === 'discarded'));
  const sort = $('sort').value;
  const by = {
    recent: (a, b) => b.createdAt - a.createdAt,
    'price-asc': (a, b) => inCzk(a.price, a.currency) - inCzk(b.price, b.currency),
    'price-desc': (a, b) => inCzk(b.price, b.currency) - inCzk(a.price, a.currency),
    f4f: (a, b) => distanceKm(a, POIS[0]) - distanceKm(b, POIS[0]),
    mrs: (a, b) => distanceKm(a, POIS[1]) - distanceKm(b, POIS[1]),
    center: (a, b) => kmToCenter(a) - kmToCenter(b),
  }[sort];
  return list.sort(by);
}

function pillIcon(l) {
  const approx = l.precision === 'area';
  const pill = el('span', { class: `pill st-${l.status || 'new'}${approx ? ' approx' : ''}${l.id === selectedId ? ' sel' : ''}` },
    `${approx ? '≈ ' : ''}${l.price != null ? money(l.price, l.currency) : '¿?'}`);
  return L.divIcon({ className: 'pin', html: pill, iconSize: [0, 0] });
}

function focusOn(latlng, zoom) {
  const z = Math.max(map.getZoom(), zoom);
  const wide = window.matchMedia('(min-width: 861px)').matches;
  const shift = wide ? [200, 0] : [0, 150];
  const target = map.unproject(map.project(latlng, z).add(shift), z);
  map.flyTo(target, z, { duration: 0.6 });
}

// ---- rendering --------------------------------------------------------------------------
function render() {
  const shown = visible();
  markerLayer.clearLayers();
  markers.clear();
  for (const l of shown) {
    const m = L.marker([l.lat, l.lng], { icon: pillIcon(l), keyboard: true, title: l.title, riseOnHover: true });
    m.on('click', () => select(l.id));
    m.addTo(markerLayer);
    markers.set(l.id, m);
  }

  const list = $('list');
  list.replaceChildren(...shown.map(itemFor));
  $('empty').hidden = listings.length > 0;
  const hidden = listings.length - shown.length;
  $('count').textContent = `${shown.length} anuncio${shown.length === 1 ? '' : 's'}${hidden ? ` (+${hidden} oculto${hidden === 1 ? '' : 's'})` : ''}`;
  if (selectedId && !listings.some((l) => l.id === selectedId)) closeDrawer();
}

function itemFor(l) {
  const thumb = l.photos?.[0]
    ? el('img', { src: l.photos[0], alt: '', loading: 'lazy' })
    : el('span', { class: 'ph', 'aria-hidden': 'true' }, '🏠');
  return el('li', { class: `item st-${l.status || 'new'}${l.id === selectedId ? ' sel' : ''}` },
    el('button', { type: 'button', class: 'item-btn', onclick: () => select(l.id, { fly: true }) },
      el('span', { class: 'thumb-box' }, thumb),
      el('span', { class: 'item-body' },
        el('strong', { class: 'item-price' }, l.price != null ? money(l.price, l.currency) : 'Precio ¿?'),
        el('span', { class: 'item-title' }, l.title),
        el('span', { class: 'item-meta' },
          distancesTo(l).map((d) => `${d.short} ${fmtKm(d.km)}`).join(' · '),
          l.status && l.status !== 'new' ? ` · ${STATUS[l.status]}` : '',
          l.precision === 'area' ? ' · ubicación aproximada' : ''))));
}

function chip(text, tone = '') {
  return el('li', { class: `chip ${tone}` }, text);
}

function renderDrawer(l) {
  const d = $('drawer');
  const extraFees = l.utilities === 'excluded' && l.fees ? l.fees : 0;
  const monthly = l.price != null ? l.price + extraFees : null;

  const chips = [];
  if (l.layout) chips.push(chip(l.layout));
  if (l.size) chips.push(chip(`${l.size} m²`));
  if (l.minMonths != null) chips.push(chip(`Contrato mín. ${l.minMonths} meses`, l.minMonths > STAY_MONTHS ? 'bad' : 'good'));
  if (l.utilities === 'included') chips.push(chip('Servicios incluidos', 'good'));
  if (l.utilities === 'excluded') chips.push(chip(l.fees ? `Servicios aparte (+${money(l.fees, l.currency)})` : 'Servicios aparte', 'warn'));
  if (l.pets === 'yes') chips.push(chip('Mascotas permitidas', 'good'));
  if (l.pets === 'no') chips.push(chip('Sin mascotas', 'warn'));
  if (l.available) chips.push(chip(`Disponible: ${l.available}`));

  const facts = [];
  if (l.deposit) facts.push(`Fianza: ${money(l.deposit, l.currency)}`);
  if (monthly != null) facts.push(`Coste estimado de ${STAY_MONTHS} meses: ${money(monthly * STAY_MONTHS, l.currency)} (sin fianza)`);
  facts.push(...(l.conditions || []));

  const url = l.url ? safeUrl(l.url) : '';
  const statusSelect = el('select', { 'aria-label': 'Estado', onchange: async (e) => {
    l.status = e.target.value;
    l.updatedAt = Date.now();
    await db.save(l);
    sync.schedule();
    render();
    renderDrawer(l);
  } }, Object.entries(STATUS).map(([v, label]) => el('option', { value: v, selected: v === (l.status || 'new') }, label)));

  d.replaceChildren(
    el('header', { class: 'dr-head' },
      el('div', {},
        el('div', { class: 'dr-price' }, l.price != null ? money(l.price, l.currency) : 'Precio ¿?', el('small', {}, ' / mes')),
        el('h2', {}, l.title)),
      el('button', { type: 'button', class: 'icon-btn', 'aria-label': 'Cerrar detalle', onclick: closeDrawer }, '✕')),
    el('div', { class: 'dr-scroll' },
      chips.length ? el('ul', { class: 'chips' }, chips) : null,
      el('p', { class: 'where' },
        `📍 ${l.address || 'Sin dirección'}`,
        el('span', { class: 'dist' }, `En línea recta: ${[...distancesTo(l).map((d) => `${d.short} ${fmtKm(d.km)}`), `centro ${fmtKm(kmToCenter(l))}`].join(' · ')}`),
        l.precision === 'area' ? el('em', {}, ' Ubicación aproximada: el anuncio solo indicaba la zona.') : null),
      l.photos?.length
        ? el('div', { class: 'photos' }, l.photos.map((src, i) => el('button', { type: 'button', class: 'photo', 'aria-label': `Ver foto ${i + 1}`, onclick: () => openLightbox(l.photos, i) }, el('img', { src, alt: `Foto ${i + 1}`, loading: 'lazy' }))))
        : el('p', { class: 'muted' }, 'No hay fotos guardadas para este anuncio.'),
      el('h3', {}, 'Condiciones'),
      facts.length ? el('ul', { class: 'facts' }, facts.map((f) => el('li', {}, f))) : el('p', { class: 'muted' }, 'Sin condiciones registradas.'),
      l.notes ? el('p', { class: 'notes' }, l.notes) : null,
      el('div', { class: 'dr-actions' },
        url ? el('a', { class: 'btn', href: url, target: '_blank', rel: 'noopener noreferrer' }, 'Abrir publicación') : null,
        el('a', { class: 'btn', href: `https://www.google.com/maps/search/?api=1&query=${l.lat},${l.lng}`, target: '_blank', rel: 'noopener noreferrer' }, 'Google Maps'),
        l.screenshot ? el('button', { type: 'button', class: 'btn', onclick: () => openLightbox([l.screenshot], 0) }, 'Ver captura') : null),
      el('label', { class: 'status-row' }, 'Estado ', statusSelect),
      el('div', { class: 'dr-actions' },
        el('button', { type: 'button', class: 'btn', onclick: () => edit(l) }, 'Editar'),
        el('button', { type: 'button', class: 'btn danger', onclick: () => removeListing(l) }, 'Eliminar')),
      l.ocrText ? el('details', { class: 'ocr-details' }, el('summary', {}, 'Texto del anuncio'), el('pre', {}, l.ocrText)) : null));
  d.hidden = false;
}

function closeDrawer() {
  selectedId = null;
  $('drawer').hidden = true;
  render();
}

function select(id, { fly = false } = {}) {
  const l = listings.find((x) => x.id === id);
  if (!l) return;
  selectedId = id;
  render();
  renderDrawer(l);
  $('drawer').scrollTop = 0;
  focusOn([l.lat, l.lng], fly ? 16 : 14);
  document.querySelector('.item.sel')?.scrollIntoView({ block: 'nearest' });
}

// ---- lightbox -----------------------------------------------------------------------------
const lb = { photos: [], i: 0 };
function showLightbox() {
  $('lb-img').src = lb.photos[lb.i];
  $('lb-prev').hidden = $('lb-next').hidden = lb.photos.length < 2;
}
function openLightbox(photos, i) {
  lb.photos = photos;
  lb.i = i;
  showLightbox();
  if (!$('lightbox').open) $('lightbox').showModal();
}
const stepLightbox = (d) => { lb.i = (lb.i + d + lb.photos.length) % lb.photos.length; showLightbox(); };
$('lb-prev').addEventListener('click', () => stepLightbox(-1));
$('lb-next').addEventListener('click', () => stepLightbox(1));
$('lb-close').addEventListener('click', () => $('lightbox').close());
$('lightbox').addEventListener('click', (e) => { if (e.target === $('lightbox')) $('lightbox').close(); });
$('lightbox').addEventListener('keydown', (e) => {
  if (e.key === 'ArrowLeft' && lb.photos.length > 1) stepLightbox(-1);
  if (e.key === 'ArrowRight' && lb.photos.length > 1) stepLightbox(1);
});

// ---- data actions -------------------------------------------------------------------------
async function upsert(listing) {
  await db.save(listing);
  sync.schedule();
  const i = listings.findIndex((l) => l.id === listing.id);
  if (i >= 0) listings[i] = listing; else listings.push(listing);
}

async function edit(l) {
  const result = await editor.open({ listing: l });
  if (!result) return;
  await upsert(result);
  select(result.id, { fly: true });
  toast('Cambios guardados.');
}

async function removeListing(l) {
  if (!confirm(`¿Eliminar «${l.title}»?`)) return;
  await db.remove(l.id);
  sync.schedule();
  listings = listings.filter((x) => x.id !== l.id);
  closeDrawer();
  toast('Anuncio eliminado.');
}

// ---- adding screenshots: queue of files, one editor session at a time -----------------------
const queue = [];
let busy = false;

function enqueue(files) {
  const images = [...files].filter((f) => f.type.startsWith('image/'));
  if (!images.length) { toast('Elige una imagen (captura de pantalla).'); return; }
  queue.push(...images);
  pump();
}

async function pump() {
  if (busy) return;
  busy = true;
  try {
    while (queue.length) {
      const file = queue.shift();
      const result = await editor.open({ file });
      if (!result) continue;
      await upsert(result);
      select(result.id, { fly: true });
      toast(queue.length ? `Guardado. Quedan ${queue.length} captura(s) por revisar.` : 'Anuncio guardado en el mapa.');
    }
  } finally {
    busy = false;
  }
}

const dropzone = $('dropzone');
$('file-input').addEventListener('change', (e) => { enqueue(e.target.files); e.target.value = ''; });
dropzone.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file-input').click(); }
});
window.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('over'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) dropzone.classList.remove('over'); });
window.addEventListener('drop', (e) => {
  e.preventDefault();
  dropzone.classList.remove('over');
  if (e.dataTransfer?.files?.length) enqueue(e.dataTransfer.files);
});
document.addEventListener('paste', (e) => {
  if ($('editor').open || $('lightbox').open) return;
  const files = [...(e.clipboardData?.files || [])].filter((f) => f.type.startsWith('image/'));
  if (files.length) { e.preventDefault(); enqueue(files); }
});

$('sample-btn').addEventListener('click', async () => {
  try {
    const res = await fetch('assets/ejemplo-anuncio.png');
    if (!res.ok) throw new Error(res.status);
    const blob = await res.blob();
    enqueue([new File([blob], 'ejemplo-anuncio.png', { type: 'image/png' })]);
  } catch {
    toast('No se pudo cargar la captura de ejemplo.');
  }
});

// ---- toolbar, export / import -----------------------------------------------------------------
$('sort').addEventListener('change', render);
$('hide-discarded').addEventListener('change', render);
$('fit-btn').addEventListener('click', () => {
  const pts = visible().map((l) => [l.lat, l.lng]);
  if (!pts.length) { map.setView(PRAGUE, 12); return; }
  // keep the workplaces in frame so each listing can be judged against them
  pts.push(...POIS.map((p) => [p.lat, p.lng]));
  map.fitBounds(L.latLngBounds(pts).pad(0.25), { maxZoom: 16 });
});

$('export-btn').addEventListener('click', () => {
  if (!listings.length) { toast('Todavía no hay anuncios que exportar.'); return; }
  const blob = new Blob([JSON.stringify({ app: 'prague-rent-map', version: 1, exportedAt: new Date().toISOString(), listings })], { type: 'application/json' });
  const a = el('a', { href: URL.createObjectURL(blob), download: `alquiler-praga-${new Date().toISOString().slice(0, 10)}.json` });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
});

$('import-btn').addEventListener('click', () => $('import-input').click());
$('import-input').addEventListener('change', async (e) => {
  const file = e.target.files[0];
  e.target.value = '';
  if (!file) return;
  try {
    const data = JSON.parse(await file.text());
    const incoming = (Array.isArray(data) ? data : data.listings || []).filter((l) => l && l.id && Number.isFinite(l.lat) && Number.isFinite(l.lng));
    if (!incoming.length) throw new Error('vacío');
    // a listing deleted here earlier and imported again means "bring it back": without a fresh
    // updatedAt the older timestamp in the file would lose against the deletion during sync
    const deletedHere = new Set((await db.loadTombstones()).map((t) => t.id));
    for (const l of incoming) {
      await upsert({
        photos: [], conditions: [], status: 'new', createdAt: Date.now(), updatedAt: Date.now(), ...l,
        ...(deletedHere.has(l.id) ? { updatedAt: Date.now() } : {}),
      });
    }
    render();
    $('fit-btn').click();
    toast(`${incoming.length} anuncio(s) importados.`);
  } catch {
    toast('No pude leer ese archivo. ¿Es una copia exportada desde esta web?');
  }
});

// ---- start -------------------------------------------------------------------------------------
(async () => {
  setTransit(store.get('prm.transit') === '1');
  setSidebar(store.get('prm.sidebar') === 'hidden');
  applyCachedPois();
  drawPois();
  listings = await db.loadAll();
  $('storage-warning').hidden = db.persistent;
  render();
  if (listings.length) $('fit-btn').click();
  sync.start();
  refinePois().then((moved) => {
    if (!moved) return;
    drawPois();
    render();
    const open = listings.find((l) => l.id === selectedId);
    if (open) renderDrawer(open);
  });
})();
