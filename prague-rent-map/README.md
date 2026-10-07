# Alquiler en Praga · mapa de anuncios

Web estática para comparar anuncios de alquiler de Praga. Subes una **captura de pantalla** de una publicación (por ejemplo de un grupo de Facebook) y la web:

1. lee el texto de la imagen (OCR en checo e inglés, dentro del navegador);
2. extrae precio, fianza, gastos, tipo de piso, m², fecha, duración mínima del contrato, mascotas, etc.;
3. localiza la dirección en el mapa (OpenStreetMap / Nominatim);
4. recorta las **fotos** que aparecen en la captura;
5. guarda el anuncio como un pin con el precio. Al hacer clic se abre el detalle con condiciones, fotos y distancia al centro.

No necesita servidor, cuenta ni claves de API.

## Cómo se usa

- Arrastra una captura a la página, pégala con `Ctrl+V` o elígela con el selector. Puedes subir varias a la vez.
- Se abre una ventana con la captura y el formulario ya rellenado. **Revisa los datos**: el OCR no es perfecto.
  - Recuadros verdes = fotos detectadas. Púlsalos para quitarlos o incluirlos; arrastra sobre la captura para recortar otra.
  - Si la ubicación no es la correcta, escribe otra dirección y pulsa «Buscar en el mapa», haz clic en el mapa o arrastra el pin.
- Cada anuncio puede marcarse como *Por revisar, Favorito, Contactado o Descartado*.
- El detalle avisa cuando el contrato mínimo es más largo que tu estancia (5 meses, constante `STAY_MONTHS` en `js/dom.js`) y calcula el coste estimado de esos meses.
- **Exportar copia / Importar copia** guarda y recupera todo en un archivo JSON. Úsalo como copia de seguridad: los datos viven solo en el navegador (IndexedDB) y se pierden si borras los datos del sitio.

> Muchos anuncios solo dicen el barrio («Vinohrady, Praha 2»). En ese caso el pin queda marcado como **aproximado** (`≈` y borde discontinuo) para que no se confunda con una dirección exacta.

## Privacidad

Las capturas y las fotos **no salen del navegador**. Lo único que se envía fuera es:

- el texto de la dirección, a `nominatim.openstreetmap.org`, para ubicarla;
- las peticiones normales de teselas del mapa a `tile.openstreetmap.org`.

## Despliegue

Esta carpeta se publica dentro del sitio de GitHub Pages de este repositorio (rama `main`, carpeta raíz), en:

`https://gruzver.github.io/Portfolio/prague-rent-map/`

No hay paso de compilación: cualquier cambio que llegue a `main` se publica solo, en uno o dos minutos. Todas las rutas son relativas, así que la app funciona igual en cualquier subcarpeta. La misma carpeta también existe en `Gruzver/Gruzver`, con un workflow de Actions por si algún día se prefiere ese despliegue.

## Probarla en local

Los módulos ES no funcionan abriendo `index.html` con doble clic; sirve la carpeta:

```sh
cd prague-rent-map
python3 -m http.server 8000      # y abre http://localhost:8000
node --test tests/parse.test.mjs tests/photos.test.mjs   # tests unitarios
```

## Estructura

| Ruta | Qué hace |
| --- | --- |
| `index.html`, `css/style.css` | Interfaz |
| `js/app.js` | Mapa, lista, detalle, exportar/importar |
| `js/editor.js` | Ventana de revisión: recortes, OCR, formulario, pin |
| `js/parse.js` | Texto OCR → campos (precio, fianza, dirección, condiciones…) |
| `js/geo.js` | Nominatim + tabla offline de barrios de Praga como alternativa |
| `js/photos.js` | Detección y recorte de fotos dentro de la captura |
| `js/ocr.js`, `js/db.js`, `js/dom.js` | Tesseract.js, IndexedDB, utilidades |
| `assets/ejemplo-anuncio.png` | Captura ficticia para probar |
| `vendor/` | Leaflet y Tesseract.js copiados en el repo (sin CDN); ver `vendor/README.md` |

## Límites conocidos

- El OCR falla más con capturas pequeñas, borrosas o con texto sobre fotos. Hay un botón para releer con más zoom y el texto leído se puede editar y volver a analizar.
- La detección automática de fotos busca bloques rectangulares sobre el fondo de la página; si la captura incluye otros elementos coloridos (mapas, vistas previas de enlaces) también los marcará. Basta con quitarlos.
- Los anuncios que no publican la dirección exacta solo se pueden ubicar de forma aproximada.
- Las tasas EUR/USD → CZK (25 y 23) solo se usan para ordenar la lista por precio.
