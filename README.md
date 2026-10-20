# SKU/FINDER — rastreador local de precios de refrigeradores

Escribe el SKU/modelo de un refrigerador y la app revisa tiendas con envío en México, te muestra cada oferta en una tarjeta (precio, tachado, envío, MSI, promo, vendedor) y guarda un **histórico rankeado por el menor precio encontrado**. Todo corre en tu computadora.

## Hecho con

- **Node.js 20+** (módulos ES) y **Express 5** para el servidor y la API local.
- **Playwright** (`playwright-core`) para abrir las tiendas con tu propio navegador.
- **Frontend plano** en HTML/CSS/JS (sin bundlers ni frameworks) con las fuentes Schibsted Grotesk e IBM Plex Mono.
- Histórico en un archivo JSON local (`data/db.json`); no hay base de datos que instalar.
- **SerpAPI** (opcional) para Google Shopping.

## Requisitos

- **Node.js 20 o superior** — https://nodejs.org (incluye `npm`)
- **Git**, para clonar el repositorio.
- **Google Chrome** o **Microsoft Edge** (ya viene con Windows). La app usa tu navegador en modo oculto; no descarga otro.
- Conexión a internet. Funciona en Windows, macOS y Linux.
- Opcional: una API key de SerpAPI para Google Shopping.

## Arranque

```bash
git clone https://github.com/Rudy1405/sku-finder.git
cd sku-finder
npm install
npm start
```

Abre **http://localhost:3737**. En Windows también puedes dar doble clic a `iniciar.bat`.

¿Algo no funciona? Corre `npm run doctor`: revisa Node, el navegador y si las tiendas responden.

## Qué revisa

| Grupo | Tiendas |
|---|---|
| Marketplaces | Amazon México, Mercado Libre, Walmart |
| Departamentales | Liverpool, El Palacio de Hierro, Sears, Sanborns |
| Clubes | Costco, Sam's Club |
| Hogar / crédito | The Home Depot, Coppel, Elektra, Chedraui, Soriana, Bodega Aurrera |
| Rastreo web | Busca el SKU en DuckDuckGo/Bing y lee el precio de otras tiendas mexicanas (sitios de marca, tiendas pequeñas) |
| Google Shopping | Opcional: define `SERPAPI_KEY` con tu API key de [SerpAPI](https://serpapi.com/) (plan gratis ≈100 búsquedas/mes). Ver [Variables opcionales](#variables-opcionales) |

Puedes apagar tiendas en **Ajustes**.

## Reglas que usa

- **Coincidencia:** solo cuentan los productos con el modelo exacto (acepta el SKU con o sin sufijo regional, p. ej. `RT38K5930S8` y `RT38K5930S8/EM`). Si una tienda no pone el modelo en el título, la app abre las primeras fichas y busca el SKU en la página. Los modelos parecidos aparecen aparte, en “Posibles coincidencias”.
- **Promo:** se marca cuando la tienda muestra una etiqueta de promoción (Oferta, Hot Sale, Buen Fin, Rebaja, Cupón…), cuando hay **meses sin intereses** o **envío gratis**. El precio tachado siempre se muestra con su % de descuento, pero por sí solo no cuenta como promo.
- **Precio para el ranking:** precio + envío cuando el envío es visible sin código postal. Las ofertas con “envío por confirmar” van después de las de total conocido.
- **Vendedores terceros y tiendas no verificadas:** cuentan, pero llevan etiqueta; el interruptor “Excluir terceros” los saca del ranking.
- **Agotados, usados/reacondicionados o sin envío a domicilio:** se muestran atenuados y no cuentan.
- **Histórico:** una fila por SKU. Cada búsqueda agrega un punto a su serie de precios (minigráfica), y la lista se ordena del mejor precio más bajo al más alto.

## Si una tienda aparece como “bloqueado”

Algunas tiendas detectan navegadores automatizados. En **Ajustes → Mostrar las ventanas mientras busca**, vuelve a rastrear y resuelve la verificación a mano una vez; la sesión se guarda en `data/browser-state.json` y las siguientes búsquedas suelen pasar en modo oculto.

## Datos

Todo vive en la carpeta `data/` (histórico en `data/db.json`). Bórrala para empezar de cero.

## Variables opcionales

| Variable | Para qué | Default |
|---|---|---|
| `PORT` | Puerto del servidor | `3737` |
| `BROWSER_CHANNEL` | `chrome`, `msedge` o `chromium` | prueba en ese orden |
| `CHROME_PATH` | Ruta a un ejecutable de Chrome específico | — |
| `CONCURRENCY` | Páginas abiertas en paralelo | `5` |
| `STORE_TIMEOUT_MS` | Tiempo máximo por página | `40000` |
| `SERPAPI_KEY` | API key de SerpAPI para activar Google Shopping | — |

### API keys

La app **nunca guarda ni muestra** tu API key: solo la lee del entorno. Copia `.env.example` a `.env`, pon tu key y reinicia. `.env` está en `.gitignore`; no lo subas ni compartas tu key. Cada persona usa la suya.

## Pruebas

```bash
npm test
```

Las pruebas del extractor usan páginas de ejemplo locales y un navegador real (se omiten si no hay navegador).

## Cómo está hecho

- `server/extract/` — extractor universal: JSON-LD (schema.org), JSON de red capturado, estado embebido (Next.js/Nuxt/VTEX) y tarjetas del DOM visible.
- `server/adapters/` — una entrada por tienda (URL de búsqueda + lector propio cuando hace falta: Amazon, Mercado Libre, Walmart/Sam's/Bodega, API VTEX de Elektra y Chedraui), rastreo web y Google Shopping.
- `server/normalize.js` — match de SKU, envío, MSI, promo, disponibilidad y ranking.
- `public/` — interfaz sin dependencias.

> Las tiendas cambian su HTML con frecuencia. Si una deja de dar resultados, el extractor universal suele seguir funcionando; si no, el ajuste está en `server/adapters/stores.js`.
