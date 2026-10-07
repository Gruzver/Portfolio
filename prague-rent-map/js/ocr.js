// Runs Tesseract.js (Czech + English) fully in the browser. The engine and the
// language data are served from ../vendor, so nothing about the screenshot leaves the device.

let workerPromise = null;
let onProgress = () => {};

const asset = (path) => new URL(path, import.meta.url).href;

function getWorker() {
  if (!workerPromise) {
    workerPromise = window.Tesseract.createWorker(['ces', 'eng'], 1, {
      workerPath: asset('../vendor/tesseract/worker.min.js'),
      corePath: asset('../vendor/tesseract/core'),
      langPath: asset('../vendor/tesseract/lang'),
      logger: (m) => onProgress(m),
    }).catch((err) => {
      workerPromise = null;
      throw err;
    });
  }
  return workerPromise;
}

// Paints photo regions with the background colour and inverts dark-mode screenshots,
// because the recogniser expects dark text on a light page.
export function prepareForOcr(source, { rects = [], dark = false, background = [255, 255, 255], scale = 0 } = {}) {
  const auto = source.width <= 900 ? 2 : source.width <= 1400 ? 1.5 : 1;
  const k = scale || auto;
  const c = document.createElement('canvas');
  c.width = Math.round(source.width * k);
  c.height = Math.round(source.height * k);
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(source, 0, 0, c.width, c.height);
  ctx.fillStyle = `rgb(${background.map(Math.round).join(',')})`;
  for (const r of rects) ctx.fillRect(r.x * k, r.y * k, r.w * k, r.h * k);
  if (dark) {
    const img = ctx.getImageData(0, 0, c.width, c.height);
    const d = img.data;
    for (let i = 0; i < d.length; i += 4) {
      d[i] = 255 - d[i];
      d[i + 1] = 255 - d[i + 1];
      d[i + 2] = 255 - d[i + 2];
    }
    ctx.putImageData(img, 0, 0);
  }
  return c;
}

export async function recognize(canvas, progress = () => {}) {
  if (!window.Tesseract) throw new Error('Tesseract no está cargado');
  onProgress = (m) => progress(m);
  progress({ status: 'loading', progress: 0 });
  const worker = await getWorker();
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'));
  const { data } = await worker.recognize(blob);
  return data.text || '';
}
