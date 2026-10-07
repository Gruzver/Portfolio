import * as db from './db.js';
import { createEditor } from './editor.js';
import { CENTER, distanceKm } from './geo.js';
import { el, money, inCzk, safeUrl, toast, STATUS, STAY_MONTHS } from './dom.js';

const $ = (id) => document.getElementById(id);
const PRAGUE = [50.0755, 14.4378];

const map = L.map('map', { zoomControl: true }).setView(PRAGUE, 12);
L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
  maxZoom: 19,
  attribution: '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>',
}).addTo(map);
L.circleMarker([CENTER.lat, CENTER.lng], { radius: 6, weight: 2, color: '#1f2937', fillColor: '#fff', fillOpacity: 1 })
  .bindTooltip(`Centro · ${CENTER.label}`, { direction: 'top' })
  .addTo(map);

const editor = createEditor();
let listings = [];
let selectedId = null;
const markers = new Map();
const markerLayer = L.layerGroup().addTo(map);

// ---- helpers ----------------------------------------------------------------------------
const kmToCenter = (l) => distanceKm(l, CENTER);
const fmtKm = (km) => `${km.toFixed(1).replace('.', ',')} km`;

function visible() {
  const hide = $('hide-discarded').checked;
  const list = listings.filter((l) => !(hide && l.status === 'discarded'));
  const sort = $('sort').value;
  const by = {
    recent: (a, b) => b.createdAt - a.createdAt,
    'price-asc': (a, b) => inCzk(a.price, a.currency) - inCzk(b.price, b.currency),
    'price-desc': (a, b) => inCzk(b.price, b.currency) - inCzk(a.price, a.currency),
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
          `${fmtKm(kmToCenter(l))} del centro`,
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
        `📍 ${l.address || 'Sin dirección'} · ${fmtKm(kmToCenter(l))} del centro`,
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
    for (const l of incoming) await upsert({ photos: [], conditions: [], status: 'new', createdAt: Date.now(), ...l });
    render();
    $('fit-btn').click();
    toast(`${incoming.length} anuncio(s) importados.`);
  } catch {
    toast('No pude leer ese archivo. ¿Es una copia exportada desde esta web?');
  }
});

// ---- start -------------------------------------------------------------------------------------
(async () => {
  listings = await db.loadAll();
  $('storage-warning').hidden = db.persistent;
  render();
  if (listings.length) $('fit-btn').click();
})();
