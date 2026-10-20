/**
 * scanJson — recorre cualquier JSON (respuestas de API, __NEXT_DATA__, estados embebidos)
 * y devuelve objetos "con forma de producto": nombre + precio + (url | sku | imagen).
 *
 * IMPORTANTE: esta función debe ser autocontenida (sin referencias externas) porque
 * también se serializa y se ejecuta dentro del navegador con page.evaluate.
 */
export function scanJson(root, opts) {
  opts = opts || {};
  var MAX = opts.max || 300;
  var MIN_PRICE = opts.minPrice || 300;
  var MAX_PRICE = opts.maxPrice || 1500000;
  var out = [];
  var seen = typeof WeakSet !== 'undefined' ? new WeakSet() : null;
  var visited = 0;

  var NAME_KEYS = ['name', 'productName', 'title', 'displayName', 'product_name', 'productTitle',
    'nombre', 'skuName', 'shortDescription', 'label'];
  var PRICE_KEYS = ['sellingPrice', 'salePrice', 'finalPrice', 'offerPrice', 'promoPrice', 'specialPrice',
    'discountPrice', 'priceWithDiscount', 'bestPrice', 'currentPrice', 'Price', 'price', 'precio',
    'precioFinal', 'precioPromocion', 'sale_price', 'final_price', 'lowPrice', 'priceValue', 'amount',
    'value', 'spotPrice', 'salesPrice'];
  var LIST_KEYS = ['listPrice', 'ListPrice', 'originalPrice', 'oldPrice', 'regularPrice', 'wasPrice',
    'priceWithoutDiscount', 'strikePrice', 'strikethroughPrice', 'compareAtPrice', 'basePrice',
    'normalPrice', 'precioLista', 'precioRegular', 'beforePrice', 'original_price', 'list_price',
    'highPrice', 'PriceWithoutDiscount', 'previousPrice', 'fullPrice'];
  var URL_KEYS = ['url', 'productUrl', 'link', 'href', 'permalink', 'canonicalUrl', 'pdpUrl', 'seoUrl',
    'productURL', 'urlProducto', 'canonical', 'detailUrl', 'linkText', 'slug', 'productSlug', 'canonicalURL'];
  var IMG_KEYS = ['image', 'imageUrl', 'imageURL', 'thumbnail', 'thumbnailUrl', 'img', 'images', 'mainImage',
    'smallImage', 'picture', 'pictures', 'imagen', 'imageUrls', 'media', 'thumbnailImage'];
  var SKU_KEYS = ['sku', 'mpn', 'model', 'modelo', 'modelNumber', 'productReference', 'refId', 'ean', 'gtin',
    'gtin13', 'upc', 'partNumber', 'manufacturerPartNumber', 'skuId', 'productId', 'itemId', 'id',
    'usItemId', 'catalogEntryId', 'code', 'codigo', 'productCode', 'reference', 'Reference'];
  var NOT_PRICE_CONTEXT = /install|cuota|mensual|monthly|quincen|semanal|weekly|tax|iva|shipping|envio|delivery|point|monedero|cashback|rating|review/i;

  function num(v) {
    if (v == null) return null;
    if (typeof v === 'number') return isFinite(v) ? v : null;
    if (typeof v === 'string') {
      var s = v.replace(/[^\d.,-]/g, '');
      if (!s) return null;
      if (/,\d{3}(\D|$)/.test(s) && s.indexOf('.') === -1 && !/,\d{1,2}$/.test(s)) s = s.replace(/,/g, '');
      else if (/\.\d{3},\d{1,2}$/.test(s)) s = s.replace(/\./g, '').replace(',', '.');
      else s = s.replace(/,/g, '');
      var n = parseFloat(s);
      return isFinite(n) ? n : null;
    }
    return null;
  }
  function okPrice(n) { return n != null && n >= MIN_PRICE && n <= MAX_PRICE; }
  function str(v) {
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number') return String(v);
    return null;
  }
  function pickStr(o, keys, minLen, maxLen) {
    for (var i = 0; i < keys.length; i++) {
      var v = o[keys[i]];
      if (v && typeof v === 'object' && !Array.isArray(v)) v = v.text || v.value || v.es || v.name || v.default;
      var s = str(v);
      if (s && s.length >= (minLen || 1) && s.length <= (maxLen || 400) && !/^https?:\/\//.test(s)) return s;
    }
    return null;
  }
  function pickImg(o) {
    for (var i = 0; i < IMG_KEYS.length; i++) {
      var v = o[IMG_KEYS[i]];
      if (!v) continue;
      if (Array.isArray(v)) v = v[0];
      if (v && typeof v === 'object') v = v.url || v.src || v.imageUrl || v.secure_url || v.href || v.large || v.medium || v.thumbnail || v.contentUrl;
      if (typeof v === 'string' && (/^(https?:)?\/\//.test(v) || /\.(jpe?g|png|webp|avif)/i.test(v))) return v;
    }
    return null;
  }
  function pickUrl(o) {
    for (var i = 0; i < URL_KEYS.length; i++) {
      var k = URL_KEYS[i];
      var v = o[k];
      if (v && typeof v === 'object' && !Array.isArray(v)) v = v.url || v.href || v.path || v.canonical;
      if (typeof v !== 'string' || !v || v.length > 600) continue;
      if (/\.(jpe?g|png|webp|gif|svg|avif)(\?|$)/i.test(v)) continue;
      if (k === 'linkText') return '/' + v.replace(/^\//, '') + '/p';
      if ((k === 'slug' || k === 'productSlug') && !/\//.test(v)) return { slug: v };
      if (/^(https?:)?\/\//.test(v) || v.charAt(0) === '/') return v;
    }
    return null;
  }

  // Busca un precio dentro de un objeto, bajando por llaves "de precio" hasta cierta profundidad.
  function findPrice(o, keys, depth, ctx) {
    if (!o || typeof o !== 'object' || depth < 0) return null;
    if (Array.isArray(o)) {
      for (var a = 0; a < Math.min(o.length, 4); a++) {
        var r = findPrice(o[a], keys, depth, ctx); // los arreglos no consumen profundidad
        if (r != null) return r;
      }
      return null;
    }
    for (var i = 0; i < keys.length; i++) {
      var k = keys[i];
      if (!(k in o)) continue;
      if ((k === 'value' || k === 'amount') && !ctx) continue; // solo dentro de un contenedor de precio
      var v = o[k];
      if (v && typeof v === 'object') {
        var inner = findPrice(v, keys.concat(['value', 'amount', 'price']), 2, true);
        if (okPrice(inner)) return inner;
        continue;
      }
      var n = num(v);
      if (okPrice(n)) return n;
    }
    for (var key in o) {
      if (!Object.prototype.hasOwnProperty.call(o, key)) continue;
      if (NOT_PRICE_CONTEXT.test(key)) continue;
      if (!/price|precio|offer|pricing|item|seller|commert|sku|variant|buybox|prices/i.test(key)) continue;
      var child = o[key];
      if (!child || typeof child !== 'object') continue;
      var res = findPrice(child, keys, depth - 1, /price|precio|pricing/i.test(key) || ctx);
      if (res != null) return res;
    }
    return null;
  }

  function collectText(o, depth, acc) {
    if (acc.len > 2500 || depth < 0 || o == null) return;
    if (typeof o === 'string') {
      if (o.length < 200 && !/^https?:/.test(o)) { acc.parts.push(o); acc.len += o.length; }
      return;
    }
    if (typeof o !== 'object') return;
    if (Array.isArray(o)) { for (var i = 0; i < Math.min(o.length, 12); i++) collectText(o[i], depth - 1, acc); return; }
    for (var k in o) {
      if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
      if (/description|descripcion|html|script|seo|meta|breadcrumb|review/i.test(k)) continue;
      var v = o[k];
      if (typeof v === 'boolean' && v && /free.?ship|envio.?gratis|freeShipping/i.test(k)) { acc.parts.push('envío gratis'); continue; }
      if (typeof v === 'boolean' && /^(available|isAvailable|inStock)$/i.test(k) && !v) { acc.parts.push('agotado'); continue; }
      collectText(v, depth - 1, acc);
    }
  }

  function skuFields(o) {
    var res = [];
    for (var i = 0; i < SKU_KEYS.length; i++) {
      var v = o[SKU_KEYS[i]];
      if (typeof v === 'string' || typeof v === 'number') res.push(String(v));
    }
    // specs tipo [{name:'Modelo', value:'X'}]
    var specs = o.specifications || o.attributes || o.specs || o.properties || o.additionalProperty || o.caracteristicas;
    if (Array.isArray(specs)) {
      for (var s = 0; s < Math.min(specs.length, 60); s++) {
        var sp = specs[s];
        if (!sp || typeof sp !== 'object') continue;
        var nm = String(sp.name || sp.key || sp.label || sp.id || '');
        if (/model|modelo|sku|mpn|part/i.test(nm)) {
          var val = sp.value || sp.value_name || (sp.values && sp.values[0]) || sp.valor;
          if (val && typeof val === 'object') val = val.name || val.value;
          if (val != null) res.push(String(val));
        }
      }
    }
    return res.slice(0, 12);
  }

  function availability(o) {
    var keys = ['availability', 'available', 'isAvailable', 'inStock', 'AvailableQuantity', 'stock',
      'outOfStock', 'isOutOfStock', 'availabilityStatus', 'stockStatus', 'disponible', 'status'];
    for (var i = 0; i < keys.length; i++) {
      if (!(keys[i] in o)) continue;
      var v = o[keys[i]];
      if (typeof v === 'boolean') return /out/i.test(keys[i]) ? !v : v;
      if (typeof v === 'number') return /out/i.test(keys[i]) ? v === 0 : v > 0;
      if (typeof v === 'string') {
        if (/out.?of.?stock|outofstock|agotado|sin.?existencia|unavailable|no.?disponible|soldout|discontinued/i.test(v)) return false;
        if (/in.?stock|instock|available|disponible|limitedavailability|preorder/i.test(v)) return true;
      }
    }
    return null;
  }

  function considerProduct(o, path) {
    var name = pickStr(o, NAME_KEYS, 6, 350);
    if (!name) return false;
    var price = findPrice(o, PRICE_KEYS, 4, false);
    if (!okPrice(price)) return false;
    var url = pickUrl(o);
    var skus = skuFields(o);
    var img = pickImg(o);
    if (!url && !skus.length && !img) return false;
    var list = findPrice(o, LIST_KEYS, 4, false);
    if (list != null && (!okPrice(list) || list <= price)) list = null;
    var acc = { parts: [], len: 0 };
    collectText(o, 4, acc);
    var brand = o.brand || o.brandName || o.marca || o.manufacturer;
    if (brand && typeof brand === 'object') brand = brand.name || brand.title;
    var seller = o.seller || o.sellerName || o.soldBy || o.vendor || o.sellerDisplayName || o.merchantName;
    if (seller && typeof seller === 'object') seller = seller.name || seller.nickname || seller.sellerName || seller.displayName;
    if (Array.isArray(seller)) seller = null;
    out.push({
      title: name,
      price: price,
      listPrice: list,
      url: url,
      image: img,
      skus: skus,
      brand: typeof brand === 'string' ? brand : null,
      seller: typeof seller === 'string' ? seller : null,
      available: availability(o),
      rawText: acc.parts.join(' | ').slice(0, 2500),
      path: path
    });
    return true;
  }

  function walk(o, depth, path) {
    if (out.length >= MAX || visited > 200000 || depth > 40 || o == null || typeof o !== 'object') return;
    if (seen) { if (seen.has(o)) return; seen.add(o); }
    visited++;
    if (Array.isArray(o)) {
      for (var i = 0; i < o.length && i < 2000; i++) walk(o[i], depth + 1, path);
      return;
    }
    if (considerProduct(o, path)) return; // no bajar dentro de un producto ya capturado
    for (var k in o) {
      if (!Object.prototype.hasOwnProperty.call(o, k)) continue;
      var v = o[k];
      if (v && typeof v === 'object') walk(v, depth + 1, path ? path + '.' + k : k);
    }
  }

  walk(root, 0, '');
  return out;
}
