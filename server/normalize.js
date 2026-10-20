/**
 * Normalización de ofertas: match de SKU, envío, MSI, promo, disponibilidad y ranking.
 * Reglas acordadas:
 *  - Promo = etiqueta de promo de la tienda, MSI o envío gratis.
 *  - Precio tachado se muestra, pero solo es "promo" si la tienda lo marca como oferta/campaña.
 *  - Ranking por precio + envío visible. Envío desconocido va después de los de total conocido.
 *  - Agotados / sin envío a domicilio: se muestran atenuados y no cuentan.
 */

export function normSku(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** Limpia lo que escribe el usuario: quita espacios y caracteres raros, conserva / y - */
export function cleanSkuInput(raw) {
  return String(raw || '').trim().replace(/\s+/g, '').replace(/[^A-Za-z0-9/\-_.]/g, '').toUpperCase().slice(0, 40);
}

/** Variantes aceptadas del SKU: completo y base sin sufijo regional (RT38K5930S8/EM → RT38K5930S8). */
export function skuVariants(raw) {
  const full = normSku(raw);
  const set = new Set([full]);
  const base = normSku(String(raw).split(/[/]/)[0]);
  if (base.length >= 5) set.add(base);
  // Sufijos regionales comunes pegados (…S9EM, …WDAMX)
  const m = full.match(/^(.{6,}?)(EM|AP|AX|MX|XAX|AMX|AA|AFM)$/);
  if (m) set.add(m[1]);
  return [...set].filter((v) => v.length >= 5);
}

const FRIDGE_RE = /refri|frigo|fridge|congelador|freezer|french ?door|side ?by ?side|top ?mount|bottom ?freezer|duplex|d[uú]plex|pies|cu\.? ?ft|litros|\bl\b/i;
const PART_RE = /\b(tarjeta|placa|m[oó]dulo|main\s?board|pcb|refacci[oó]n|repuesto|pieza|compresor|evaporador|termostato|sensor|ventilador|motor|empaque|burlete|charola|cajon|caj[oó]n|filtro|control\s+remoto|inverter|fuente\s+de\s+poder|capacitor|rel[eé]|bobina|resistencia|funda|cubierta|imán|iman)\b/i;
const MODEL_TOKEN_RE = /[A-Z0-9][A-Z0-9\-/]{4,}[A-Z0-9]/gi;

function modelTokens(text) {
  return (String(text || '').match(MODEL_TOKEN_RE) || [])
    .map(normSku)
    .filter((t) => t.length >= 6 && /\d/.test(t) && /[A-Z]/.test(t));
}

function commonPrefix(a, b) {
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  return i;
}

/**
 * Devuelve 'exact' | 'similar' | 'unrelated'.
 */
export function matchType(offer, rawSku) {
  const variants = skuVariants(rawSku);
  const full = normSku(rawSku);
  const fromGoogle = offer.source === 'google';
  // Refacciones y accesorios nunca son el refrigerador (Google Shopping los mezcla con el modelo).
  if (fromGoogle && PART_RE.test(offer.title || '')) return 'unrelated';
  // En Google la URL es una búsqueda que contiene el SKU: no sirve como evidencia de match.
  const url = fromGoogle || !offer.url ? null : decodeURIComponentSafe(offer.url);
  const fields = [offer.title, ...(offer.skus || []), url, offer.model].filter(Boolean).join(' ');
  const hay = normSku(fields);
  if (variants.some((v) => v.length >= 6 && hay.includes(v))) return 'exact';
  if (offer.verified) return 'exact';
  // El modelo de la tienda es un prefijo del SKU del usuario (usuario escribió con sufijo extra)
  const tokens = modelTokens(fields);
  if (tokens.some((t) => full.startsWith(t) && t.length >= full.length - 3 && t.length >= 7)) return 'exact';
  const looksFridge = FRIDGE_RE.test(offer.title || '');
  const minPrefix = Math.max(4, Math.floor(full.length * 0.4));
  if (looksFridge && tokens.some((t) => commonPrefix(t, full) >= minPrefix)) return 'similar';
  // Mismo prefijo de modelo en texto crudo (p. ej. tarjetas sin modelo en título)
  if (looksFridge && modelTokens(offer.rawText).some((t) => commonPrefix(t, full) >= minPrefix + 1)) return 'similar';
  return 'unrelated';
}

function decodeURIComponentSafe(s) {
  try { return decodeURIComponent(s); } catch { return s; }
}

const FREE_SHIP_RE = /env[ií]o\s+(gratis|sin\s+costo|gratuito)|entrega\s+gratis|free\s+shipping|env[ií]o\s+incluido|env[ií]o\s+gratuito/i;
const FREE_SHIP_COND_RE = /(env[ií]o\s+(gratis|sin\s+costo)|entrega\s+gratis)\s+(con|a\s+partir|en\s+compras|por\s+compras|para\s+socios|en\s+pedidos|arriba)/i;
const PAID_SHIP_RE = /(?:costo\s+de\s+)?env[ií]o(?:\s+est[aá]ndar)?\s*[:+]?\s*\$\s?(\d{1,3}(?:,\d{3})*(?:\.\d{2})?|\d+(?:\.\d{2})?)/i;
const MSI_RE = /(\d{1,2})\s*(?:meses\s+sin\s+intereses|msi\b)/i;
const MSI_ANY_RE = /\bmsi\b|meses\s+sin\s+intereses/i;
const OUT_RE = /\bagotado\b|sin\s+existencias?|out\s+of\s+stock|temporalmente\s+(sin|no)|sin\s+stock|producto\s+no\s+disponible|no\s+disponible\s+en\s+l[ií]nea|currently\s+unavailable/i;
const NO_DELIVERY_RE = /s[oó]lo\s+(disponible\s+)?(en\s+tienda|para\s+recoger)|no\s+disponible\s+para\s+env[ií]o|sin\s+env[ií]o\s+a\s+domicilio|solo\s+recoger/i;
const USED_RE = /\busad[oa]s?\b|reacondicionad[oa]|seminuev[oa]|open\s*box|de\s+exhibici[oó]n|\brefurbished\b/i;
// Etiquetas que las tiendas usan para marcar campañas/ofertas.
const PROMO_LABELS = [
  [/ofertas?\s+del\s+d[ií]a/i, 'Oferta del día'],
  [/oferta\s+rel[aá]mpago/i, 'Oferta relámpago'],
  [/oferta\s+por\s+tiempo\s+limitado/i, 'Oferta por tiempo limitado'],
  [/hot\s*sale/i, 'Hot Sale'],
  [/buen\s*fin/i, 'Buen Fin'],
  [/black\s*friday/i, 'Black Friday'],
  [/cyber\s*(monday|week|days)?/i, 'Cyber'],
  [/prime\s+day/i, 'Prime Day'],
  [/liquidaci[oó]n/i, 'Liquidación'],
  [/\boutlet\b/i, 'Outlet'],
  [/precio\s+especial/i, 'Precio especial'],
  [/\bcup[oó]n\b/i, 'Cupón'],
  [/descuento\s+(extra|adicional)/i, 'Descuento extra'],
  [/paga\s+en\s+(enero|febrero|marzo)/i, 'Paga después'],
  [/\b2\s*x\s*1\b/i, '2x1'],
  [/\bremate\b/i, 'Remate'],
  [/\brebaja\b/i, 'Rebaja'],
  [/\bpromoci[oó]n\b|\bpromo\b/i, 'Promoción'],
  [/\boferta\b/i, 'Oferta']
];

export function parseMoney(s) {
  if (s == null) return null;
  if (typeof s === 'number') return isFinite(s) ? s : null;
  const m = String(s).replace(/\s/g, '').match(/(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d{1,2}))?/);
  if (!m) return null;
  const n = parseFloat(m[1].replace(/,/g, '') + (m[2] ? '.' + m[2] : ''));
  return isFinite(n) ? n : null;
}

export function classifyShipping(offer, store) {
  const text = [offer.rawText, ...(offer.badges || []), offer.shippingText].filter(Boolean).join(' | ');
  if (offer.shippingCost != null && isFinite(offer.shippingCost)) {
    return offer.shippingCost === 0
      ? { status: 'free', cost: 0, label: 'Envío gratis' }
      : { status: 'paid', cost: offer.shippingCost, label: 'Envío ' + fmt(offer.shippingCost) };
  }
  if (FREE_SHIP_COND_RE.test(text)) {
    const m = text.match(FREE_SHIP_COND_RE);
    return { status: 'conditional', cost: null, label: 'Envío gratis con condiciones', note: capitalize(cut(text.slice(m.index), 80)) };
  }
  if (FREE_SHIP_RE.test(text)) return { status: 'free', cost: 0, label: 'Envío gratis' };
  const paid = text.match(PAID_SHIP_RE);
  if (paid) {
    const cost = parseMoney(paid[1]);
    if (cost != null && cost < (offer.price || Infinity) * 0.5) return { status: 'paid', cost, label: 'Envío ' + fmt(cost) };
  }
  const pol = store && store.shippingPolicy;
  if (pol && pol.freeOver != null && offer.price >= pol.freeOver) {
    return { status: 'free', cost: 0, label: 'Envío gratis', note: pol.note || `Política de la tienda: gratis desde ${fmt(pol.freeOver)}` };
  }
  return { status: 'unknown', cost: null, label: 'Envío por confirmar' };
}

export function classifyInstallments(offer) {
  const text = [offer.rawText, ...(offer.badges || []), offer.installmentsText].filter(Boolean).join(' | ');
  if (offer.msiMonths) return { months: offer.msiMonths, label: `${offer.msiMonths} MSI` };
  const m = text.match(MSI_RE);
  if (m) return { months: Number(m[1]), label: `${Number(m[1])} MSI` };
  if (MSI_ANY_RE.test(text)) return { months: null, label: 'MSI' };
  return null;
}

export function promoLabels(offer) {
  const text = [...(offer.badges || []), offer.rawText, offer.promoText].filter(Boolean).join(' | ');
  const found = [];
  for (const [re, label] of PROMO_LABELS) {
    if (re.test(text) && !found.includes(label)) {
      // "Oferta" genérico solo si no hay una etiqueta más específica
      if (label === 'Oferta' && found.length) continue;
      if (label === 'Promoción' && found.length) continue;
      found.push(label);
    }
  }
  return found;
}

export function classifyAvailability(offer) {
  const text = [offer.rawText, ...(offer.badges || [])].filter(Boolean).join(' | ');
  if (offer.available === false || OUT_RE.test(text)) return { available: false, reason: 'Agotado' };
  if (NO_DELIVERY_RE.test(text)) return { available: false, reason: 'Sin envío a domicilio' };
  if (USED_RE.test(`${offer.title || ''} | ${text}`)) return { available: false, reason: 'Usado o reacondicionado' };
  return { available: true, reason: null };
}

/** Convierte un candidato crudo en oferta normalizada. */
export function normalizeOffer(raw, store, rawSku) {
  const price = round2(raw.price);
  let listPrice = raw.listPrice != null ? round2(raw.listPrice) : null;
  if (listPrice != null && (listPrice <= price || listPrice > price * 4)) listPrice = null;
  const shipping = classifyShipping({ ...raw, price }, store);
  const installments = classifyInstallments(raw);
  const labels = promoLabels(raw);
  const avail = classifyAvailability(raw);
  const reasons = [...labels];
  if (installments) reasons.push(installments.label);
  if (shipping.status === 'free') reasons.push('Envío gratis');
  const discountPct = listPrice ? Math.round((1 - price / listPrice) * 100) : null;
  const sellerType = raw.sellerType || store.sellerType || 'official';
  const total = shipping.status === 'paid' && shipping.cost != null ? round2(price + shipping.cost) : price;
  return {
    id: hash(`${store.id}|${raw.url || raw.title}`),
    storeId: store.id,
    store: raw.storeName || store.name,
    title: cut(raw.title, 220),
    url: raw.url || null,
    image: raw.image || null,
    price,
    listPrice,
    discountPct: discountPct && discountPct >= 1 ? discountPct : null,
    discountIsPromo: !!(listPrice && labels.length),
    shipping,
    total,
    totalKnown: shipping.status === 'free' || shipping.status === 'paid',
    installments,
    promo: { has: reasons.length > 0, reasons, labels },
    available: avail.available,
    unavailableReason: avail.reason,
    seller: raw.seller ? cut(raw.seller, 60) : null,
    sellerType,
    source: raw.source || store.source || 'store',
    match: matchType(raw, rawSku),
    verified: !!raw.verified
  };
}

/** Orden: disponibles con total conocido → disponibles con envío por confirmar → no disponibles. */
export function rankOffers(offers) {
  return [...offers].sort((a, b) => {
    if (a.available !== b.available) return a.available ? -1 : 1;
    if (a.totalKnown !== b.totalKnown) return a.totalKnown ? -1 : 1;
    if (a.total !== b.total) return a.total - b.total;
    return a.price - b.price;
  });
}

export function isThirdParty(o) {
  return o.sellerType === 'third_party' || o.sellerType === 'unverified';
}

export function pickBest(offers, { excludeThirdParty = false } = {}) {
  const eligible = rankOffers(offers.filter((o) => o.match === 'exact' && o.available && (!excludeThirdParty || !isThirdParty(o))));
  return eligible[0] || null;
}

/** Elimina duplicados (misma tienda + misma URL o mismo título y precio). */
export function dedupeOffers(offers) {
  const seen = new Map();
  for (const o of offers) {
    const key = o.storeId + '|' + (o.url ? o.url.split('?')[0].toLowerCase().replace(/\/$/, '') : normSku(o.title) + o.price);
    const prev = seen.get(key);
    if (!prev || (prev.match !== 'exact' && o.match === 'exact') || (prev.match === o.match && o.total < prev.total)) seen.set(key, o);
  }
  return [...seen.values()];
}

export function fmt(n) {
  return '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
function round2(n) { return Math.round(Number(n) * 100) / 100; }
function cut(s, n) { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
function capitalize(s) { return s ? s.charAt(0).toUpperCase() + s.slice(1) : s; }
function hash(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(36);
}
