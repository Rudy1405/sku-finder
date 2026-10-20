---
paths:
  - "server/extract/**"
  - "server/adapters/**"
  - "server/normalize.js"
  - "server/search.js"
  - "test/**"
---

# Extractor, adaptadores y normalización

## Trampas conocidas (ya costaron bugs)

- `scanJson` y `extractPage` se **serializan con `.toString()` y corren dentro del navegador**: deben ser autocontenidas (sin imports, sin variables de fuera de su cuerpo). El hook `check-edit` lo verifica al editarlas.
- Tachado por clase CSS: se evalúa **por token** (`STRIKE_TOKEN`). Un regex sobre todo el `class` confundía `font-bold` con "old" y anulaba los precios de Liverpool (Tailwind).
- `MSI_RE` **no lleva `\b` después de "intereses"**: Amazon pega textos ("…sin interesesEntrega GRATIS").
- En `findPrice`, **los arreglos no consumen profundidad**; si no, el precio VTEX (`items[].sellers[].commertialOffer.Price`) queda fuera de alcance.
- Walmart: "Envío sin costo con …" es **condicional**, no gratis.
- Home Depot no pone el modelo en el título → depende de `verifyOnProductPage`.
- Mercado Libre: los anuncios usan URLs `click1.mercadolibre…`; no filtrarlas como externas.
- Coppel: `shippingPolicy.freeOver: 599`.
- Funciones `parse` de tiendas corren con `page.evaluate`: también deben ser autocontenidas.

## Estado contra sitios reales (oct 2026)

- Probado en vivo: **Sears, Liverpool**. Estructura inspeccionada: Amazon, Mercado Libre, Walmart, Sam's, Home Depot, Coppel (`/sd/<q>`), Palacio, Soriana.
- **Sin verificar:** Costco, Elektra, Sanborns, Chedraui, Bodega Aurrera (URLs/plataforma asumidas).

## Al cambiar un parser o una regla

- Agrega o actualiza el fixture en `test/fixtures/` y su prueba; un cambio de regla en `normalize.js` lleva prueba en `test/normalize.test.js`.
- Para agregar o reparar una tienda, sigue la skill `agregar-tienda`; para verificar contra sitios reales, `probar-sku`.
