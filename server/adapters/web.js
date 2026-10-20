import { openAndExtract, mergeCandidates } from '../extract/index.js';
import { COVERED_DOMAINS, KNOWN_RETAILERS } from './stores.js';
import { hostOf } from './base.js';
import { normSku, skuVariants, parseMoney } from '../normalize.js';
import { pMap } from '../util.js';

const SKIP_HOSTS = /youtube|facebook|instagram|pinterest|tiktok|twitter|x\.com|wikipedia|reddit|manualslib|manualzz|scribd|issuu|google\.|bing\.|duckduckgo|yahoo|amazon\.com$|ebay\.com$|aliexpress|temu|shein|linkedin|quora|trustpilot|profeco|blog|foro|forum|retailmenot|cuponatic|promodescuentos|pricespy|idealo|kelkoo|ofertia|tiendeo/i;
const SKIP_URL = /\.pdf($|\?)|\/manual|\/support|\/soporte|\/blog\/|\/news|\/noticias|\/review|\/opiniones/i;

function prettyName(host, siteName) {
  if (siteName && siteName.length <= 40) return siteName.trim();
  const known = KNOWN_RETAILERS.find((k) => host === k.domain || host.endsWith('.' + k.domain));
  if (known) return known.name;
  const core = host.replace(/\.(com|net|org)?\.?mx$|\.(com|net|store|shop|mx)$/i, '').split('.').pop();
  return core.charAt(0).toUpperCase() + core.slice(1);
}

function isCovered(host) {
  return COVERED_DOMAINS.some((d) => host === d || host.endsWith('.' + d));
}

function looksMexican(url) {
  const h = hostOf(url);
  return /\.mx$/.test(h) || /\/(mx|es-mx|es_mx|mexico)(\/|$)/i.test(url) || KNOWN_RETAILERS.some((k) => h === k.domain || h.endsWith('.' + k.domain));
}

async function searchEngineLinks(page, query, log) {
  const links = [];
  let failures = 0;
  // 1) DuckDuckGo HTML (sin JS, región México)
  try {
    await page.goto(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}&kl=mx-es`, { waitUntil: 'domcontentloaded', timeout: 20000 });
    const ddg = await page.evaluate(() => [...document.querySelectorAll('a.result__a')].map((a) => a.href));
    for (const h of ddg) {
      try {
        const u = new URL(h);
        const real = u.searchParams.get('uddg');
        links.push(real ? decodeURIComponent(real) : h);
      } catch { /* ignore */ }
    }
  } catch (e) { failures++; log(`web: DuckDuckGo falló (${e.message.split('\n')[0]})`); }
  // 2) Bing como respaldo / complemento
  if (links.length < 5) {
    try {
      await page.goto(`https://www.bing.com/search?q=${encodeURIComponent(query)}&cc=MX&setlang=es-MX&mkt=es-MX`, { waitUntil: 'domcontentloaded', timeout: 20000 });
      const bing = await page.evaluate(() => [...document.querySelectorAll('li.b_algo h2 a')].map((a) => a.href));
      links.push(...bing);
    } catch (e) { failures++; log(`web: Bing falló (${e.message.split('\n')[0]})`); }
  }
  links.failures = failures;
  return links;
}

/**
 * Rastreo web: busca el SKU en buscadores, descarta tiendas ya cubiertas y visita páginas de
 * producto de otras tiendas mexicanas para leer su precio (JSON-LD / estado embebido / DOM).
 */
export const webDiscovery = {
  id: 'web',
  name: 'Otras tiendas (rastreo web)',
  group: 'Rastreo web',
  kind: 'discovery',
  sellerType: 'unverified',
  verify: false,
  async search(ctx) {
    const variants = skuVariants(ctx.sku);
    const links = await ctx.withPage((page) => searchEngineLinks(page, `"${ctx.query}" precio refrigerador`, ctx.log));
    if (!links.length && links.failures >= 2) throw new Error('No se pudo conectar con los buscadores (DuckDuckGo/Bing)');
    const seenHosts = new Set();
    const targets = [];
    for (const l of links) {
      const h = hostOf(l);
      if (!h || SKIP_HOSTS.test(h) || SKIP_URL.test(l) || isCovered(h) || seenHosts.has(h) || !looksMexican(l)) continue;
      seenHosts.add(h);
      targets.push(l);
      if (targets.length >= 8) break;
    }
    if (!targets.length) return { status: 'empty', candidates: [], message: 'El buscador no devolvió tiendas adicionales' };

    const results = await pMap(targets, (url) => ctx.withPage(async (page) => {
      try {
        const r = await openAndExtract(page, url, { scroll: false, priceTimeout: 8000, navTimeout: 20000 });
        const host = hostOf(r.finalUrl || url);
        const known = KNOWN_RETAILERS.find((k) => host === k.domain || host.endsWith('.' + k.domain));
        const storeName = prettyName(host, r.siteName);
        const cands = mergeCandidates(r.sources, ['jsonld', 'embedded', 'network', 'dom'])
          .filter((c) => {
            const hay = normSku([c.title, ...(c.skus || []), c.url].join(' '));
            return variants.some((v) => hay.includes(v));
          })
          .slice(0, 3)
          .map((c) => ({
            ...c,
            url: c.url || r.finalUrl,
            storeName,
            storeHost: host,
            sellerType: known ? 'official' : 'unverified',
            source: 'web'
          }));
        // Página de producto sin match en candidatos pero con el SKU en el texto: usa el primer precio JSON-LD
        if (!cands.length && r.sources.jsonld.length && variants.some((v) => normSku(r.text).includes(v))) {
          const p = r.sources.jsonld.find((x) => x.price);
          if (p) cands.push({ ...p, url: p.url || r.finalUrl, storeName, storeHost: host, sellerType: known ? 'official' : 'unverified', source: 'web', verified: true });
        }
        return cands;
      } catch (e) {
        ctx.log(`web: ${url.slice(0, 60)} falló (${e.message.split('\n')[0]})`);
        return [];
      }
    }), 3);
    const candidates = results.flat();
    return { status: candidates.length ? 'ok' : 'empty', candidates, message: candidates.length ? null : `Revisé ${targets.length} sitios sin coincidencias` };
  }
};

/** Google Shopping vía SerpAPI (opcional, requiere API key). */
export const googleShopping = {
  id: 'google',
  name: 'Google Shopping',
  group: 'Rastreo web',
  kind: 'api',
  sellerType: 'unverified',
  verify: false,
  requiresKey: true,
  async search(ctx) {
    if (!ctx.serpapiKey) return { status: 'skipped', candidates: [], message: 'Define SERPAPI_KEY en tu archivo .env para activarlo' };
    const params = new URLSearchParams({
      engine: 'google_shopping', q: ctx.query, gl: 'mx', hl: 'es', google_domain: 'google.com.mx', location: 'Mexico', num: '40', api_key: ctx.serpapiKey
    });
    const res = await fetch(`https://serpapi.com/search.json?${params}`, { signal: AbortSignal.timeout(30000) });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || json.error) {
      return { status: 'error', candidates: [], message: json.error ? `SerpAPI: ${json.error}` : `SerpAPI respondió ${res.status}` };
    }
    const list = [...(json.shopping_results || []), ...(json.inline_shopping_results || [])].filter((r) => !r.second_hand_condition);
    // Solo enlaces a una ficha de producto o tienda; nunca páginas de búsqueda de Google.
    const isSearchUrl = (u) => !u || /google\.[a-z.]+\/(search|shopping\/?\?)/i.test(u) || /[?&]q=/.test(u) && /google\./i.test(u);
    const candidates = list.map((r) => {
      const source = r.source || r.seller || 'Tienda';
      const known = KNOWN_RETAILERS.find((k) => k.re.test(source));
      const delivery = [r.delivery, ...(r.extensions || [])].filter(Boolean).join(' | ');
      return {
        title: r.title,
        price: r.extracted_price ?? parseMoney(r.price),
        listPrice: r.extracted_old_price ?? parseMoney(r.old_price),
        url: [r.link, r.product_link].find((u) => !isSearchUrl(u)) || null,
        image: r.thumbnail,
        storeName: known ? known.name : source,
        storeKnownId: known ? known.id : null,
        sellerType: known ? 'official' : 'unverified',
        badges: [r.tag, ...(r.extensions || [])].filter(Boolean),
        rawText: [r.tag, delivery, r.second_hand_condition].filter(Boolean).join(' | '),
        available: r.second_hand_condition ? false : null,
        source: 'google'
      };
    }).filter((c) => c.title && c.price && c.url);
    return { status: candidates.length ? 'ok' : 'empty', candidates, message: candidates.length ? null : 'Google Shopping no tuvo resultados' };
  }
};
