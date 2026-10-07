// Turns noisy OCR text of a rental post (Czech / English) into structured fields.
// Pure functions only, so they can be unit-tested with `node --test`.

export const norm = (s) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();

const CUR_SUFFIX = String.raw`(?:K[čcéeě](?![\p{L}\d])|CZK|czk|€|EUR(?![\p{L}])|eur(?![\p{L}])|euros?|\$|USD|usd|,-|\.-)`;
const CUR_PREFIX = String.raw`(?:K[čcéeě](?![\p{L}])|CZK|czk|€|EUR|eur|\$|USD|usd)`;
const NUM = String.raw`(?<![\d.,])(?:\d{1,3}(?:[ .,  ]\d{3})+|\d{3,6})(?!\d)`;

const RANGE = { CZK: [2500, 150000], EUR: [100, 5000], USD: [100, 6000] };

function currencyOf(token) {
  const t = norm(token);
  if (t.includes('€') || t.startsWith('eur')) return 'EUR';
  if (t.includes('$') || t === 'usd') return 'USD';
  return 'CZK';
}

const toNumber = (s) => Number(s.replace(/[^\d]/g, ''));

function lineAt(text, index) {
  const start = text.lastIndexOf('\n', index - 1) + 1;
  let end = text.indexOf('\n', index);
  if (end < 0) end = text.length;
  return { line: text.slice(start, end), offset: index - start };
}

const DEPOSIT_KW = /kauce|depozit|deposit|fianza|caution/;
const FEES_KW = /poplatk|energi|sluzb|utilit|fees?\b|service|zaloh|naklad|bills|internet/;
const INCLUSION = /(?:vc\.?|vcetne|including|incl\w*\.?|inclusive of|bez|without|plus|excl\w*\.?|\+)\s+\S+/g;
const RENT_KW = /cena|price|najem|nájem|rent|mesic|month|\/\s*m\b|pronajem/;

export function findPrices(text) {
  const found = [];
  const taken = [];
  const push = (m, numStr, curStr) => {
    const start = m.index;
    const end = start + m[0].length;
    if (taken.some(([a, b]) => start < b && end > a)) return;
    taken.push([start, end]);
    const currency = currencyOf(curStr);
    const value = toNumber(numStr);
    const [lo, hi] = RANGE[currency];
    const { line, offset } = lineAt(text, start);
    const before = norm(line.slice(Math.max(0, offset - 30), offset)).split(/\d/).pop().replace(INCLUSION, '');
    const after = norm(line.slice(offset + m[0].length, offset + m[0].length + 30)).split(/\d/)[0];
    // a keyword after the amount only counts when it directly follows it ("3 000 Kč poplatky")
    const label = `${before} ${/^[\s/:.-]*(?:\w+\s)?(?:kauce|depozit|deposit|poplatk|energi|sluzb|utilit|fees?|service)/.test(after) ? after : ''}`;
    let kind = 'rent';
    if (DEPOSIT_KW.test(label)) kind = 'deposit';
    else if (FEES_KW.test(label)) kind = 'fees';
    found.push({ value, currency, kind, index: start, plausible: value >= lo && value <= hi, hint: RENT_KW.test(norm(line)) });
  };
  for (const m of text.matchAll(new RegExp(`(${NUM})\\s*(${CUR_SUFFIX})`, 'gu'))) push(m, m[1], m[2]);
  for (const m of text.matchAll(new RegExp(`(${CUR_PREFIX})\\s*(${NUM})`, 'gu'))) push(m, m[2], m[1]);
  return found.sort((a, b) => a.index - b.index);
}

const MONTH_RE = '(?:led|uno|brez|dub|kvet|cerv|srp|zari|rij|listopad|prosin|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*';

function findAvailable(text) {
  const n = norm(text);
  if (/\b(ihned|immediately|asap|available now|volne ihned|disponible ya)\b/.test(n)) return 'Inmediato';
  const kw = /(availability|available(?: from)?|volne od|volny od|od|from|dostupne od|nastehovani|move[- ]?in|entry date|disponible desde)\s*[:\-]?\s*/g;
  const range = new RegExp(`^(${MONTH_RE})\\s*(?:-|–|—|to|az|do|until)\\s*(${MONTH_RE})`);
  const cap = (w) => w[0].toUpperCase() + w.slice(1);
  const date = new RegExp(
    `(\\d{1,2}\\s?[./]\\s?\\d{1,2}(?:\\s?[./]\\s?\\d{2,4})?\\.?|\\d{1,2}\\.?\\s*${MONTH_RE}\\s*\\d{0,4}|${MONTH_RE}\\s+\\d{1,2}(?:\\s*,?\\s*\\d{4})?)`
  );
  let m;
  while ((m = kw.exec(n))) {
    const tail = n.slice(m.index + m[0].length, m.index + m[0].length + 28);
    const r = tail.match(range);
    if (r) return `${cap(r[1])}–${cap(r[2])}`;
    const d = tail.match(date);
    if (d && d.index <= 2) return d[1].trim().replace(/[.,;]+$/, '');
  }
  return '';
}

function findMinMonths(n) {
  let m = n.match(/(?:min(?:imum|imalne|\.)?|at least|alespon|nejmene|na)[\s:]*(?:(?:lease|stay|contract|rental|term|period|of)\s+)*(\d{1,2})\s*(?:months?|mesic\w*|mes\b|mes\.|meses)/);
  if (m) return Number(m[1]);
  m = n.match(/(\d{1,2})\s*(?:months?|mesicu|mes\.?)\s*(?:minimum|min\b|or more|a vice|and more)/);
  if (m) return Number(m[1]);
  m = n.match(/(?:min(?:imum)?\.?|at least|lease|contract|smlouv\w*)\D{0,20}(\d)\s*(?:years?|roky|rok|let)\b/);
  if (m) return Number(m[1]) * 12;
  return null;
}

const STREET_WORD = String.raw`(?:nam(?:estí|ěstí|\.)?|náměstí|nábřeží|nábř\.|třída|tř\.|ulice|ul\.)`;
const NOT_STREET = new Set(['cena', 'kauce', 'price', 'deposit', 'rent', 'najem', 'nájem', 'poplatky', 'praha', 'prague', 'patro', 'floor', 'tel', 'phone', 'celkem', 'total', 'plocha', 'size', 'kontakt', 'contact', 'fees', 'energie']);
const STREET_END = /(ska|cka|ova|ni|ho|ych|ice|ke|ske|ska|na|ky)$/;
const PREP = /^(na|u|v|ve|k|ke|pod|nad|za|pred|od)\s/;
const NUMBER_TAIL = String.raw`(\d{1,4}(?:\/\d{1,4})?[a-zA-Z]?)(?![\d\p{L}]|[ .,]\d{3}|[ \t]*(?:m2|m²|kč|kc|czk|€|%|\+|kk|min|měs|mes))`;

export function findStreet(text) {
  const labelled = text.match(/(?:adresa|address|location|lokalita|ulice|street|poloha|📍)\s*[:\-]?\s*([^\n]{4,80})/iu);
  if (labelled) {
    const v = labelled[1].replace(/\s+/g, ' ').replace(/[|,;]+$/, '').trim();
    if (/\p{L}{3,}/u.test(v) && !/^(praha|prague)\s*\d*$/i.test(v)) return v;
  }
  const kw = text.match(new RegExp(String.raw`(?<![\p{L}])((?:\p{L}[\p{L}'’.-]+[ \t]+)?${STREET_WORD}[ \t]+\p{Lu}[\p{L}'’.-]+(?:[ \t]+\p{L}[\p{L}'’.-]*)?|\p{Lu}[\p{L}'’.-]+(?:[ \t]+\p{Lu}[\p{L}'’.-]+)?[ \t]+(?:street|st\.|road|avenue|square))[ \t]*,?[ \t]*(?:${NUMBER_TAIL})?`, 'u'));
  if (kw) return `${kw[1]}${kw[2] ? ' ' + kw[2] : ''}`.replace(/\s+/g, ' ').trim();
  const re = new RegExp(String.raw`(?<![\p{L}\d])((?:(?:Na|U|V|Ve|K|Ke|Pod|Nad|Za|Před|Pred|Od)[ \t]+)?\p{Lu}[\p{L}'’.-]{2,}(?:[ \t]+\p{Lu}[\p{L}'’.-]+)?)[ \t]*,?[ \t]+${NUMBER_TAIL}`, 'gu');
  for (const m of text.matchAll(re)) {
    const name = norm(m[1]);
    if (NOT_STREET.has(name.split(' ')[0]) || NOT_STREET.has(name)) continue;
    if (STREET_END.test(name) || PREP.test(name)) return `${m[1]} ${m[2]}`;
  }
  return '';
}

function findMetro(text) {
  const stop = new Set(['station', 'metro', 'praha', 'prague', 'tram', 'bus', 'stanice', 'stop', 'line']);
  const name = String.raw`(\p{Lu}[\p{L}]+(?:[ -]\p{Lu}[\p{L}]+)?)`;
  const a = text.match(new RegExp(String.raw`(?:[Mm]etr[oau]|[Ss]tanic[ei]|[Ss]tation|Ⓜ️?)[ \t]*(?:metra[ \t]*)?[:\-]?[ \t]*${name}`, 'u'));
  const b = text.match(new RegExp(String.raw`${name}[ \t]+(?:metro|station)\b`, 'u'));
  for (const m of [a, b]) {
    if (m && !stop.has(norm(m[1]))) return m[1];
  }
  return '';
}

function findDistrict(text) {
  const m = norm(text).match(/(?:praha|prague|praga|prag)[\s-]*(\d{1,2})(?!\d)/);
  if (m && Number(m[1]) >= 1 && Number(m[1]) <= 22) return `Praha ${Number(m[1])}`;
  return '';
}

function findLayout(text, n) {
  let m = text.match(/(?<!\d)(\d)\s*[+\-]\s*(kk|1|0)(?![\p{L}\d])/iu);
  if (m) return `${m[1]}+${m[2].toLowerCase()}`;
  m = text.match(/(?<!\d)(\d)\s*kk(?![\p{L}])/iu);
  if (m) return `${m[1]}+kk`;
  if (/garsonk|garsoni|\bstudio\b/.test(n)) return 'Estudio';
  m = n.match(/(\d)\s*(?:bedrooms?|beds?)\b/);
  if (m) return `${m[1]} dorm.`;
  if (/\bpokoj\b|\broom\b|spolubydl|flat ?share|shared (?:flat|apartment)|sdilen/.test(n)) return 'Habitación';
  return '';
}

function findSize(text) {
  const m = text.match(/(?<![\d.,])(\d{2,3}(?:[.,]\d)?)\s*(?:m2|m²|m\^2|m 2|m[?z]|sqm|sq\.? ?m)/i);
  return m ? Number(m[1].replace(',', '.')) : null;
}

function findTitle(text) {
  const lines = text.split('\n').map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => {
    const letters = (l.match(/\p{L}/gu) || []).length;
    return l.length >= 8 && letters / l.length > 0.55;
  });
  const key = /pronajem|pronájem|k pronajmu|for rent|to rent|rent|nabizim|nabízím|hledam|looking/;
  return lines.find((l) => key.test(norm(l))) || lines[0] || '';
}

export function parseListing(raw) {
  const text = (raw || '').replace(/\r/g, '').replace(/[ \t]+/g, ' ');
  const n = norm(text);
  const prices = findPrices(text);
  const plausible = prices.filter((p) => p.plausible);
  const rentCandidates = plausible.filter((p) => p.kind === 'rent');
  const rent = rentCandidates.find((p) => p.hint) || rentCandidates[0] || null;
  const deposit = plausible.find((p) => p.kind === 'deposit' && (!rent || p.currency === rent.currency));
  const fees = plausible.find((p) => p.kind === 'fees' && (!rent || p.currency === rent.currency) && (!rent || p.value < rent.value));

  let utilities = '';
  if (/(?:vcetne|vc\.?|incl(?:uding|usive|\.)?|inclusive of)\s*(?:of\s*)?(?:poplatk|energi|sluzeb|sluzby|utilities|bills|services|internet|vseho|all)|(?:utilities|energie|poplatky|bills|services|internet)\s*(?:included|v cene)|all[- ]?inclusive|all included/.test(n)) utilities = 'included';
  else if (fees || /(?:plus|\+|bez|excl(?:uding|usive|\.)?|without)\s*(?:the\s*)?(?:poplatk|energi|sluzeb|utilities|bills|services)|(?:utilities|energie|poplatky|bills)\s*(?:not included|extra|navic|nejsou)|zalohy na (?:energie|sluzby)/.test(n)) utilities = 'excluded';

  let pets = '';
  if (/no pets|pets? (?:are )?not (?:allowed|permitted)|no animals|bez zvirat|zadna zvirata|zvirata ne/.test(n)) pets = 'no';
  else if (/pets? (?:allowed|welcome|ok\b|friendly)|pet[- ]friendly|zvirata (?:povolena|ano|vitana|mozna)|mazlicci|se zvirat/.test(n)) pets = 'yes';

  const extras = [];
  if (/unfurnished|nezarizen|nevybaven/.test(n)) extras.push('Sin amueblar');
  else if (/furnished|zarizen|vybaven/.test(n)) extras.push('Amueblado');
  if (/bez provize|no commission|no agency fee|without commission|no fee\b/.test(n)) extras.push('Sin comisión de agencia');
  else if (/provize|commission|agency fee/.test(n)) extras.push('Posible comisión de agencia');
  if (/short[- ]?term|kratkodob/.test(n)) extras.push('Alquiler de corto plazo');
  else if (/long[- ]?term|dlouhodob/.test(n)) extras.push('Alquiler de largo plazo');
  if (/wi-?fi|internet v cene|internet included/.test(n)) extras.push('Wi-Fi / internet');
  if (/shared room|rooms? (?:are )?(?:always )?for (?:two|2)|double room|sdileny pokoj|pokoj pro (?:dva|2)|2 (?:people|persons) (?:in|per) (?:the )?room/.test(n)) extras.push('Habitación compartida con otra persona');
  if (/shared (?:flat|apartment)|flat ?share|spolubydl|sdilen\w* byt/.test(n)) extras.push('Piso compartido');
  if (/(?:prefer|looking for|ideally|hledame|hledam|hledame)[^.\n]{0,40}student|pro student|studen\w+ (?:only|preferred)/.test(n)) extras.push('Prefieren estudiantes');
  if (/non[- ]?smoker|no smoking|nekurak|nekurac/.test(n)) extras.push('No fumadores');

  const layout = findLayout(text, n);
  const size = findSize(text);
  const district = findDistrict(text);

  return {
    title: findTitle(text),
    price: rent ? rent.value : null,
    currency: rent ? rent.currency : (prices[0] ? prices[0].currency : 'CZK'),
    deposit: deposit ? deposit.value : null,
    fees: fees ? fees.value : null,
    layout,
    size,
    available: findAvailable(text),
    minMonths: findMinMonths(n),
    utilities,
    pets,
    street: findStreet(text),
    metro: findMetro(text),
    district,
    extras,
  };
}
