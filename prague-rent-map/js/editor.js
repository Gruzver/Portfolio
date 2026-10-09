// The "new / edit listing" dialog: shows the screenshot with detected photo boxes,
// runs OCR in the background, pre-fills the form and lets the user fix the map pin.

import { el, loadImage, uid, safeUrl, STATUS } from './dom.js';
import { analyzeBackground, detectPhotoRects, cropToDataURL } from './photos.js';
import { prepareForOcr, recognize } from './ocr.js';
import { parseListing } from './parse.js';
import { locate, findPlace, isLocated, UNLOCATED } from './geo.js';

const $ = (id) => document.getElementById(id);
const PRAGUE = [50.0755, 14.4378];
const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '© <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a>';
const FIELDS = ['price', 'currency', 'deposit', 'fees', 'layout', 'size', 'available', 'minMonths', 'utilities', 'pets', 'status', 'title', 'address', 'conditions', 'url', 'notes'];
const OCR_STEPS = {
  'loading tesseract core': 'Cargando el motor de lectura (solo la primera vez)…',
  'initializing tesseract': 'Iniciando el motor de lectura…',
  'loading language traineddata': 'Cargando el idioma (checo + inglés)…',
  'initializing api': 'Iniciando el motor de lectura…',
};

export function createEditor() {
  const dlg = $('editor');
  const form = $('editor-form');
  const overlay = $('shot-overlay');
  let s = null; // current editing session
  let miniMap = null;
  let pin = null;

  for (const [value, label] of Object.entries(STATUS)) $('f-status').append(el('option', { value }, label));

  const field = (name) => form.elements[name];
  const setError = (msg = '') => { $('ed-error').textContent = msg; };
  const setGeoStatus = (msg, tone = '') => {
    const p = $('geo-status');
    p.textContent = msg;
    p.dataset.tone = tone;
  };

  // ---- mini map with a draggable pin -------------------------------------------------
  function ensureMap() {
    if (!miniMap) {
      miniMap = L.map('ed-map').setView(PRAGUE, 11);
      L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIBUTION }).addTo(miniMap);
      miniMap.on('click', (e) => setPin(e.latlng.lat, e.latlng.lng, 'manual'));
    }
    setTimeout(() => miniMap.invalidateSize(), 60);
  }

  function setPin(lat, lng, precision, { fly = false } = {}) {
    s.loc = { lat, lng, precision };
    if (!pin) {
      pin = L.marker([lat, lng], { draggable: true, icon: L.divIcon({ className: 'pin-edit', html: el('span', { class: 'pin-dot' }), iconSize: [24, 24], iconAnchor: [12, 24] }) }).addTo(miniMap);
      pin.on('dragend', () => {
        const p = pin.getLatLng();
        s.loc = { lat: p.lat, lng: p.lng, precision: 'manual' };
        setGeoStatus('📍 Ubicación fijada por ti.', 'ok');
      });
    } else {
      pin.setLatLng([lat, lng]);
    }
    if (fly) miniMap.setView([lat, lng], precision === 'area' ? 14 : 17);
    if (precision === 'manual') setGeoStatus('📍 Ubicación fijada por ti.', 'ok');
  }

  function clearPin() {
    if (pin) { pin.remove(); pin = null; }
  }

  const NO_LOCATION_MSG = 'No pude ubicarlo. Escribe la dirección arriba y pulsa Enter, o haz clic en el mapa. '
    + 'Si no, se guardará sin ubicación: saldrá en la lista pero no en el mapa, y podrás colocarla después.';

  async function runGeocode({ manual = false } = {}) {
    const sess = s;
    sess.geoAbort?.abort();
    const ac = new AbortController();
    sess.geoAbort = ac;
    const typed = field('address').value.trim();
    const typedInfo = parseListing(typed);
    const base = manual || sess.dirty.has('address')
      ? { place: findPlace(typed)?.name || '', district: typedInfo.district }
      : sess.hints || {};
    const hints = { ...base, address: typed };
    if (!typed && !base.street && !base.metro && !base.place && !base.district) {
      setGeoStatus(NO_LOCATION_MSG, 'warn');
      return;
    }
    setGeoStatus('Buscando la ubicación…', 'busy');
    try {
      const r = await locate(hints, { signal: ac.signal, onTry: (q) => { if (s === sess) setGeoStatus(`Buscando «${q}»…`, 'busy'); } });
      if (s !== sess || ac.signal.aborted) return;
      if (!r) {
        setGeoStatus(NO_LOCATION_MSG, 'warn');
        return;
      }
      if (sess.loc?.precision === 'manual' && !manual) return;
      setPin(r.lat, r.lng, r.precision, { fly: true });
      const msg = {
        area: '📍 Solo se pudo ubicar la zona (aproximada). Arrastra el pin para afinar.',
        street: '📍 Calle encontrada, sin número exacto. Ajusta el pin si hace falta.',
        exact: '📍 Ubicación encontrada. Revísala y ajústala si hace falta.',
      }[r.precision];
      setGeoStatus(msg, r.precision === 'area' ? 'warn' : 'ok');
    } catch (err) {
      if (err.name !== 'AbortError') setGeoStatus('Error al buscar la ubicación. Haz clic en el mapa para colocar el pin.', 'warn');
    }
  }

  // ---- form helpers -------------------------------------------------------------------
  function setField(name, value, { force = false } = {}) {
    if (value == null || value === '' || Number.isNaN(value)) return;
    if (!force && s.dirty.has(name)) return;
    field(name).value = String(value);
  }

  function applyParsed(p, { force = false } = {}) {
    const set = (n, v) => setField(n, v, { force });
    set('price', p.price);
    if (p.price != null) set('currency', p.currency);
    set('deposit', p.deposit);
    set('fees', p.fees);
    set('layout', p.layout);
    set('size', p.size);
    set('available', p.available);
    set('minMonths', p.minMonths);
    set('utilities', p.utilities);
    set('pets', p.pets);
    const place = findPlace(s.ocrText)?.name || '';
    s.hints = { street: p.street, metro: p.metro, place, district: p.district };
    const streetName = p.street.replace(/,.*$/, '').replace(/\s+\d[\w/]*$/, '').trim();
    set('title', [p.layout, p.size ? `${p.size} m²` : '', place || p.district || streetName].filter(Boolean).join(' · ') || p.title);
    set('address', p.street || (p.metro ? `Metro ${p.metro}` : '') || place || p.district);
    set('conditions', p.extras.join('\n'));
  }

  // ---- screenshot, photo boxes ---------------------------------------------------------
  function renderStrip() {
    const strip = $('crop-strip');
    strip.replaceChildren();
    if (s.listing) {
      s.photos.forEach((src, i) => strip.append(el('figure', { class: 'thumb' },
        el('img', { src, alt: `Foto ${i + 1}` }),
        el('button', { type: 'button', class: 'x', 'aria-label': 'Quitar foto', onclick: () => { s.photos.splice(i, 1); renderStrip(); } }, '✕'))));
      if (!s.photos.length) strip.append(el('p', { class: 'hint' }, 'Este anuncio no tiene fotos.'));
      return;
    }
    const chosen = s.rects.filter((r) => r.on);
    chosen.forEach((r, i) => {
      r.thumb ||= cropToDataURL(s.canvas, r, { maxSide: 220, quality: 0.7 });
      strip.append(el('figure', { class: 'thumb' }, el('img', { src: r.thumb, alt: `Foto ${i + 1}` })));
    });
    if (!chosen.length) strip.append(el('p', { class: 'hint' }, 'Sin fotos seleccionadas. Dibuja un recuadro sobre una foto de la captura para recortarla.'));
  }

  function renderBoxes() {
    overlay.replaceChildren();
    const W = s.canvas.width;
    const H = s.canvas.height;
    for (const r of s.rects) {
      overlay.append(el('div', {
        class: `box ${r.on ? 'on' : 'off'}`,
        style: `left:${(r.x / W) * 100}%;top:${(r.y / H) * 100}%;width:${(r.w / W) * 100}%;height:${(r.h / H) * 100}%`,
        title: r.on ? 'Incluida. Púlsala para quitarla' : 'Excluida. Púlsala para incluirla',
        onclick: () => { r.on = !r.on; renderBoxes(); },
      }, el('button', {
        type: 'button', class: 'x', 'aria-label': 'Eliminar recuadro',
        onclick: (e) => { e.stopPropagation(); s.rects = s.rects.filter((q) => q !== r); renderBoxes(); },
      }, '✕')));
    }
    renderStrip();
  }

  let drag = null;
  const toCanvas = (e) => {
    const b = overlay.getBoundingClientRect();
    return {
      x: Math.min(s.canvas.width, Math.max(0, ((e.clientX - b.left) / b.width) * s.canvas.width)),
      y: Math.min(s.canvas.height, Math.max(0, ((e.clientY - b.top) / b.height) * s.canvas.height)),
    };
  };
  const dragRect = (e) => {
    const p = toCanvas(e);
    return { x: Math.min(drag.x0, p.x), y: Math.min(drag.y0, p.y), w: Math.abs(p.x - drag.x0), h: Math.abs(p.y - drag.y0) };
  };
  overlay.addEventListener('pointerdown', (e) => {
    if (!s || e.target !== overlay) return;
    if (e.pointerType !== 'mouse' && !s.drawMode) return;
    const p = toCanvas(e);
    drag = { x0: p.x, y0: p.y, ghost: el('div', { class: 'box ghost' }) };
    overlay.append(drag.ghost);
    overlay.setPointerCapture(e.pointerId);
    e.preventDefault();
  });
  overlay.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = dragRect(e);
    const W = s.canvas.width;
    const H = s.canvas.height;
    drag.ghost.setAttribute('style', `left:${(r.x / W) * 100}%;top:${(r.y / H) * 100}%;width:${(r.w / W) * 100}%;height:${(r.h / H) * 100}%`);
  });
  overlay.addEventListener('pointerup', (e) => {
    if (!drag) return;
    const r = dragRect(e);
    drag.ghost.remove();
    drag = null;
    if (r.w >= 24 && r.h >= 24) {
      s.rects.push({ x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.w), h: Math.round(r.h), on: true });
      renderBoxes();
    }
  });
  overlay.addEventListener('pointercancel', () => { drag?.ghost.remove(); drag = null; });

  $('draw-toggle').addEventListener('click', (e) => {
    s.drawMode = !s.drawMode;
    overlay.classList.toggle('drawing', s.drawMode);
    e.currentTarget.setAttribute('aria-pressed', String(s.drawMode));
  });

  // ---- OCR ------------------------------------------------------------------------------
  const setOcr = (msg, value = null) => {
    $('ocr-text').textContent = msg;
    const bar = $('ocr-bar');
    if (value == null) bar.removeAttribute('value'); else bar.value = value;
  };

  async function runOcr(scale = 0) {
    const sess = s;
    const token = ++sess.ocrRun;
    sess.reading = true;
    $('ocr-retry').hidden = true;
    setOcr('Preparando la captura…', null);
    try {
      const canvas = prepareForOcr(sess.canvas, { rects: sess.rects, dark: sess.bg.dark, background: sess.bg.palette[0], scale });
      const text = await recognize(canvas, (m) => {
        if (s !== sess || token !== sess.ocrRun) return;
        if (m.status === 'recognizing text') setOcr(`Leyendo el texto… ${Math.round(m.progress * 100)}%`, m.progress);
        else setOcr(OCR_STEPS[m.status] || 'Preparando…', m.progress ?? null);
      });
      if (s !== sess || token !== sess.ocrRun) return;
      sess.ocrText = text;
      $('f-ocr').value = text;
      applyParsed(parseListing(text));
      setOcr(text.trim() ? 'Texto leído. Revisa los datos antes de guardar.' : 'No se pudo leer texto. Rellena los campos a mano.', 1);
      $('ocr-retry').hidden = false;
      runGeocode();
    } catch (err) {
      console.error(err);
      if (s === sess) setOcr('No se pudo leer el texto automáticamente. Rellena los campos a mano.', 0);
    } finally {
      if (token === sess.ocrRun) sess.reading = false;
    }
  }

  $('ocr-retry').addEventListener('click', () => runOcr(2));
  $('reparse-btn').addEventListener('click', () => {
    if (!s) return;
    s.ocrText = $('f-ocr').value;
    s.dirty.clear();
    applyParsed(parseListing(s.ocrText), { force: true });
    runGeocode();
  });
  $('geo-btn').addEventListener('click', () => s && runGeocode({ manual: true }));
  field('address').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); s && runGeocode({ manual: true }); }
  });

  for (const name of FIELDS) {
    const node = field(name);
    node.addEventListener('input', () => { s?.dirty.add(name); setError(); });
  }

  // ---- open / close ---------------------------------------------------------------------
  function finish(result) {
    if (!s) return;
    const sess = s;
    sess.geoAbort?.abort();
    s = null;
    sess.ocrRun = -1;
    if (dlg.open) dlg.close();
    clearPin();
    sess.resolve(result || null);
  }

  function requestClose() {
    if (!s) return;
    if (s.dirty.size && !confirm('¿Descartar los cambios de este anuncio?')) return;
    finish(null);
  }

  dlg.addEventListener('cancel', (e) => { e.preventDefault(); requestClose(); });
  $('ed-close').addEventListener('click', requestClose);
  $('ed-cancel').addEventListener('click', requestClose);

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (!s) return;
    if (!s.loc && (s.reading || $('geo-status').dataset.tone === 'busy')) {
      setError('Todavía estoy leyendo el texto y buscando la ubicación. Espera un momento o haz clic en el mapa.');
      return;
    }
    const loc = s.loc || UNLOCATED; // nothing found and no pin placed: saved without a location
    const text = (name) => field(name).value.trim();
    const num = (name) => (text(name) === '' ? null : Number(text(name)));
    const url = text('url') ? safeUrl(text('url')) : '';
    if (text('url') && !url) { setError('El enlace debe empezar por http:// o https://'); return; }
    const base = s.listing || {};
    const photos = s.listing ? s.photos : s.rects.filter((r) => r.on).map((r) => cropToDataURL(s.canvas, r));
    const screenshot = s.listing ? s.listing.screenshot
      : cropToDataURL(s.canvas, { x: 0, y: 0, w: s.canvas.width, h: s.canvas.height }, { maxSide: 2400, quality: 0.8 });
    finish({
      ...base,
      id: base.id || uid(),
      createdAt: base.createdAt || Date.now(),
      updatedAt: Date.now(),
      title: text('title') || 'Anuncio sin título',
      price: num('price'),
      currency: text('currency') || 'CZK',
      deposit: num('deposit'),
      fees: num('fees'),
      layout: text('layout'),
      size: num('size'),
      available: text('available'),
      minMonths: num('minMonths'),
      utilities: text('utilities'),
      pets: text('pets'),
      status: text('status') || 'new',
      address: text('address'),
      lat: loc.lat,
      lng: loc.lng,
      precision: loc.precision,
      conditions: field('conditions').value.split('\n').map((x) => x.trim()).filter(Boolean),
      url,
      notes: text('notes'),
      photos,
      screenshot,
      ocrText: $('f-ocr').value,
    });
  });

  async function open({ file = null, listing = null } = {}) {
    if (s) return null;
    return new Promise((resolve) => {
      s = { resolve, dirty: new Set(), rects: [], loc: null, ocrText: '', hints: null, canvas: null, bg: null, listing, photos: listing ? [...(listing.photos || [])] : [], ocrRun: 0, drawMode: false };
      const sess = s;
      form.reset();
      setError();
      field('status').value = 'new';
      $('ed-shot-section').classList.toggle('edit-mode', !!listing);
      $('editor-title').textContent = listing ? 'Editar anuncio' : 'Nuevo anuncio';
      $('ocr-retry').hidden = true;
      $('draw-toggle').setAttribute('aria-pressed', 'false');
      overlay.classList.remove('drawing');
      overlay.replaceChildren();
      $('shot-stage').querySelector('canvas')?.remove();
      clearPin();
      dlg.showModal();
      dlg.querySelector('.ed-body').scrollTop = 0;
      ensureMap();

      if (listing) {
        for (const name of FIELDS) {
          if (name === 'conditions') field(name).value = (listing.conditions || []).join('\n');
          else field(name).value = listing[name] ?? '';
        }
        $('f-ocr').value = listing.ocrText || '';
        sess.ocrText = listing.ocrText || '';
        renderStrip();
        if (isLocated(listing)) {
          setPin(listing.lat, listing.lng, listing.precision);
          miniMap.setView([listing.lat, listing.lng], 16);
          setGeoStatus('Arrastra el pin o haz clic en el mapa para corregir la ubicación.');
        } else {
          miniMap.setView(PRAGUE, 11);
          setGeoStatus('Este anuncio no tiene ubicación. Haz clic en el mapa para colocarla, o escribe la dirección y pulsa Enter.', 'warn');
        }
        return;
      }

      miniMap.setView(PRAGUE, 11);
      setGeoStatus('Se buscará la ubicación cuando termine de leerse el texto. También puedes hacer clic en el mapa.');
      setOcr('Cargando la captura…', null);
      (async () => {
        try {
          const img = await loadImage(file);
          if (s !== sess) return;
          const k = Math.min(1, 4000 / Math.max(img.naturalWidth, img.naturalHeight));
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.naturalWidth * k);
          canvas.height = Math.round(img.naturalHeight * k);
          const ctx = canvas.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
          sess.canvas = canvas;
          $('shot-stage').prepend(canvas);
          await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
          if (s !== sess) return;
          const data = ctx.getImageData(0, 0, canvas.width, canvas.height);
          sess.bg = analyzeBackground(data);
          sess.rects = detectPhotoRects(data, { palette: sess.bg.palette }).map((r) => ({ ...r, on: true }));
          renderBoxes();
          runOcr();
        } catch (err) {
          console.error(err);
          setOcr('No se pudo abrir la imagen. Prueba con otra captura.', 0);
        }
      })();
    });
  }

  return { open };
}
