---
name: agregar-tienda
description: Agregar una tienda nueva al rastreador o reparar una que dejó de dar resultados (aparece como bloqueado, error, sin resultados o con precios mal leídos). Cubre inspección del sitio, adaptador en stores.js, fixture, prueba y verificación en vivo.
argument-hint: <tienda o URL>
---

# Agregar o reparar una tienda: $ARGUMENTS

## 1. Reproduce

Si la tienda ya existe, corre la skill `probar-sku` con un SKU que la tienda venda y solo esa tienda (`probar-sku <SKU> <id>`). Anota estado, lector (`propio`, `universal`, `api`) y nota.

## 2. Inspecciona el sitio (en el navegador, si hay uno disponible)

- **URL de búsqueda:** escribe en el buscador del sitio y copia la URL resultante. No la adivines: varias tiendas usan rutas propias (Coppel `/sd/<q>`, Sears `/resultados?query=`).
- **De dónde salen los datos**, en este orden de preferencia:
  1. API pública: en VTEX prueba `/api/catalog_system/pub/products/search?ft=<q>` → usar `vtexAdapter`.
  2. `__NEXT_DATA__` u otro estado embebido con la lista de productos.
  3. JSON-LD (`script[type="application/ld+json"]`).
  4. Tarjetas del DOM (lo cubre el extractor universal).
- Si usas la extensión de Chrome para leer resultados con JavaScript, quita `?`, `&` y `=` de lo que devuelves (por ejemplo `s.replace(/[?&=]/g,'·')`); si no, la salida se bloquea por parecer datos de cookies/URL.
- Revisa en una tarjeta: precio actual, precio tachado, textos de envío, MSI, etiquetas de promo, vendedor (marketplace) y agotado.

## 3. Implementa en `server/adapters/stores.js`

- Empieza con `storeAdapter({ id, name, domain, group, searchUrl })` **sin** `parse`: el extractor universal suele bastar.
- Agrega `parse` solo si el universal falla o mezcla datos. Debe ser autocontenido (corre en `page.evaluate`) y devolver `{ title, priceText|price, listText|listPrice, url, image, badges, rawText, seller, sellerType, available, skus }`.
- Opciones útiles: `extract.waitFor` (selector de tarjetas), `extract.scrollSteps`, `sourceOrder`, `shippingPolicy.freeOver`, `sellerType` por defecto, `verifySeller` (marketplaces).
- Si la tienda no pone el modelo en el título, no hagas nada especial: `search.js` abre las primeras fichas y busca el SKU (`verify: true` por defecto).
- No cambies reglas de `normalize.js` para acomodar una sola tienda; si un texto nuevo de envío/MSI/promo lo amerita, agrégalo con prueba en `test/normalize.test.js`.

## 4. Fixture y prueba

- Guarda en `test/fixtures/<id>-like.html` un HTML mínimo con 2–3 tarjetas reales recortadas (sin cookies ni datos personales), incluyendo un caso de tachado o agotado si existe.
- Agrega la prueba en `test/extract.test.js` verificando precio, tachado, envío, MSI, promo, vendedor y disponibilidad después de `normalizeOffer`.
- `npm test` debe pasar (el hook de Stop lo corre de todas formas).

## 5. Verifica en vivo y documenta

- Corre `probar-sku <SKU> <id>` y confirma ofertas `exact` con precios coherentes con lo que muestra el sitio.
- Actualiza "Estado contra sitios reales" en `.claude/rules/scrapers.md` y, si es tienda nueva, la tabla del `README.md` y `KNOWN_RETAILERS`/`STORE_MATCH` en `stores.js`.
