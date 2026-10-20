import { STORES } from './adapters/stores.js';
import { webDiscovery, googleShopping } from './adapters/web.js';
import { sameSite } from './adapters/base.js';
import { openAndExtract } from './extract/index.js';
import { withPage, persistState, scheduleIdleClose, getContext } from './browser.js';
import { getSettings, saveSnapshot } from './storage.js';
import { config } from './config.js';
import {
  cleanSkuInput, normSku, skuVariants, normalizeOffer, dedupeOffers, rankOffers, pickBest
} from './normalize.js';
import { createLimiter, withTimeout, slug, id as newId } from './util.js';

export const ADAPTERS = [...STORES, webDiscovery, googleShopping];

const jobs = new Map();
const FRIDGE_RE = /refri|frigo|fridge|congelador|freezer|french ?door|side ?by ?side|top ?mount|duplex|d[uú]plex/i;

export function listAdapters() {
  return ADAPTERS.map((a) => ({ id: a.id, name: a.name, group: a.group, kind: a.kind, requiresKey: !!a.requiresKey }));
}

export function getJob(jobId) {
  const j = jobs.get(jobId);
  if (!j) return null;
  return {
    id: j.id, sku: j.sku, status: j.status, startedAt: j.startedAt, finishedAt: j.finishedAt, error: j.error,
    stores: Object.values(j.stores), result: j.status === 'done' ? j.result : null
  };
}

export function startSearch(rawSku) {
  const sku = cleanSkuInput(rawSku);
  if (normSku(sku).length < 4) {
    const e = new Error('Escribe un SKU válido (mínimo 4 caracteres alfanuméricos).');
    e.status = 400;
    throw e;
  }
  for (const j of jobs.values()) if (j.sku === sku && j.status === 'running') return j.id;
  const job = { id: newId(), sku, status: 'running', startedAt: new Date().toISOString(), stores: {}, log: [], result: null, error: null };
  jobs.set(job.id, job);
  // Limpieza de trabajos viejos
  for (const [k, j] of jobs) if (Date.now() - Date.parse(j.startedAt) > 3600e3) jobs.delete(k);
  run(job).catch((e) => {
    job.status = 'error';
    job.error = e.message;
    job.finishedAt = new Date().toISOString();
    console.error('[search]', e);
  });
  return job.id;
}

function storeForCandidate(adapter, c) {
  if (!c.storeName) return adapter;
  const sid = c.storeKnownId || slug(c.storeHost || c.storeName);
  return { ...adapter, id: sid, name: c.storeName, sellerType: c.sellerType || adapter.sellerType };
}

async function run(job) {
  const t0 = Date.now();
  const settings = await getSettings();
  const headless = !settings.showBrowser;
  const disabled = new Set(settings.disabledStores || []);
  const adapters = ADAPTERS.filter((a) => !disabled.has(a.id));
  for (const a of adapters) job.stores[a.id] = { id: a.id, name: a.name, group: a.group, status: 'pending', count: 0 };

  // Abre el navegador una sola vez y obtiene su user agent para peticiones directas
  const context = await getContext({ headless });
  let userAgent = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';
  try {
    const p = await context.newPage();
    userAgent = await p.evaluate(() => navigator.userAgent);
    await p.close();
  } catch { /* no-op */ }

  const limit = createLimiter(config.concurrency);
  const pageRunner = (label) => (fn) => limit(() => withPage({ headless }, (page) => withTimeout(fn(page), config.storeTimeoutMs, label)));
  const log = (m) => { job.log.push(m); console.log('[search]', m); };

  const perStore = await Promise.all(adapters.map(async (adapter) => {
    const st = job.stores[adapter.id];
    st.status = 'running';
    const started = Date.now();
    const ctx = {
      sku: job.sku, query: job.sku, userAgent, log,
      serpapiKey: config.serpapiKey,
      withPage: pageRunner(adapter.name)
    };
    try {
      const r = await adapter.search(ctx);
      let offers = (r.candidates || []).map((c) => normalizeOffer(c, storeForCandidate(adapter, c), job.sku));

      // Verificación: si la tienda no muestra el modelo en el título, abre las primeras fichas y busca el SKU.
      if (adapter.verify && r.status === 'ok' && !offers.some((o) => o.match === 'exact')) {
        const toCheck = (r.candidates || [])
          .filter((c) => c.url && sameSite(c.url, adapter.domain) && FRIDGE_RE.test(c.title || ''))
          .slice(0, config.verifyPerStore);
        const verified = await verifyOnProductPage(ctx, toCheck, job.sku);
        for (const v of verified) offers.push(normalizeOffer(v, adapter, job.sku));
      }
      // Vendedor en marketplaces (Amazon): confirma quién vende las mejores ofertas.
      if (adapter.verifySeller) {
        const top = rankOffers(offers.filter((o) => o.match === 'exact' && o.available)).slice(0, 2);
        await Promise.all(top.map((o) => ctx.withPage(async (page) => {
          await page.goto(o.url, { waitUntil: 'domcontentloaded', timeout: 20000 });
          await page.waitForTimeout(800);
          const info = await adapter.verifySeller(page);
          if (info.sellerType) { o.sellerType = info.sellerType; o.seller = info.seller; }
          if (info.available === false) { o.available = false; o.unavailableReason = 'Agotado'; }
        }).catch((e) => log(`${adapter.id}: no pude confirmar vendedor (${e.message.split('\n')[0]})`))));
      }

      offers = dedupeOffers(offers);
      const exactCount = offers.filter((o) => o.match === 'exact').length;
      Object.assign(st, {
        status: r.status === 'ok' && !exactCount ? (offers.some((o) => o.match === 'similar') ? 'similar' : 'nomatch') : r.status,
        message: r.message || (r.status === 'ok' && !exactCount ? 'Sin el modelo exacto' : null),
        count: exactCount,
        searchUrl: r.searchUrl || null,
        parser: r.parser || null,
        ms: Date.now() - started
      });
      return offers;
    } catch (e) {
      Object.assign(st, { status: 'error', message: friendlyError(e), ms: Date.now() - started });
      log(`${adapter.id}: ${e.message.split('\n')[0]}`);
      return [];
    }
  }));

  let all = perStore.flat().filter((o) => o.match !== 'unrelated' && o.price > 0);
  // Google Shopping: si la tienda ya tiene resultado directo exacto, se queda el directo.
  const directExact = new Set(all.filter((o) => o.source === 'store' && o.match === 'exact').map((o) => o.storeId));
  all = all.filter((o) => !(o.source !== 'store' && directExact.has(o.storeId)));
  all = dedupeOffers(all);

  const exact = rankOffers(all.filter((o) => o.match === 'exact'));
  const similar = rankOffers(all.filter((o) => o.match === 'similar')).slice(0, 40);
  const best = pickBest(exact);
  const bestOfficial = pickBest(exact, { excludeThirdParty: true });

  const snapshot = {
    sku: job.sku,
    at: new Date().toISOString(),
    durationMs: Date.now() - t0,
    offers: exact,
    similar,
    stores: Object.values(job.stores),
    offerCount: exact.length,
    best: best ? slimBest(best) : null,
    bestOfficial: bestOfficial ? slimBest(bestOfficial) : null
  };
  // Si ninguna fuente respondió (sin internet, proxy, etc.) no ensuciamos el histórico.
  const answered = snapshot.stores.filter((s) => !['error', 'skipped'].includes(s.status)).length;
  snapshot.saved = answered > 0;
  if (snapshot.saved) await saveSnapshot(snapshot);
  job.result = snapshot;
  job.status = 'done';
  job.finishedAt = snapshot.at;
  persistState().finally(() => scheduleIdleClose());
}

function slimBest(o) {
  return {
    store: o.store, storeId: o.storeId, title: o.title, url: o.url, image: o.image,
    price: o.price, total: o.total, totalKnown: o.totalKnown, shipping: o.shipping.label,
    promo: o.promo.has, sellerType: o.sellerType
  };
}

async function verifyOnProductPage(ctx, candidates, rawSku) {
  const variants = skuVariants(rawSku);
  const out = [];
  await Promise.all(candidates.map((c) => ctx.withPage(async (page) => {
    const r = await openAndExtract(page, c.url, { scroll: false, priceTimeout: 8000, settleMs: 300 });
    const ld = r.sources.jsonld.find((p) => p.price) || null;
    const hay = normSku([r.text, ...(ld ? ld.skus : [])].join(' '));
    if (!variants.some((v) => hay.includes(v))) return;
    out.push({
      ...c,
      price: ld && ld.price ? ld.price : c.price,
      available: ld && ld.available === false ? false : c.available,
      skus: [...(c.skus || []), ...variants],
      verified: true
    });
  }).catch((e) => ctx.log(`verificación falló en ${c.url.slice(0, 60)}: ${e.message.split('\n')[0]}`))));
  return out;
}

function friendlyError(e) {
  const m = String(e && e.message || e);
  if (/ERR_NAME_NOT_RESOLVED|ERR_INTERNET_DISCONNECTED|ERR_TUNNEL|ERR_CONNECTION|ERR_PROXY|ENOTFOUND|ECONNREFUSED|ECONNRESET/i.test(m)) return 'No se pudo conectar con la tienda (revisa tu internet)';
  if (/Tiempo agotado|Timeout/i.test(m)) return 'La tienda tardó demasiado en responder';
  if (/ERR_HTTP2|ERR_ABORTED|ERR_BLOCKED/i.test(m)) return 'La tienda rechazó la conexión del navegador automatizado';
  return m.split('\n')[0].slice(0, 160);
}
