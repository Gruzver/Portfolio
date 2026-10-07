# Third-party files

Copied verbatim from npm so the site works without any CDN. Nothing here is modified.

| Path | Package | Version | License |
| --- | --- | --- | --- |
| `leaflet/` | [leaflet](https://www.npmjs.com/package/leaflet) (`dist/`) | 1.9.4 | BSD-2-Clause |
| `tesseract/tesseract.min.js`, `tesseract/worker.min.js` | [tesseract.js](https://www.npmjs.com/package/tesseract.js) (`dist/`) | 6.0.1 | Apache-2.0 |
| `tesseract/core/*.wasm.js` | [tesseract.js-core](https://www.npmjs.com/package/tesseract.js-core) (`tesseract-core-simd-lstm.wasm.js`, `tesseract-core-lstm.wasm.js`) | 6.1.2 | Apache-2.0 |
| `tesseract/lang/ces.traineddata.gz` | [@tesseract.js-data/ces](https://www.npmjs.com/package/@tesseract.js-data/ces) (`4.0.0_best_int/`) | 1.0.0 | MIT (npm wrapper); data is Tesseract tessdata_best, Apache-2.0 |
| `tesseract/lang/eng.traineddata.gz` | [@tesseract.js-data/eng](https://www.npmjs.com/package/@tesseract.js-data/eng) (`4.0.0_best_int/`) | 1.0.0 | MIT (npm wrapper); data is Tesseract tessdata_best, Apache-2.0 |

Two core builds are kept: the SIMD one (used by every current browser) and a plain fallback.
To update, `npm install` the packages above in a scratch folder and copy the same files here.
