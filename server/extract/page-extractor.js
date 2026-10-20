/**
 * extractPage — se ejecuta DENTRO del navegador (page.evaluate). Autocontenida.
 * Recibe scanJson como argumento (ver buildExtractorScript) y devuelve candidatos
 * desde 3 fuentes: JSON-LD (schema.org), estado embebido (Next/Nuxt/VTEX/…) y DOM visible.
 */
export function extractPage(scanJson, opts) {
  opts = opts || {};
  var result = { url: location.href, title: document.title, jsonld: [], embedded: [], dom: [], text: '' };
  var PRICE_RE = /\$\s*(\d{1,3}(?:,\d{3})+|\d{3,7})(?:\.(\d{2}))?/;
  // Se evalúa por token de clase para no confundir "font-bold" con "old".
  var STRIKE_TOKEN = /(^|[-_])(old|before|antes|tachad[oa]?|strike(through)?|line-through|previous|crossed|was|anterior)([-_]|$)|(list|regular|original|normal|old)[-_]?(price|precio)|(price|precio)[-_]+(list|regular|original|normal|before|old|was|anterior|lista)|a-text-price|previous/i;
  var INSTALL_CTX = /mes(es)?\b|quincen|semana|pagos? de|abono|\/mes|x\s*\$|\d+\s*x\b|cuotas|plazo/i;

  function abs(u) {
    if (!u) return null;
    try { return new URL(u, location.href).href; } catch (e) { return null; }
  }
  function txt(el) { return (el && (el.innerText || el.textContent) || '').replace(/\s+/g, ' ').trim(); }
  function parsePrice(s) {
    var m = PRICE_RE.exec(s || '');
    if (!m) return null;
    var n = parseFloat(m[1].replace(/,/g, '') + (m[2] ? '.' + m[2] : ''));
    return isFinite(n) ? n : null;
  }

  // ---------- 1) JSON-LD ----------
  function ldOffers(p) {
    var offers = p.offers;
    if (!offers) return {};
    if (Array.isArray(offers)) offers = offers[0] || {};
    if (offers['@type'] === 'AggregateOffer' && Array.isArray(offers.offers) && offers.offers.length) {
      var lp = offers.lowPrice;
      offers = offers.offers[0];
      if (lp && !offers.price) offers.price = lp;
    }
    var price = offers.price != null ? offers.price : (offers.lowPrice != null ? offers.lowPrice : (offers.priceSpecification && offers.priceSpecification.price));
    var seller = offers.seller && (offers.seller.name || offers.seller);
    var ship = offers.shippingDetails;
    if (Array.isArray(ship)) ship = ship[0];
    var shipCost = ship && ship.shippingRate && ship.shippingRate.value;
    return {
      price: price != null ? parseFloat(String(price).replace(/[^\d.]/g, '')) : null,
      currency: offers.priceCurrency || null,
      availability: offers.availability || null,
      url: offers.url || null,
      seller: typeof seller === 'string' ? seller : null,
      shippingCost: shipCost != null ? parseFloat(shipCost) : null,
      listPrice: (function () {
        var ps = offers.priceSpecification;
        if (Array.isArray(ps)) {
          for (var i = 0; i < ps.length; i++) if (/ListPrice|StrikethroughPrice/i.test(ps[i].priceType || '')) return parseFloat(ps[i].price);
        }
        return null;
      })()
    };
  }
  function pushLdProduct(p) {
    var o = ldOffers(p);
    var img = p.image;
    if (Array.isArray(img)) img = img[0];
    if (img && typeof img === 'object') img = img.url || img.contentUrl;
    var skus = [p.sku, p.mpn, p.model && (p.model.name || p.model), p.gtin13, p.gtin, p.productID].filter(function (x) { return typeof x === 'string' || typeof x === 'number'; }).map(String);
    var brand = p.brand && (p.brand.name || p.brand);
    result.jsonld.push({
      title: p.name || null,
      price: o.price,
      listPrice: o.listPrice,
      currency: o.currency,
      url: abs(o.url || p.url) || null,
      image: abs(img),
      skus: skus,
      brand: typeof brand === 'string' ? brand : null,
      seller: o.seller,
      available: o.availability ? !/OutOfStock|SoldOut|Discontinued/i.test(o.availability) : null,
      shippingCost: o.shippingCost,
      rawText: ''
    });
  }
  function walkLd(node) {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { node.forEach(walkLd); return; }
    if (node['@graph']) walkLd(node['@graph']);
    var t = node['@type'];
    var types = Array.isArray(t) ? t : [t];
    if (types.indexOf('Product') !== -1 || types.indexOf('IndividualProduct') !== -1 || types.indexOf('ProductGroup') !== -1) {
      pushLdProduct(node);
      if (node.hasVariant) walkLd(node.hasVariant);
      return;
    }
    if (types.indexOf('ItemList') !== -1 && Array.isArray(node.itemListElement)) {
      node.itemListElement.forEach(function (li) { walkLd(li.item || li); });
    }
    if (types.indexOf('ListItem') !== -1 && node.item) walkLd(node.item);
  }
  document.querySelectorAll('script[type="application/ld+json"]').forEach(function (s) {
    try { walkLd(JSON.parse(s.textContent)); } catch (e) { /* JSON-LD inválido */ }
  });

  // ---------- 2) Estado embebido ----------
  var blobs = [];
  var nd = document.getElementById('__NEXT_DATA__');
  if (nd) { try { blobs.push(JSON.parse(nd.textContent)); } catch (e) {} }
  ['__NUXT__', '__APOLLO_STATE__', '__PRELOADED_STATE__', '__INITIAL_STATE__', '__STATE__', '__APP_INITIAL_STATE__', '__RUNTIME_CONFIG__', 'dataLayer']
    .forEach(function (k) { try { if (window[k] && typeof window[k] === 'object') blobs.push(window[k]); } catch (e) {} });
  document.querySelectorAll('script[type="application/json"], template[data-type="json"], script[data-state]').forEach(function (s) {
    if (s.id === '__NEXT_DATA__') return;
    var t = s.textContent || '';
    if (t.length < 50 || t.length > 6e6) return;
    try { blobs.push(JSON.parse(t)); } catch (e) {}
  });
  // Next.js App Router (self.__next_f) — extrae fragmentos JSON con "price"
  try {
    if (window.__next_f && window.__next_f.length) {
      var joined = window.__next_f.map(function (x) { return x && x[1] || ''; }).join('');
      var re = /\{[^{}]*"(?:price|salePrice|sellingPrice)"\s*:\s*[^{}]*\}/g;
      var m, count = 0;
      while ((m = re.exec(joined)) && count < 400) { count++; try { blobs.push(JSON.parse(m[0])); } catch (e) {} }
    }
  } catch (e) {}
  blobs.forEach(function (b) {
    try { result.embedded = result.embedded.concat(scanJson(b, { max: 200 })); } catch (e) {}
  });
  result.embedded.forEach(function (p) {
    if (p.url && typeof p.url === 'string') p.url = abs(p.url);
    else if (p.url && p.url.slug) p.url = null;
    if (p.image) p.image = abs(p.image);
  });

  // ---------- 3) DOM visible ----------
  function visible(el) {
    if (!el.getClientRects().length) return false;
    var st = getComputedStyle(el);
    return st.visibility !== 'hidden' && st.display !== 'none';
  }
  function isStruck(el, root) {
    var cur = el;
    for (var i = 0; i < 3 && cur && cur !== root; i++) {
      var tag = cur.tagName;
      if (tag === 'S' || tag === 'DEL' || tag === 'STRIKE') return true;
      if (cur.getAttribute && cur.getAttribute('data-a-strike') === 'true') return true;
      var cls = ((cur.getAttribute && cur.getAttribute('class')) || '') + ' ' + ((cur.getAttribute && cur.getAttribute('data-testid')) || '');
      var toks = cls.split(/\s+/);
      for (var k = 0; k < toks.length; k++) if (toks[k] && STRIKE_TOKEN.test(toks[k])) return true;
      var st = getComputedStyle(cur);
      if ((st.textDecorationLine || st.textDecoration || '').indexOf('line-through') !== -1) return true;
      cur = cur.parentElement;
    }
    return false;
  }
  function inInstallment(el, root) {
    var cur = el;
    for (var i = 0; i < 3 && cur && cur !== root; i++) {
      var t = txt(cur);
      if (t.length < 120 && INSTALL_CTX.test(t)) return true;
      cur = cur.parentElement;
    }
    return false;
  }
  function productHref(a) {
    var h = a.getAttribute('href') || '';
    if (!h || h.charAt(0) === '#' || /^javascript:|^mailto:|^tel:/i.test(h)) return null;
    var u = abs(h);
    if (!u) return null;
    try {
      var x = new URL(u);
      if (/\/(login|cart|carrito|account|cuenta|ayuda|help|tiendas|stores|wishlist)(\/|$)/i.test(x.pathname)) return null;
      return x.origin + x.pathname;
    } catch (e) { return null; }
  }

  try {
    var anchors = Array.prototype.slice.call(document.querySelectorAll('a[href]')).filter(function (a) {
      return productHref(a) && visible(a);
    }).slice(0, 1500);
    var containers = [];
    anchors.forEach(function (a) {
      var cur = a;
      for (var i = 0; i < 8 && cur && cur !== document.body; i++) {
        var t = cur.innerText || '';
        if (t.length > 2500) break;
        if (PRICE_RE.test(t)) { if (containers.indexOf(cur) === -1) containers.push(cur); break; }
        cur = cur.parentElement;
      }
    });
    function hrefsOf(el) {
      var set = {};
      el.querySelectorAll('a[href]').forEach(function (a) { var h = productHref(a); if (h) set[h] = 1; });
      if (el.tagName === 'A') { var h = productHref(el); if (h) set[h] = 1; }
      return Object.keys(set);
    }
    // Quitar contenedores que agrupan varios productos y quedarse con el más grande de cada tarjeta.
    var cards = containers.filter(function (c) {
      var hs = hrefsOf(c);
      var prices = (c.innerText.match(new RegExp(PRICE_RE.source, 'g')) || []).length;
      return !(hs.length > 3 && prices > 3);
    });
    // Subir mientras el padre siga siendo "una sola tarjeta" (mismas hrefs, sin más precios distintos)
    cards = cards.map(function (c) {
      var base = hrefsOf(c);
      var cur = c;
      for (var i = 0; i < 4; i++) {
        var p = cur.parentElement;
        if (!p || p === document.body) break;
        var hs = hrefsOf(p);
        if (hs.length > Math.max(base.length, 3)) break;
        if (hs.some(function (h) { return base.indexOf(h) === -1; }) && hs.length > base.length) break;
        if ((p.innerText || '').length > 2500) break;
        cur = p;
      }
      return cur;
    });
    cards = cards.filter(function (c, i) { return cards.indexOf(c) === i; });
    cards = cards.filter(function (c) {
      return !cards.some(function (o) { return o !== c && o.contains(c); });
    });

    cards.slice(0, 120).forEach(function (card) {
      var hs = hrefsOf(card);
      var titleEl = null, best = '';
      card.querySelectorAll('h1,h2,h3,h4,a,[class*="title" i],[class*="name" i],[class*="nombre" i],[data-testid*="title" i],[itemprop="name"]').forEach(function (el) {
        var t = txt(el);
        if (t.length >= 8 && t.length <= 300 && !PRICE_RE.test(t) && t.length > best.length) { best = t; titleEl = el; }
      });
      if (!best) {
        // Respaldo: la línea de texto más larga que no sea precio ni rating
        (card.innerText || '').split('\n').forEach(function (line) {
          var t = line.replace(/\s+/g, ' ').trim();
          if (t.length >= 12 && t.length <= 300 && !PRICE_RE.test(t) && !/^\(?\d+\)?$/.test(t) && t.length > best.length) best = t;
        });
      }
      if (!best) return;
      var link = null;
      if (titleEl) { var a = titleEl.closest('a') || titleEl.querySelector('a'); if (a) link = productHref(a); }
      if (!link && hs.length) link = hs[0];
      var current = [], struck = [];
      card.querySelectorAll('*').forEach(function (el) {
        if (el.children.length > 6) return;
        var t = txt(el);
        if (!t || t.length > 40 || !PRICE_RE.test(t)) return;
        // descartar si algún hijo ya contiene el precio completo (quedarnos con la hoja)
        for (var i = 0; i < el.children.length; i++) if (PRICE_RE.test(txt(el.children[i]))) return;
        var p = parsePrice(t);
        if (p == null) return;
        if (inInstallment(el, card)) return;
        (isStruck(el, card) ? struck : current).push(p);
      });
      if (!current.length) return;
      var img = card.querySelector('img');
      var src = img && (img.currentSrc || img.getAttribute('src') || img.getAttribute('data-src') || (img.getAttribute('srcset') || '').split(' ')[0]);
      var raw = txt(card).slice(0, 1500);
      result.dom.push({
        title: best,
        price: current[0],
        listPrice: struck.length ? Math.max.apply(null, struck) : null,
        url: link,
        image: abs(src),
        skus: [],
        brand: null,
        seller: null,
        available: null,
        rawText: raw
      });
    });
  } catch (e) { result.domError = String(e && e.message || e); }

  result.text = txt(document.body).slice(0, 4000);
  return result;
}

/** Construye el script (string) que se inyecta en la página con ambas funciones. */
export function buildExtractorScript(scanJsonFn, extractPageFn, opts) {
  return '(' + extractPageFn.toString() + ')(' + scanJsonFn.toString() + ', ' + JSON.stringify(opts || {}) + ')';
}
