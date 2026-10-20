# CLAUDE.md — SKU/FINDER

App local (Node + Express + Playwright) que busca un SKU de refrigerador en tiendas de México, muestra ofertas en cards y guarda un histórico rankeado por menor precio. Uso y arranque: ver `README.md`. Este archivo guarda **las decisiones de producto y las trampas técnicas** que no se deducen leyendo el código.

## Comandos

- `npm start` → http://localhost:3737 · `npm run dev` (watch) · `npm run doctor` (Node, navegador, conectividad)
- `npm test` → `node --test` (sin argumentos: Node 20 no expande globs y `node --test test/` falla).
- Pruebas con navegador en Linux/sandbox sin Chrome: `BROWSER_CHANNEL=chromium CHROME_PATH=/ruta/a/chrome npm test`. Las de `test/extract.test.js` se omiten solas si no hay navegador.
- Sin build: el frontend es HTML/CSS/JS plano en `public/`. No agregar bundlers ni frameworks sin pedirlo.

## Reglas de producto (acordadas con el usuario; no cambiarlas sin preguntar)

- **Match:** solo el modelo exacto cuenta (acepta sufijo regional: `RT38K5930S8` ≡ `RT38K5930S8/EM`, ver `skuVariants`). Parecidos → sección plegable "Posibles coincidencias". Sin relación → se descartan.
- **Promo** = etiqueta de promo de la tienda **o** MSI **o** envío gratis. El **precio tachado se muestra pero NO es promo por sí solo**; solo lo es si la tienda lo marca como oferta/campaña (`discountIsPromo`).
- **Precio de ranking** = precio + envío visible **sin código postal** (el usuario rechazó pedir CP). Envío desconocido o condicional ("gratis con Walmart Pass") → va **después** de todos los de total conocido.
- **Terceros / tiendas no verificadas:** cuentan, etiquetados; interruptor "Excluir terceros" (UI e histórico). `sellerType`: `official | third_party | unverified | unknown`.
- **Agotados, usados/reacondicionados, sin envío a domicilio:** se muestran atenuados al final y no cuentan.
- **Histórico:** una fila por SKU con serie de snapshots; ranking por `best.total`. Solo los 3 snapshots más recientes guardan todas las ofertas. Una búsqueda donde ninguna fuente respondió **no** se guarda.
- **Resultados "todo al final":** la UI hace polling y muestra progreso por tienda, pero las cards aparecen solo al terminar.
- Textos de UI en **español de México**.

## Arquitectura en una línea por pieza

- `server/extract/scan-json.js` y `page-extractor.js`: extractor universal (JSON-LD → JSON de red → estado embebido → DOM).
- `server/extract/index.js`: `openAndExtract` (navega, captura JSON de red, scroll) y `mergeCandidates` (fusiona por URL y luego por título).
- `server/adapters/stores.js`: registro de tiendas. Parsers propios: Amazon, Mercado Libre, Walmart/Sam's/Bodega (`__NEXT_DATA__`), VTEX (Elektra, Chedraui: API `/api/catalog_system/pub/products/search` con respaldo en navegador). El resto usa el extractor universal.
- `server/adapters/web.js`: rastreo DuckDuckGo/Bing (solo dominios MX no cubiertos) y Google Shopping vía SerpAPI (opcional; solo si hay `SERPAPI_KEY`).
- `server/normalize.js`: match, envío, MSI, promo, disponibilidad, ranking. **Aquí viven las reglas de arriba.**
- `server/search.js`: orquesta trabajos, limita páginas en paralelo, verifica fichas cuando el título no trae el modelo y confirma vendedor en Amazon.
- `server/storage.js`: JSON en `data/db.json` con escritura atómica. Sin SQLite a propósito (evita compilar módulos nativos en Windows).
- `server/browser.js`: Chrome → Edge → Chromium; headless con UA corregido (quita "HeadlessChrome"); sesión en `data/browser-state.json`.

## Herramientas del repo (`.claude/`)

- **Hooks:** al editar un `.js` se revisa sintaxis (y que el extractor siga siendo autocontenido); al terminar un turno con cambios se corre `npm test` y bloquea si falla. No hace falta correrlos a mano por duplicado.
- **Reglas por ruta:** `.claude/rules/scrapers.md` (extractor, adaptadores, normalización, pruebas) y `.claude/rules/ui.md` (`public/`) se cargan solo al tocar esos archivos.
- **Skills:** `agregar-tienda` (agregar o reparar una tienda) y `probar-sku <SKU>` (búsqueda real sin tocar el histórico del usuario).
- **Secretos:** las API keys (`SERPAPI_KEY`) se leen solo de `.env` o del entorno (`server/config.js`). Nunca se guardan en `data/db.json`, ni se capturan en la UI, ni se devuelven por la API, ni se escriben en el código. `.env` está en `.gitignore` (el repo se publicará en GitHub); solo se versiona `.env.example`, sin valores. Cada usuario pone y cuida su propia key.
- `data/` es del usuario (histórico y sesión de las tiendas): no editarla ni leer `data/browser-state.json`.
