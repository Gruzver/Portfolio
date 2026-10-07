// Small helpers shared by the UI modules. Text from OCR is untrusted, so the UI is
// built with el() + textContent rather than innerHTML.

export const STAY_MONTHS = 5;

export const STATUS = {
  new: 'Por revisar',
  fav: 'Favorito',
  contacted: 'Contactado',
  discarded: 'Descartado',
};

const SYMBOL = { CZK: 'Kč', EUR: '€', USD: '$' };
const TO_CZK = { CZK: 1, EUR: 25, USD: 23 }; // rough rates, only used for sorting

const nf = new Intl.NumberFormat('cs-CZ');

export function money(value, currency = 'CZK') {
  if (value == null || Number.isNaN(value)) return '—';
  const n = nf.format(value).replace(/ /g, ' ');
  return currency === 'CZK' ? `${n} Kč` : currency === 'EUR' ? `${n} €` : `$${n}`;
}

export const symbol = (c) => SYMBOL[c] || c;
export const inCzk = (value, currency) => (value ?? 0) * (TO_CZK[currency] || 1);

export function el(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') node.className = v;
    else if (k === 'text') node.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else node.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    node.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  return node;
}

export function safeUrl(value) {
  try {
    const u = new URL(String(value).trim());
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : `id-${Date.now()}-${Math.random().toString(16).slice(2)}`);

export function loadImage(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('No se pudo leer la imagen')); };
    img.src = url;
  });
}

export function toast(message, ms = 3500) {
  const t = document.getElementById('toast');
  t.textContent = message;
  t.classList.add('show');
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => t.classList.remove('show'), ms);
}
