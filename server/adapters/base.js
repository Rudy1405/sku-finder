import { openAndExtract, mergeCandidates } from '../extract/index.js';
import { parseMoney } from '../normalize.js';

export function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

export function sameSite(u, domain) {
  const h = hostOf(u);
  const root = domain.replace(/^www\./, '').toLowerCase();
  return h === root || h.endsWith('.' + root);
}

/** Convierte priceText/listText (de parsers propios) en números. */
export function finalizeCustom(items) {
  return (items || []).map((it) => ({
    ...it,
    price: it.price != null ? it.price : parseMoney(it.priceText),
    listPrice: it.listPrice != null ? it.listPrice : parseMoney(it.listText)
  })).filter((it) => it.title && it.price != null && it.price > 0);
}

/**
 * Adaptador genérico para una tienda con buscador: abre la página de resultados en el navegador,
 * intenta el parser propio (si existe) y si no, usa el extractor universal (JSON-LD, red, estado embebido, DOM).
 */
export function storeAdapter(cfg) {
  return {
    kind: 'store',
    sellerType: 'official',
    verify: true,
    ...cfg,
    async search(ctx) {
      const url = cfg.searchUrl(ctx.query, ctx.sku);
      return ctx.withPage(async (page) => {
        const r = await openAndExtract(page, url, cfg.extract || {});
        let candidates = [];
        let parser = 'universal';
        if (cfg.parse) {
          try {
            candidates = finalizeCustom(await cfg.parse(page, r, ctx));
            if (candidates.length) parser = 'propio';
          } catch (e) {
            ctx.log(`${cfg.id}: parser propio falló (${e.message}); uso el universal`);
          }
        }
        if (!candidates.length) candidates = mergeCandidates(r.sources, cfg.sourceOrder);
        // Solo productos del propio sitio (evita anuncios externos y carritos laterales).
        candidates = candidates.filter((c) => !c.url || sameSite(c.url, cfg.domain) || cfg.allowExternal);
        const status = candidates.length ? 'ok' : r.blocked ? 'blocked' : 'empty';
        return {
          status,
          searchUrl: url,
          parser,
          candidates,
          message: status === 'blocked' ? 'La tienda pidió verificación anti-bots' : status === 'empty' ? (r.noResults ? 'Sin resultados' : 'No se detectaron productos') : null
        };
      });
    }
  };
}
