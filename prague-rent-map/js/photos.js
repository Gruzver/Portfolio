// Finds photo-like rectangles inside a screenshot and crops them out.
//
// Page-segmentation approach: find the background colours of the screenshot (white
// or grey in light mode, dark greys in dark mode), then recursively cut the image
// along rows/columns that are pure background (XY-cut). Text collapses into thin
// line-sized pieces, while photos stay as large, fully covered, colourful blocks.
// Detection works on plain {data, width, height} objects so it can run in Node tests.

const TOL = 16;

export function analyzeBackground({ data, width, height }) {
  const step = width * height > 2_500_000 ? 2 : 1;
  const bins = new Map();
  let total = 0;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      const i = (y * width + x) * 4;
      const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
      let b = bins.get(key);
      if (!b) bins.set(key, (b = { n: 0, r: 0, g: 0, b: 0 }));
      b.n++; b.r += data[i]; b.g += data[i + 1]; b.b += data[i + 2];
      total++;
    }
  }
  const top = [...bins.values()].sort((a, b) => b.n - a.n);
  let palette = top.filter((b) => b.n / total >= 0.04).slice(0, 3);
  if (!palette.length) palette = top.slice(0, 1);
  const colors = palette.map((b) => [b.r / b.n, b.g / b.n, b.b / b.n]);
  const [r, g, b] = colors[0];
  return { palette: colors, dark: 0.299 * r + 0.587 * g + 0.114 * b < 110 };
}

function backgroundMask({ data, width, height }, palette) {
  const mask = new Uint8Array(width * height);
  for (let p = 0, i = 0; p < mask.length; p++, i += 4) {
    for (const c of palette) {
      if (Math.abs(data[i] - c[0]) <= TOL && Math.abs(data[i + 1] - c[1]) <= TOL && Math.abs(data[i + 2] - c[2]) <= TOL) {
        mask[p] = 1;
        break;
      }
    }
  }
  return mask;
}

function runs(flags) {
  const out = [];
  let start = -1;
  for (let i = 0; i <= flags.length; i++) {
    const on = i < flags.length && flags[i];
    if (on && start < 0) start = i;
    if (!on && start >= 0) { out.push([start, i]); start = -1; }
  }
  return out;
}

function profile(mask, W, r, axis) {
  const len = axis === 'y' ? r.h : r.w;
  const across = axis === 'y' ? r.w : r.h;
  const content = new Array(len);
  for (let k = 0; k < len; k++) {
    let nonBg = 0;
    for (let j = 0; j < across; j++) {
      const x = axis === 'y' ? r.x + j : r.x + k;
      const y = axis === 'y' ? r.y + k : r.y + j;
      if (!mask[y * W + x]) nonBg++;
    }
    content[k] = nonBg / across > 0.01;
  }
  return runs(content);
}

function cut(mask, W, rect, leaves, depth = 0) {
  if (rect.w < 2 || rect.h < 2 || depth > 60) return;
  for (const axis of ['y', 'x']) {
    const segs = profile(mask, W, rect, axis);
    if (!segs.length) return;
    const trimmed = segs.length === 1 && segs[0][0] === 0 && segs[0][1] === (axis === 'y' ? rect.h : rect.w);
    if (!trimmed) {
      for (const [a, b] of segs) {
        const sub = axis === 'y' ? { x: rect.x, y: rect.y + a, w: rect.w, h: b - a } : { x: rect.x + a, y: rect.y, w: b - a, h: rect.h };
        cut(mask, W, sub, leaves, depth + 1);
      }
      return;
    }
  }
  leaves.push(rect);
}

function looksLikePhoto({ data, width }, mask, r) {
  let nonBg = 0;
  let count = 0;
  const seen = new Set();
  const coarse = new Map();
  const stepX = Math.max(1, Math.floor(r.w / 160));
  const stepY = Math.max(1, Math.floor(r.h / 160));
  for (let y = r.y; y < r.y + r.h; y += stepY) {
    for (let x = r.x; x < r.x + r.w; x += stepX) {
      const p = y * width + x;
      count++;
      if (!mask[p]) nonBg++;
      const i = p * 4;
      seen.add(((data[i] >> 2) << 12) | ((data[i + 1] >> 2) << 6) | (data[i + 2] >> 2));
      const k = ((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4);
      coarse.set(k, (coarse.get(k) || 0) + 1);
    }
  }
  // photos spread over many colours (one colour covers ~5-10%); flat UI widgets with a
  // small avatar inside are dominated by a single colour (~65%+)
  const dominant = Math.max(...coarse.values()) / count;
  return nonBg / count >= 0.75 && seen.size >= 200 && dominant < 0.5;
}

export function detectPhotoRects(img, { palette } = {}) {
  const { width, height } = img;
  const bg = palette || analyzeBackground(img).palette;
  const mask = backgroundMask(img, bg);
  const leaves = [];
  cut(mask, width, { x: 0, y: 0, w: width, h: height }, leaves);
  const minW = Math.max(80, Math.round(width * 0.07));
  const minH = Math.max(60, Math.round(height * 0.03));
  const minArea = width * height * 0.01; // skips avatars, buttons and other small colourful widgets
  return leaves
    .filter((r) => r.w >= minW && r.h >= minH && r.w * r.h >= minArea && r.w / r.h <= 5 && r.h / r.w <= 4)
    .filter((r) => looksLikePhoto(img, mask, r))
    .sort((a, b) => a.y - b.y || a.x - b.x);
}

export function cropToDataURL(source, rect, { maxSide = 1100, quality = 0.85 } = {}) {
  const scale = Math.min(1, maxSide / Math.max(rect.w, rect.h));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(rect.w * scale));
  c.height = Math.max(1, Math.round(rect.h * scale));
  c.getContext('2d').drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, c.width, c.height);
  return c.toDataURL('image/jpeg', quality);
}
