/** Resumen y ranking del histórico: una fila por SKU, ordenada por menor precio encontrado. */

function pick(snap, excludeThirdParty) {
  return excludeThirdParty ? snap.bestOfficial : snap.best;
}

export function summarizeEntry(entry, { excludeThirdParty = false } = {}) {
  const snaps = entry.snapshots || [];
  const last = snaps[snaps.length - 1] || {};
  const best = pick(last, excludeThirdParty) || null;
  const series = snaps.map((s) => {
    const b = pick(s, excludeThirdParty);
    return { at: s.at, total: b ? b.total : null, store: b ? b.store : null };
  });
  const prev = [...series].slice(0, -1).reverse().find((p) => p.total != null) || null;
  const withValue = series.filter((p) => p.total != null);
  const lowest = withValue.reduce((m, p) => (m == null || p.total < m.total ? p : m), null);
  return {
    sku: entry.sku,
    title: entry.title || (best && best.title) || null,
    image: entry.image || (best && best.image) || null,
    lastSearched: entry.lastSearched,
    firstSearched: entry.firstSearched,
    searches: snaps.length,
    offerCount: last.offerCount ?? (last.offers ? last.offers.length : 0),
    best,
    change: best && prev ? Math.round((best.total - prev.total) * 100) / 100 : null,
    lowest,
    series
  };
}

export function rankHistory(entries, opts = {}) {
  const rows = entries.map((e) => summarizeEntry(e, opts));
  rows.sort((a, b) => {
    if (!!a.best !== !!b.best) return a.best ? -1 : 1;
    if (!a.best) return String(b.lastSearched).localeCompare(String(a.lastSearched));
    if (a.best.totalKnown !== b.best.totalKnown) return a.best.totalKnown ? -1 : 1;
    return a.best.total - b.best.total;
  });
  return rows.map((r, i) => ({ ...r, rank: r.best ? i + 1 : null }));
}
