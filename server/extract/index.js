import { scanJson } from './scan-json.js';
import { extractPage, buildExtractorScript } from './page-extractor.js';

const EXTRACT_SCRIPT = buildExtractorScript(scanJson, extractPage, {});
const BLOCK_RE = /captcha|no eres un robot|not a robot|verify you are human|verifica que eres|unusual traffic|tr[aá]fico inusual|access denied|acceso denegado|pardon our interruption|request unsuccessful|are you a human|press (&|and) hold|px-captcha|attention required|robot check/i;
const NO_RESULTS_RE = /no (se )?encontr(amos|aron|é)|sin resultados|no hay resultados|0 resultados|no results|no obtuvimos resultados|intenta con otra b[uú]squeda|no coincide con ning[uú]n/i;

export { scanJson };

function absolutize(u, base) {
  if (!u || typeof u !== 'string') return null;
  try { return new URL(u, base).href; } catch { return null; }
}

/** Desplaza la página para disparar carga perezosa. */
export async function autoScroll(page, steps = 5) {
  for (let i = 0; i < steps; i++) {
    await page.evaluate(() => window.scrollBy(0, Math.round(window.innerHeight * 0.9))).catch(() => {});
    await page.waitForTimeout(350);
  }
  await page.evaluate(() => window.scrollTo(0, 0)).catch(() => {});
}

/**
 * Abre una URL, captura JSON de red, espera productos y extrae candidatos de todas las fuentes.
 */
export async function openAndExtract(page, url, opts = {}) {
  const net = [];
  const pending = [];
  const onResponse = (resp) => {
    try {
      const req = resp.request();
      const type = req.resourceType();
      if (type !== 'xhr' && type !== 'fetch') return;
      const ct = resp.headers()['content-type'] || '';
      if (!/json|graphql/i.test(ct)) return;
      const len = Number(resp.headers()['content-length'] || 0);
      if (len > 6e6) return;
      if (/analytics|collect|beacon|gtm|doubleclick|facebook|hotjar|newrelic|segment|optimizely|powerreviews|bazaarvoice|yotpo|cookielaw|onetrust/i.test(resp.url())) return;
      pending.push(resp.json().then((body) => net.push({ url: resp.url(), body })).catch(() => {}));
    } catch { /* no-op */ }
  };
  page.on('response', onResponse);
  let status = null;
  try {
    const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: opts.navTimeout || 25000 });
    status = resp ? resp.status() : null;
  } catch (e) {
    if (!/timeout/i.test(e.message)) throw e;
  }
  if (opts.waitFor) await page.waitForSelector(opts.waitFor, { timeout: 12000 }).catch(() => {});
  await page.waitForFunction(() => /\$\s?\d/.test(document.body ? document.body.innerText : ''), null, { timeout: opts.priceTimeout || 12000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  if (opts.scroll !== false) await autoScroll(page, opts.scrollSteps || 4);
  await page.waitForTimeout(opts.settleMs || 600);

  let res;
  try {
    res = await page.evaluate(EXTRACT_SCRIPT);
  } catch (e) {
    res = { url: page.url(), title: '', jsonld: [], embedded: [], dom: [], text: '', error: e.message };
  }
  page.off('response', onResponse);
  await Promise.race([Promise.allSettled(pending), page.waitForTimeout(1500)]);

  const base = page.url();
  const network = [];
  for (const n of net) {
    for (const p of scanJson(n.body, { max: 150 })) {
      if (p.url && typeof p.url === 'object') p.url = null;
      p.url = absolutize(p.url, base);
      p.image = absolutize(p.image, base);
      network.push(p);
    }
  }
  const siteName = await page.evaluate(() => {
    const m = document.querySelector('meta[property="og:site_name"]');
    return m ? m.content : null;
  }).catch(() => null);

  return {
    finalUrl: base,
    httpStatus: status,
    title: res.title,
    siteName,
    text: res.text || '',
    sources: { jsonld: res.jsonld || [], network, embedded: res.embedded || [], dom: res.dom || [] },
    blocked: BLOCK_RE.test(`${res.title} ${(res.text || '').slice(0, 1500)}`) || status === 403 || status === 429,
    noResults: NO_RESULTS_RE.test((res.text || '').slice(0, 4000))
  };
}

function keyOf(item) {
  if (item.url) {
    try {
      const u = new URL(item.url);
      return (u.hostname.replace(/^www\./, '') + u.pathname).toLowerCase().replace(/\/$/, '');
    } catch { /* ignore */ }
  }
  return 't:' + String(item.title || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
}

/**
 * Fusiona candidatos de todas las fuentes. El precio sale de la primera fuente de la lista
 * de prioridad; badges/textos se combinan para detectar envío, MSI y promos.
 */
export function mergeCandidates(sources, order = ['jsonld', 'network', 'embedded', 'dom']) {
  const map = new Map();
  for (const src of order) {
    for (const item of sources[src] || []) {
      if (!item || !item.title || item.price == null) continue;
      const k = keyOf(item);
      const prev = map.get(k);
      if (!prev) {
        map.set(k, { ...item, skus: [...(item.skus || [])], from: [src] });
        continue;
      }
      for (const f of ['url', 'image', 'brand', 'seller', 'listPrice', 'shippingCost']) if (prev[f] == null && item[f] != null) prev[f] = item[f];
      if (prev.available == null && item.available != null) prev.available = item.available;
      if (item.available === false) prev.available = false;
      prev.skus = [...new Set([...(prev.skus || []), ...(item.skus || [])])].slice(0, 15);
      prev.rawText = [prev.rawText, item.rawText].filter(Boolean).join(' | ').slice(0, 3000);
      if (!prev.from.includes(src)) prev.from.push(src);
    }
  }
  // Segunda pasada: candidatos sin URL se unen a uno con URL que tenga el mismo título.
  const norm = (t) => String(t || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 80);
  const withUrl = [...map.entries()].filter(([k]) => !k.startsWith('t:'));
  for (const [k, item] of [...map.entries()]) {
    if (!k.startsWith('t:')) continue;
    const twin = withUrl.find(([, o]) => norm(o.title) === norm(item.title));
    if (!twin) continue;
    const o = twin[1];
    if (o.listPrice == null) o.listPrice = item.listPrice;
    if (item.available === false) o.available = false;
    o.skus = [...new Set([...(o.skus || []), ...(item.skus || [])])].slice(0, 15);
    o.rawText = [o.rawText, item.rawText].filter(Boolean).join(' | ').slice(0, 3000);
    map.delete(k);
  }
  return [...map.values()];
}
