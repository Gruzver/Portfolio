import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeBackground, detectPhotoRects } from '../js/photos.js';

function makeImage(w, h, bg) {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) { data.set([...bg, 255], i * 4); }
  return { data, width: w, height: h };
}
const setPx = (img, x, y, r, g, b) => img.data.set([r, g, b, 255], (y * img.width + x) * 4);
function fillRect(img, x0, y0, w, h, fn) {
  for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) setPx(img, x, y, ...fn(x, y));
}
let seed = 1;
const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const photo = (base) => (x, y) => base.map((c, k) => Math.max(0, Math.min(255, c + Math.sin(x / (9 + k)) * 40 + Math.cos(y / (7 + k)) * 40 + (rand() - 0.5) * 30)));
// text-like: thin dark strokes with gaps between lines
function textLines(img, x0, y0, w, lines) {
  for (let l = 0; l < lines; l++) {
    const y = y0 + l * 34;
    for (let x = x0; x < x0 + w; x++) if (rand() > 0.35) fillRect(img, x, y + 4 + Math.floor(rand() * 3), 1, 14, () => [30, 30, 30]);
  }
}

function scene(bg) {
  const img = makeImage(900, 1000, bg);
  const ink = bg[0] > 128 ? [30, 30, 30] : [235, 235, 235];
  for (let l = 0; l < 6; l++) {
    const y = 40 + l * 34;
    for (let x = 40; x < 700; x++) if (rand() > 0.35) fillRect(img, x, y + 4 + Math.floor(rand() * 3), 1, 14, () => ink);
  }
  fillRect(img, 40, 20, 40, 40, () => [90, 120, 200]); // avatar-sized colour block (too small to be a photo)
  fillRect(img, 40, 300, 820, 380, photo([190, 150, 110])); // wide photo
  fillRect(img, 40, 686, 405, 280, photo([120, 150, 190])); // two photos with a 10px gap
  fillRect(img, 455, 686, 405, 280, photo([110, 170, 120]));
  return img;
}

const near = (r, x, y, w, h, tol = 6) =>
  Math.abs(r.x - x) <= tol && Math.abs(r.y - y) <= tol && Math.abs(r.w - w) <= tol && Math.abs(r.h - h) <= tol;

test('finds the three photos on a light page and ignores text and avatar', () => {
  const img = scene([255, 255, 255]);
  const rects = detectPhotoRects(img);
  assert.equal(rects.length, 3, JSON.stringify(rects));
  assert.ok(near(rects[0], 40, 300, 820, 380));
  assert.ok(near(rects[1], 40, 686, 405, 280));
  assert.ok(near(rects[2], 455, 686, 405, 280));
});

test('works on a dark-mode page and detects it as dark', () => {
  const img = scene([36, 37, 38]);
  assert.equal(analyzeBackground(img).dark, true);
  assert.equal(detectPhotoRects(img).length, 3);
});

test('text only produces no photos', () => {
  const img = makeImage(900, 400, [255, 255, 255]);
  textLines(img, 30, 30, 800, 10);
  assert.equal(detectPhotoRects(img).length, 0);
});

test('a small grey pill with a colourful avatar (comment bar) is not a photo', () => {
  const img = makeImage(1000, 1200, [255, 255, 255]);
  fillRect(img, 30, 1100, 190, 70, () => [228, 230, 235]);
  fillRect(img, 40, 1105, 60, 60, photo([90, 120, 200]));
  fillRect(img, 40, 100, 920, 600, photo([190, 150, 110]));
  const rects = detectPhotoRects(img);
  assert.equal(rects.length, 1, JSON.stringify(rects));
  assert.ok(near(rects[0], 40, 100, 920, 600));
});
