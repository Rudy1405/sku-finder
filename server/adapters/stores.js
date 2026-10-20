import { storeAdapter, finalizeCustom } from './base.js';
import { openAndExtract, mergeCandidates } from '../extract/index.js';

const enc = encodeURIComponent;

// ---------- Parsers propios (se ejecutan en el navegador) ----------

function amazonParse(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    return [...document.querySelectorAll('[data-component-type="s-search-result"][data-asin]')]
      .filter((x) => x.dataset.asin)
      .map((x) => {
        const h2 = x.querySelector('h2');
        const title = clean((h2 && (h2.getAttribute('aria-label') || h2.innerText)) || '');
        const cur = x.querySelector('.a-price:not(.a-text-price) .a-offscreen');
        const old = x.querySelector('.a-price.a-text-price .a-offscreen');
        const img = x.querySelector('img.s-image');
        const badges = [...x.querySelectorAll('.a-badge-text, .a-badge-label-inner, .s-coupon-unclipped, [data-component-type="s-coupon-component"]')]
          .map((e) => clean(e.innerText)).filter(Boolean);
        const text = clean(x.innerText);
        return {
          title,
          priceText: cur && cur.textContent,
          listText: old && old.textContent,
          url: location.origin + '/dp/' + x.dataset.asin,
          image: img && img.getAttribute('src'),
          badges,
          skus: [x.dataset.asin],
          available: /no disponible por el momento|currently unavailable/i.test(text) ? false : null,
          rawText: text.replace(/Patrocinado.*?búsqueda\.|Deja comentarios sobre el anuncio/g, '').slice(0, 1200)
        };
      });
  });
}

async function amazonVerifySeller(page) {
  return page.evaluate(() => {
    const pick = (sel) => { const e = document.querySelector(sel); return e ? e.innerText.replace(/\s+/g, ' ').trim() : ''; };
    const merchant = pick('#merchantInfoFeature_feature_div') || pick('#merchant-info') || pick('[offer-display-feature-name="desktop-merchant-info"]') || pick('#tabular-buybox');
    const avail = pick('#availability');
    const delivery = pick('#mir-layout-DELIVERY_BLOCK') || pick('#deliveryBlockMessage');
    const m = merchant.match(/Vendido por\s*:?\s*(.+?)(?:\s+y\s+|\s*$|\s+Enviado)/i) || merchant.match(/Vendido por\s*:?\s*(.+)/i);
    const seller = m ? m[1].trim().slice(0, 60) : (merchant.replace(/^.*Vendido por/i, '').trim().slice(0, 60) || null);
    return { seller, merchant, avail, delivery };
  }).then((r) => ({
    seller: r.seller,
    sellerType: !r.seller ? null : /amazon/i.test(r.seller) ? 'official' : 'third_party',
    available: /no disponible|unavailable/i.test(r.avail) ? false : null,
    extraText: r.delivery
  }));
}

function mercadoLibreParse(page) {
  return page.evaluate(() => {
    const clean = (s) => (s || '').replace(/\s+/g, ' ').trim();
    const label = (el) => (el ? (el.getAttribute('aria-label') || el.innerText) : null);
    const cards = [...document.querySelectorAll('li.ui-search-layout__item, div.ui-search-result__wrapper')];
    return cards.map((x) => {
      const a = x.querySelector('a.poly-component__title, h3 a, h2 a, a.ui-search-link');
      const t = x.querySelector('.poly-component__title, .ui-search-item__title');
      const cur = x.querySelector('.poly-price__current .andes-money-amount, .ui-search-price__second-line .andes-money-amount');
      const prev = x.querySelector('.andes-money-amount--previous');
      const seller = x.querySelector('.poly-component__seller, .ui-search-official-store-label');
      const official = !!(seller && (seller.querySelector('svg') || /tienda oficial|official/i.test(seller.innerText)));
      const hl = x.querySelector('.poly-component__highlight, .ui-search-item__highlight-label');
      const img = x.querySelector('img');
      return {
        title: clean(t && t.innerText),
        priceText: label(cur),
        listText: label(prev),
        url: a && a.href,
        image: img && (img.getAttribute('data-src') || img.getAttribute('src')),
        seller: seller ? clean(seller.innerText).replace(/^(por|vendido por)\s+/i, '') : null,
        sellerType: official ? 'official' : 'third_party',
        badges: [hl && clean(hl.innerText)].filter(Boolean),
        rawText: clean(x.innerText).slice(0, 1200)
      };
    });
  });
}

/** Walmart, Sam's y Bodega Aurrera comparten plataforma (Next.js con itemStacks). */
function walmartParse(page) {
  return page.evaluate(() => {
    const nd = document.getElementById('__NEXT_DATA__');
    if (!nd) return [];
    let j;
    try { j = JSON.parse(nd.textContent); } catch (e) { return []; }
    const sr = j && j.props && j.props.pageProps && j.props.pageProps.initialData && j.props.pageProps.initialData.searchResult;
    const stacks = (sr && sr.itemStacks) || [];
    const items = [];
    stacks.forEach((s) => (s.items || []).forEach((i) => { if (i && i.name && i.priceInfo) items.push(i); }));
    return items.map((i) => {
      const b = i.badges || {};
      const texts = []
        .concat((b.flags || []).map((f) => f.text))
        .concat((b.tags || []).map((f) => f.text))
        .concat((b.groups || []).flatMap((g) => (g.members || []).map((m) => m.text || m.content)))
        .filter(Boolean);
      const av = i.availabilityStatusV2 && i.availabilityStatusV2.value;
      return {
        title: i.name,
        priceText: i.priceInfo.linePrice || i.priceInfo.itemPrice,
        listText: i.priceInfo.wasPrice,
        url: i.canonicalUrl ? location.origin + i.canonicalUrl.split('?')[0] : null,
        image: i.imageInfo && i.imageInfo.thumbnailUrl,
        seller: i.sellerName || null,
        sellerType: i.sellerType === 'EXTERNAL' ? 'third_party' : 'official',
        badges: texts.filter((t) => !/en el carrito de|comprado .* veces/i.test(t)),
        installmentsText: i.priceInfo.subscriptionString || '',
        skus: [i.usItemId, i.id].filter(Boolean).map(String),
        available: av ? !/OUT_OF_STOCK|UNAVAILABLE/i.test(av) : null,
        rawText: texts.join(' | ') + (i.shortDescription ? ' | ' + String(i.shortDescription).slice(0, 300) : '')
      };
    });
  });
}

// ---------- VTEX (Elektra, Chedraui): API pública de catálogo, con respaldo en navegador ----------

function vtexItems(json, origin) {
  if (!Array.isArray(json)) return [];
  return json.map((p) => {
    const item = (p.items || [])[0] || {};
    const sellers = item.sellers || [];
    const seller = sellers.find((s) => s.sellerDefault) || sellers[0] || {};
    const offer = seller.commertialOffer || {};
    const nm = (x) => x && (x['<Name>k__BackingField'] || x.Name || x.name);
    const badges = []
      .concat((offer.DiscountHighLight || []).map(nm))
      .concat((offer.Teasers || []).map(nm))
      .concat((offer.PromotionTeasers || []).map(nm))
      .concat(Object.values(p.clusterHighlights || {}))
      .filter(Boolean);
    const msi = (offer.Installments || []).filter((i) => !i.InterestRate).reduce((m, i) => Math.max(m, i.NumberOfInstallments || 0), 0);
    let url = p.link || (p.linkText ? `${origin}/${p.linkText}/p` : null);
    if (url && url.startsWith('/')) url = origin + url;
    return {
      title: p.productName,
      price: offer.Price,
      listPrice: offer.ListPrice || offer.PriceWithoutDiscount,
      url,
      image: item.images && item.images[0] && item.images[0].imageUrl,
      skus: [p.productReference, item.ean, item.name, ...(item.referenceId || []).map((r) => r.Value)].filter(Boolean).map(String),
      brand: p.brand,
      seller: seller.sellerName || null,
      sellerType: seller.sellerId && seller.sellerId !== '1' ? 'third_party' : 'official',
      available: offer.AvailableQuantity != null ? offer.AvailableQuantity > 0 : offer.IsAvailable,
      badges,
      msiMonths: msi > 1 ? msi : null,
      rawText: badges.join(' | ')
    };
  }).filter((x) => x.title && x.price > 0);
}

function vtexAdapter(cfg) {
  const base = storeAdapter({
    ...cfg,
    searchUrl: (q) => `${cfg.origin}/${enc(q)}?_q=${enc(q)}&map=ft`
  });
  return {
    ...base,
    async search(ctx) {
      const apiUrl = `${cfg.origin}/api/catalog_system/pub/products/search?ft=${enc(ctx.query)}&_from=0&_to=23`;
      try {
        const res = await fetch(apiUrl, {
          headers: { 'User-Agent': ctx.userAgent, Accept: 'application/json', 'Accept-Language': 'es-MX,es;q=0.9' },
          signal: AbortSignal.timeout(15000)
        });
        if (res.ok && /json/.test(res.headers.get('content-type') || '')) {
          const items = vtexItems(await res.json(), cfg.origin);
          if (items.length) return { status: 'ok', searchUrl: base.searchUrl(ctx.query), parser: 'api', candidates: items };
        }
      } catch (e) {
        ctx.log(`${cfg.id}: API VTEX no respondió (${e.message}); uso el navegador`);
      }
      return base.search(ctx);
    }
  };
}

// ---------- Registro de tiendas ----------

export const STORES = [
  storeAdapter({
    id: 'amazon', name: 'Amazon México', domain: 'amazon.com.mx', group: 'Marketplaces',
    sellerType: 'unknown',
    searchUrl: (q) => `https://www.amazon.com.mx/s?k=${enc(q)}&language=es_MX`,
    extract: { waitFor: '[data-component-type="s-search-result"]' },
    parse: amazonParse,
    verifySeller: amazonVerifySeller
  }),
  storeAdapter({
    id: 'mercadolibre', name: 'Mercado Libre', domain: 'mercadolibre.com.mx', group: 'Marketplaces',
    sellerType: 'third_party',
    searchUrl: (q) => `https://listado.mercadolibre.com.mx/${enc(q.replace(/[/\s]+/g, '-'))}`,
    extract: { waitFor: 'li.ui-search-layout__item' },
    parse: mercadoLibreParse
  }),
  storeAdapter({
    id: 'walmart', name: 'Walmart', domain: 'walmart.com.mx', group: 'Marketplaces',
    searchUrl: (q) => `https://www.walmart.com.mx/search?q=${enc(q)}`,
    parse: walmartParse
  }),
  storeAdapter({
    id: 'liverpool', name: 'Liverpool', domain: 'liverpool.com.mx', group: 'Departamentales',
    searchUrl: (q) => `https://www.liverpool.com.mx/tienda?s=${enc(q)}`,
    extract: { waitFor: 'a[href*="/tienda/pdp/"]' }
  }),
  storeAdapter({
    id: 'palacio', name: 'El Palacio de Hierro', domain: 'elpalaciodehierro.com', group: 'Departamentales',
    searchUrl: (q) => `https://www.elpalaciodehierro.com/buscar?q=${enc(q)}`
  }),
  storeAdapter({
    id: 'sears', name: 'Sears', domain: 'sears.com.mx', group: 'Departamentales',
    searchUrl: (q) => `https://www.sears.com.mx/resultados?query=${enc(q)}`
  }),
  storeAdapter({
    id: 'sanborns', name: 'Sanborns', domain: 'sanborns.com.mx', group: 'Departamentales',
    searchUrl: (q) => `https://www.sanborns.com.mx/resultados?query=${enc(q)}`
  }),
  storeAdapter({
    id: 'costco', name: 'Costco', domain: 'costco.com.mx', group: 'Clubes',
    searchUrl: (q) => `https://www.costco.com.mx/search?text=${enc(q)}`,
    sourceOrder: ['network', 'jsonld', 'embedded', 'dom']
  }),
  storeAdapter({
    id: 'sams', name: "Sam's Club", domain: 'sams.com.mx', group: 'Clubes',
    searchUrl: (q) => `https://www.sams.com.mx/search?q=${enc(q)}`,
    parse: walmartParse
  }),
  storeAdapter({
    id: 'homedepot', name: 'The Home Depot', domain: 'homedepot.com.mx', group: 'Hogar / crédito',
    searchUrl: (q) => `https://www.homedepot.com.mx/s/${enc(q)}`
  }),
  storeAdapter({
    id: 'coppel', name: 'Coppel', domain: 'coppel.com', group: 'Hogar / crédito',
    searchUrl: (q) => `https://www.coppel.com/sd/${enc(q)}`,
    shippingPolicy: { freeOver: 599, note: 'Coppel: envío gratis desde $599' }
  }),
  vtexAdapter({
    id: 'elektra', name: 'Elektra', domain: 'elektra.mx', origin: 'https://www.elektra.mx', group: 'Hogar / crédito'
  }),
  vtexAdapter({
    id: 'chedraui', name: 'Chedraui', domain: 'chedraui.com.mx', origin: 'https://www.chedraui.com.mx', group: 'Hogar / crédito'
  }),
  storeAdapter({
    id: 'soriana', name: 'Soriana', domain: 'soriana.com', group: 'Hogar / crédito',
    searchUrl: (q) => `https://www.soriana.com/buscar?q=${enc(q)}`,
    extract: { scrollSteps: 6 }
  }),
  storeAdapter({
    id: 'bodega', name: 'Bodega Aurrera', domain: 'bodegaaurrera.com.mx', group: 'Hogar / crédito',
    searchUrl: (q) => `https://www.bodegaaurrera.com.mx/search?q=${enc(q)}`,
    parse: walmartParse
  })
];

/** Dominios ya cubiertos por adaptadores directos (para que el rastreo web no los repita). */
export const COVERED_DOMAINS = STORES.map((s) => s.domain);

const STORE_MATCH = {
  amazon: /amazon/i, mercadolibre: /mercado ?libre/i, walmart: /walmart/i, liverpool: /liverpool/i,
  palacio: /palacio de hierro/i, sears: /sears/i, sanborns: /sanborns/i, costco: /costco/i, sams: /sam'?s ?club/i,
  homedepot: /home ?depot/i, coppel: /coppel/i, elektra: /elektra/i, chedraui: /chedraui/i, soriana: /soriana/i,
  bodega: /bodega aurrera/i
};

/** Tiendas conocidas para clasificar resultados de Google Shopping / rastreo web. */
export const KNOWN_RETAILERS = [
  ...STORES.map((s) => ({ id: s.id, name: s.name, domain: s.domain, re: STORE_MATCH[s.id] })),
  { id: 'samsung', name: 'Samsung México', domain: 'samsung.com', re: /samsung/i },
  { id: 'lg', name: 'LG México', domain: 'lg.com', re: /^lg\b|lg electronics|lg\.com/i },
  { id: 'mabe', name: 'Mabe', domain: 'mabe.com.mx', re: /mabe/i },
  { id: 'whirlpool', name: 'Whirlpool', domain: 'whirlpool.mx', re: /whirlpool/i },
  { id: 'hisense', name: 'Hisense', domain: 'hisense.com.mx', re: /hisense/i },
  { id: 'midea', name: 'Midea', domain: 'midea.com', re: /midea/i },
  { id: 'officedepot', name: 'Office Depot', domain: 'officedepot.com.mx', re: /office ?depot/i },
  { id: 'claroshop', name: 'Claro Shop', domain: 'claroshop.com', re: /claro ?shop/i },
  { id: 'suburbia', name: 'Suburbia', domain: 'suburbia.com.mx', re: /suburbia/i },
  { id: 'bestbuy', name: 'Best Buy', domain: 'bestbuy.com.mx', re: /best ?buy/i },
  { id: 'heb', name: 'HEB', domain: 'heb.com.mx', re: /\bh-?e-?b\b/i },
  { id: 'lacomer', name: 'La Comer', domain: 'lacomer.com.mx', re: /la ?comer/i },
  { id: 'famsa', name: 'Famsa', domain: 'famsa.com', re: /famsa/i }
];

export { amazonVerifySeller, vtexItems, walmartParse, mercadoLibreParse, amazonParse };
export { openAndExtract, mergeCandidates, finalizeCustom };
