// SKU/FINDER — frontend sin dependencias.
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const money = (n) => n == null ? '—' : '$' + Number(n).toLocaleString('es-MX', { minimumFractionDigits: 0, maximumFractionDigits: Number(n) % 1 ? 2 : 0 });
const safeUrl = (u) => { try { const x = new URL(u); return /^https?:$/.test(x.protocol) ? x.href : null; } catch { return null; } };
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* sin almacenamiento */ } }
};

const STATUS_TEXT = {
  pending: 'en cola', running: 'buscando', ok: 'ofertas', empty: 'sin resultados', similar: 'solo parecidos',
  nomatch: 'sin el modelo', blocked: 'bloqueado', error: 'error', skipped: 'desactivado'
};

const state = {
  settings: null,
  result: null,           // snapshot mostrado
  resultSaved: false,     // viene del histórico (no de una búsqueda recién hecha)
  history: [],
  filters: store.get('filters', { excludeThirdParty: false, promoOnly: false, hideOut: false, sort: 'total' }),
  polling: null,
  busy: false,            // hay una búsqueda en curso
  announced: -1           // último avance anunciado a lectores de pantalla
};

const TITLES = { search: 'SKU/FINDER · Rastreador de precios', history: 'Histórico · SKU/FINDER' };
const announce = (msg) => { $('#searchStatus').textContent = msg; };
// Avisos puntuales (fuera de las vistas, para que se oigan aunque la vista activa sea otra
// y para que el avance de la búsqueda no los pise).
let noticeTimer = null;
const notify = (msg) => {
  const el = $('#appNotice');
  el.textContent = '';
  requestAnimationFrame(() => { el.textContent = msg; });   // re-anuncia aunque el texto sea idéntico
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => { el.textContent = ''; }, 6000);
};

// ---------------------------------------------------------------- API
async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, { headers: { 'Content-Type': 'application/json' }, ...opts, body: opts.body ? JSON.stringify(opts.body) : undefined });
  } catch {
    throw new Error('No hay conexión con el servidor local. Revisa que siga en marcha e inténtalo de nuevo.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Error ${res.status}`);
  return data;
}

// ---------------------------------------------------------------- Router
function route(moveFocus = false) {
  const hash = location.hash || '#/';
  const isHistory = hash.startsWith('#/historico');
  document.title = isHistory ? TITLES.history : TITLES.search;
  $('#view-search').hidden = isHistory;
  $('#view-history').hidden = !isHistory;
  $$('.tabs__link').forEach((a) => ((a.dataset.tab === 'history') === isHistory ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current')));
  if (isHistory) {
    loadHistory();
    if (moveFocus) $('#historyTitle').focus();
  } else {
    const m = hash.match(/^#\/sku\/(.+)$/);
    if (m) openSaved(decodeURIComponent(m[1]));
    else if (moveFocus) $('#skuInput').focus();
  }
}

// ---------------------------------------------------------------- Búsqueda
$('#searchForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const sku = $('#skuInput').value.trim();
  if (sku) runSearch(sku);
});

async function runSearch(sku) {
  if (state.busy) {
    // llévame a la búsqueda que ya corre en vez de ignorar el clic
    if (location.hash !== '#/' && location.hash !== '') location.hash = '#/';
    notify('Ya hay una búsqueda en curso; espera a que termine.');
    return;
  }
  state.busy = true;
  document.body.dataset.busy = '';
  state.announced = -1;
  clearInterval(state.polling);
  if (location.hash !== '#/' && location.hash !== '') history.replaceState(null, '', '#/');
  document.title = TITLES.search;
  $('#view-search').hidden = false; $('#view-history').hidden = true;
  $$('.tabs__link').forEach((a) => a.dataset.tab === 'search' ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'));
  $('#skuInput').value = sku.toUpperCase();
  const btn = $('#searchBtn');
  btn.disabled = true;
  renderLoading({ sku: sku.toUpperCase(), stores: [] }, Date.now());
  try {
    const { jobId } = await api('/api/search', { method: 'POST', body: { sku } });
    const started = Date.now();
    const job = await new Promise((resolve, reject) => {
      let inflight = false, failures = 0;
      const tick = async () => {
        if (inflight) return;              // no apilar peticiones si el servidor tarda
        inflight = true;
        try {
          const job = await api(`/api/search/${jobId}`);
          failures = 0;
          if (job.status === 'running') { renderLoading(job, started); return; }
          clearInterval(state.polling);
          if (job.status === 'error') reject(new Error(job.error || 'La búsqueda falló'));
          else resolve(job);
        } catch (err) {
          // un tropiezo de red no debe tirar una búsqueda de un minuto: tolera hasta 3 seguidos
          if (++failures >= 3) { clearInterval(state.polling); reject(err); }
        } finally { inflight = false; }
      };
      state.polling = setInterval(tick, 900);
      tick();
    });
    state.result = job.result;
    state.resultSaved = false;
    renderResult({ focus: true });
    refreshHistoryCount();
    renderRecent();
  } catch (err) {
    $('#searchState').innerHTML = `<div class="alert" role="alert"><strong>No se pudo completar la búsqueda</strong>${esc(err.message)}
      <div class="alert__actions"><button type="button" class="btn btn--ghost btn--sm" data-act="research" data-sku="${esc(sku.toUpperCase())}">Reintentar</button></div></div>`;
    announce('La búsqueda falló.');
  } finally {
    state.busy = false;
    delete document.body.dataset.busy;
    btn.disabled = false;
  }
}

function renderLoading(job, started) {
  const stores = job.stores || [];
  const done = stores.filter((s) => !['pending', 'running'].includes(s.status)).length;
  const total = stores.length || 17;
  const pct = stores.length ? Math.round((done / total) * 100) : 3;
  const secs = Math.round((Date.now() - started) / 1000);
  const found = stores.reduce((n, s) => n + (s.count || 0), 0);
  const el = $('#searchState');
  if (!$('.loading', el)) {
    el.innerHTML = `
      <section class="loading" aria-label="Buscando">
        <div class="loading__top">
          <span class="loading__count" id="ldCount"></span>
          <span class="loading__msg" id="ldMsg"></span>
          <span class="loading__time" id="ldTime"></span>
        </div>
        <div class="progress" role="progressbar" aria-valuemin="0" aria-valuemax="100" aria-label="Progreso de la búsqueda" id="ldBar"><div class="progress__bar"></div></div>
        <div class="storegrid" id="ldStores"></div>
      </section>`;
  }
  $('#ldCount').innerHTML = `${String(done).padStart(2, '0')}<small>/${String(total).padStart(2, '0')} fuentes</small>`;
  $('#ldMsg').textContent = stores.length ? `Rastreando ${job.sku}${found ? ` · ${found} ofertas exactas hasta ahora` : ''}` : `Abriendo el navegador para rastrear ${job.sku}…`;
  $('#ldTime').textContent = `${secs}s`;
  if (done !== state.announced) {
    state.announced = done;
    announce(stores.length ? `${done} de ${total} fuentes revisadas` : `Buscando ${job.sku}`);
  }
  $('#ldBar').setAttribute('aria-valuenow', pct);
  $('.progress__bar', el).style.transform = `scaleX(${pct / 100})`;
  $('#ldStores').innerHTML = stores.map((s) => `
    <div class="storerow"><span class="storerow__name">${esc(s.name)}</span>
    <span class="storerow__st" data-s="${esc(s.status)}">${s.status === 'ok' ? `${s.count} ${s.count === 1 ? 'oferta' : 'ofertas'}` : esc(STATUS_TEXT[s.status] || s.status)}</span></div>`).join('');
}

// ---------------------------------------------------------------- Resultados
function visibleOffers() {
  const f = state.filters;
  let list = [...(state.result?.offers || [])];
  if (f.excludeThirdParty) list = list.filter((o) => !['third_party', 'unverified'].includes(o.sellerType));
  if (f.promoOnly) list = list.filter((o) => o.promo?.has);
  if (f.hideOut) list = list.filter((o) => o.available);
  const avail = list.filter((o) => o.available);
  const out = list.filter((o) => !o.available);
  const byTotal = (a, b) => (a.totalKnown === b.totalKnown ? a.total - b.total : a.totalKnown ? -1 : 1);
  const sorters = {
    total: byTotal,
    discount: (a, b) => (b.discountPct || 0) - (a.discountPct || 0) || byTotal(a, b),
    store: (a, b) => a.store.localeCompare(b.store, 'es') || byTotal(a, b)
  };
  avail.sort(sorters[f.sort] || byTotal);
  out.sort(byTotal);
  return { avail, out };
}

function bestOf(list) {
  return [...list].filter((o) => o.available).sort((a, b) => (a.totalKnown === b.totalKnown ? a.total - b.total : a.totalKnown ? -1 : 1))[0] || null;
}

function renderResult({ focus = false } = {}) {
  const r = state.result;
  const el = $('#searchState');
  if (!r) { el.innerHTML = ''; return; }
  const hist = state.history.find((h) => h.sku === r.sku);
  const f = state.filters;
  const { avail, out } = visibleOffers();
  const best = bestOf(f.excludeThirdParty ? avail : (r.offers || []).filter((o) => !f.promoOnly || o.promo?.has));
  const storesWith = new Set((r.offers || []).map((o) => o.store)).size;
  const checked = (r.stores || []).filter((s) => s.status !== 'skipped').length;
  const when = new Date(r.at);
  const prevPoint = hist?.series?.filter((p) => p.total != null && p.at !== r.at).slice(-1)[0];
  const delta = best && prevPoint && !state.resultSaved ? best.total - prevPoint.total : null;
  const title = best?.title || r.offers?.[0]?.title || r.similar?.[0]?.title || '';
  const image = best?.image || r.offers?.find((o) => o.image)?.image;

  let html = '';
  if (state.resultSaved) {
    html += `<div class="saved-note"><span>Resultado guardado del <strong>${esc(fmtDate(when))}</strong></span>
      <button class="btn btn--ghost btn--sm" data-act="research" data-sku="${esc(r.sku)}">Volver a rastrear</button></div>`;
  }
  html += `
    <section class="summary" aria-label="Resumen">
      <div class="summary__id">
        ${safeUrl(image) ? `<img class="summary__img" src="${esc(safeUrl(image))}" alt="" loading="lazy" referrerpolicy="no-referrer">` : ''}
        <div>
          <div class="summary__sku">${esc(r.sku)}</div>
          <h2 class="summary__title" tabindex="-1">${esc(title || 'Sin coincidencias exactas')}</h2>
          <p class="summary__meta">${r.offerCount || 0} ofertas exactas en ${storesWith} ${storesWith === 1 ? 'tienda' : 'tiendas'} · ${checked} fuentes revisadas · ${Math.round((r.durationMs || 0) / 1000)} s${r.saved === false ? ' · no se guardó en el histórico' : ''}</p>
        </div>
      </div>
      <div class="summary__best">
        ${best ? `
          <div class="summary__label">Menor ${best.totalKnown ? 'precio con envío' : 'precio · envío por confirmar'}</div>
          <div class="summary__price">${money(best.total)}</div>
          <div class="summary__where">en ${safeUrl(best.url) ? `<a href="${esc(safeUrl(best.url))}" target="_blank" rel="noopener">${esc(best.store)}</a>` : esc(best.store)} · ${esc(best.shipping.label)}</div>
          ${delta != null && delta !== 0 ? `<span class="summary__delta" data-dir="${delta < 0 ? 'down' : 'up'}">${delta < 0 ? '▼' : '▲'} ${money(Math.abs(delta))} vs. búsqueda anterior</span>` : ''}
          ${hist?.lowest && hist.lowest.total < best.total ? `<div class="summary__delta">Mínimo histórico ${money(hist.lowest.total)} · ${esc(hist.lowest.store || '')}</div>` : ''}
        ` : `<div class="summary__label">Menor precio</div><div class="summary__price">—</div><div class="summary__where">No hay ofertas disponibles con el modelo exacto</div>`}
      </div>
    </section>`;

  if ((r.offers || []).length) {
    html += `
      <div class="toolbar" role="group" aria-label="Filtros">
        ${switchHtml('excludeThirdParty', 'Excluir terceros', f.excludeThirdParty)}
        ${switchHtml('promoOnly', 'Solo con promo', f.promoOnly)}
        ${switchHtml('hideOut', 'Ocultar agotados', f.hideOut)}
        <label class="switch">Orden
          <select class="select" data-filter="sort">
            <option value="total" ${f.sort === 'total' ? 'selected' : ''}>Menor total</option>
            <option value="discount" ${f.sort === 'discount' ? 'selected' : ''}>Mayor descuento</option>
            <option value="store" ${f.sort === 'store' ? 'selected' : ''}>Tienda A–Z</option>
          </select>
        </label>
        <span class="toolbar__count">${avail.length + out.length} de ${r.offers.length}</span>
      </div>
      <div class="offers${focus ? '' : ' offers--still'}" id="offers"></div>`;
  } else {
    html += emptyResultHtml(r);
  }

  if ((r.similar || []).length) {
    html += `<details class="fold"><summary>Posibles coincidencias <span>(${r.similar.length}) · modelos parecidos, no cuentan para el ranking</span></summary>
      <table class="rows"><thead><tr><th>Producto</th><th class="hide-sm">Tienda</th><th class="r">Precio</th></tr></thead><tbody>
      ${r.similar.map((o) => `<tr><td>${safeUrl(o.url) ? `<a href="${esc(safeUrl(o.url))}" target="_blank" rel="noopener">${esc(o.title)}</a>` : esc(o.title)}<div class="hide-sm muted muted--sm">${o.available ? '' : 'Agotado'}</div></td><td class="hide-sm">${esc(o.store)}</td><td class="r num">${money(o.price)}</td></tr>`).join('')}
      </tbody></table></details>`;
  }

  html += `<details class="fold"><summary>Detalle por fuente <span>· qué respondió cada tienda</span></summary>
    <table class="rows"><thead><tr><th>Fuente</th><th>Estado</th><th class="hide-sm">Nota</th><th class="r">Tiempo</th></tr></thead><tbody>
    ${(r.stores || []).map((s) => `<tr><td>${safeUrl(s.searchUrl) ? `<a href="${esc(safeUrl(s.searchUrl))}" target="_blank" rel="noopener">${esc(s.name)}</a>` : esc(s.name)}</td>
      <td><span class="st" data-s="${esc(s.status)}">${s.status === 'ok' ? `${s.count} ${s.count === 1 ? 'oferta' : 'ofertas'}` : esc(STATUS_TEXT[s.status] || s.status)}</span></td>
      <td class="hide-sm muted">${esc(s.message || (s.parser ? `lector ${s.parser}` : ''))}</td>
      <td class="r num muted">${s.ms ? (s.ms / 1000).toFixed(1) + ' s' : '—'}</td></tr>`).join('')}
    </tbody></table></details>`;

  el.innerHTML = html;
  if (focus) {
    announce(`Listo: ${r.offerCount || 0} ${r.offerCount === 1 ? 'oferta exacta' : 'ofertas exactas'} en ${storesWith} ${storesWith === 1 ? 'tienda' : 'tiendas'}.`);
    $('.summary__title', el)?.focus();
  }
  const grid = $('#offers', el);
  if (grid) {
    const frag = document.createDocumentFragment();
    const bestId = best?.id;
    avail.forEach((o, i) => frag.appendChild(offerCard(o, o.id === bestId, i)));
    if (out.length) {
      const sep = document.createElement('div');
      sep.className = 'offers-sep';
      sep.textContent = `Agotados o sin envío a domicilio (${out.length}) · no cuentan para el menor precio`;
      frag.appendChild(sep);
      out.forEach((o, i) => frag.appendChild(offerCard(o, false, avail.length + i)));
    }
    if (!avail.length && !out.length) {
      const p = document.createElement('p');
      p.className = 'muted';
      p.textContent = 'Ninguna oferta coincide con los filtros activos.';
      frag.appendChild(p);
    }
    grid.appendChild(frag);
  }
}

function switchHtml(key, label, checked) {
  return `<label class="switch"><input type="checkbox" data-filter="${key}" ${checked ? 'checked' : ''}><span class="switch__track" aria-hidden="true"></span><span>${label}</span></label>`;
}

function emptyResultHtml(r) {
  const blocked = (r.stores || []).filter((s) => s.status === 'blocked').map((s) => s.name);
  const offline = (r.stores || []).filter((s) => s.status === 'error' && /conectar/.test(s.message || '')).length;
  if (offline >= Math.max(3, (r.stores || []).length - 3)) {
    return `<div class="alert" role="alert"><strong>No pude conectarme a las tiendas</strong>Revisa tu conexión a internet (o la VPN/proxy) y vuelve a rastrear.</div>`;
  }
  return `<div class="empty">
    <h2 class="empty__title">No encontré el modelo exacto ${esc(r.sku)} a la venta</h2>
    <p>Revisa que el SKU esté completo (por ejemplo, con o sin el sufijo después de la diagonal) o prueba solo la parte principal del modelo.</p>
    ${blocked.length ? `<p>Estas tiendas pidieron verificación anti-bots: <strong>${esc(blocked.join(', '))}</strong>. Activa “Mostrar las ventanas mientras busca” en Ajustes, resuelve la verificación una vez y vuelve a rastrear.</p>` : ''}
  </div>`;
}

const SELLER_TEXT = { official: 'Tienda oficial', third_party: 'Vendedor tercero', unverified: 'Tienda no verificada', unknown: 'Vendedor sin confirmar' };

function offerCard(o, isBest, i) {
  const node = $('#tpl-offer').content.firstElementChild.cloneNode(true);
  node.style.animationDelay = Math.min(i * 25, 400) + 'ms';
  if (isBest) {
    node.classList.add('offer--best');
    const flag = document.createElement('span');
    flag.className = 'offer__flag';
    flag.textContent = 'MEJOR PRECIO';
    node.prepend(flag);
  }
  if (!o.available) node.classList.add('offer--out');
  $('.offer__store', node).textContent = o.store;
  const seller = $('.offer__seller', node);
  const MARKETPLACES = ['amazon', 'mercadolibre', 'walmart', 'sams', 'bodega'];
  let sellerTxt = '';
  if (o.sellerType === 'official') sellerTxt = MARKETPLACES.includes(o.storeId) ? (o.seller || 'Vendido por la tienda') : '';
  else if (o.sellerType === 'third_party') sellerTxt = o.seller || SELLER_TEXT.third_party;
  else sellerTxt = SELLER_TEXT[o.sellerType] || '';
  seller.textContent = sellerTxt;
  seller.dataset.t = o.sellerType;
  seller.title = SELLER_TEXT[o.sellerType] || '';
  const link = $('.offer__link', node);
  link.textContent = o.title;
  const href = safeUrl(o.url);
  if (href) link.href = href; else link.removeAttribute('href');
  link.setAttribute('aria-label', `${o.title} en ${o.store}, ${money(o.price)}`);
  $('.offer__amount', node).textContent = money(o.price);
  if (o.listPrice) {
    $('.offer__was', node).innerHTML = `<s>${money(o.listPrice)}</s>${o.discountPct ? `<b>−${o.discountPct}%</b>` : ''}`;
  }
  const ship = $('.offer__ship', node);
  ship.dataset.s = o.shipping.status;
  ship.textContent = o.shipping.status === 'paid' ? `+ ${money(o.shipping.cost)} de envío` : o.shipping.label;
  if (o.shipping.note) ship.title = o.shipping.note;
  if (o.shipping.status === 'paid') $('.offer__total', node).textContent = `Total ${money(o.total)}`;
  const tags = $('.offer__tags', node);
  if (!o.available) tags.insertAdjacentHTML('beforeend', `<span class="tag tag--out">${esc(o.unavailableReason || 'Agotado')}</span>`);
  if (o.promo?.has) {
    tags.insertAdjacentHTML('beforeend', `<span class="tag tag--promo">Promo</span>`);
    for (const reason of o.promo.reasons.slice(0, 3)) tags.insertAdjacentHTML('beforeend', `<span class="tag tag--reason">${esc(reason)}</span>`);
  }
  return node;
}

$('#searchState').addEventListener('change', (e) => {
  const key = e.target.dataset.filter;
  if (!key) return;
  state.filters[key] = e.target.type === 'checkbox' ? e.target.checked : e.target.value;
  store.set('filters', state.filters);
  const y = window.scrollY;
  renderResult();
  window.scrollTo(0, y);
});
$('#searchState').addEventListener('click', (e) => {
  const b = e.target.closest('[data-act="research"]');
  if (b) runSearch(b.dataset.sku);
});

// ---------------------------------------------------------------- Histórico
$('#histExclude3p').checked = store.get('histExclude3p', false);
$('#histExclude3p').addEventListener('change', (e) => { store.set('histExclude3p', e.target.checked); loadHistory(); });

async function loadHistory() {
  const ex = $('#histExclude3p').checked ? '1' : '0';
  const list = $('#historyList');
  if (!state.history.length) list.innerHTML = `<p class="muted loading-note">Cargando…</p>`;
  try {
    const { items } = await api(`/api/history?excludeThirdParty=${ex}`);
    state.history = items;
    $('#historyCount').textContent = items.length ? items.length : '';
    renderHistory();
  } catch (err) {
    list.innerHTML = `<div class="alert" role="alert"><strong>No se pudo cargar el histórico</strong>${esc(err.message)}</div>`;
  }
}

function renderHistory() {
  const list = $('#historyList');
  if (!state.history.length) {
    list.innerHTML = `<div class="empty">
      <h2 class="empty__title">Todavía no hay modelos rastreados</h2>
      <p>Cada SKU que busques queda aquí con su mejor precio y la evolución de búsqueda en búsqueda.</p>
      <ol><li>Escribe el SKU en <a href="#/">Rastrear</a>.</li><li>Vuelve a rastrearlo cuando quieras para sumar un punto a su serie.</li><li>El ranking se ordena solo, del más barato al más caro.</li></ol>
    </div>`;
    return;
  }
  list.innerHTML = `<ol class="hist">${state.history.map((h) => `
    <li class="hist__row" data-sku="${esc(h.sku)}">
      <span class="hist__rank">${h.rank ? String(h.rank).padStart(2, '0') : '··'}</span>
      <div class="hist__id">
        <button class="hist__sku" data-act="open" title="Ver último resultado">${esc(h.sku)}</button>
        <div class="hist__title">${esc(h.title || 'Sin título')}</div>
        <div class="hist__when">${h.searches} ${h.searches === 1 ? 'búsqueda' : 'búsquedas'} · última ${esc(relTime(h.lastSearched))}</div>
      </div>
      <div class="hist__sparkcell">${sparkline(h.series)}</div>
      <div class="hist__price">
        ${h.best ? `<div class="hist__amount">${money(h.best.total)}</div>
          <div class="hist__store">${esc(h.best.store)}${h.best.totalKnown ? '' : ' · envío ?'}</div>
          ${h.change ? `<div class="hist__delta" data-dir="${h.change < 0 ? 'down' : 'up'}">${h.change < 0 ? '▼' : '▲'} ${money(Math.abs(h.change))}</div>` : ''}`
        : `<div class="hist__none">Sin oferta disponible</div>`}
      </div>
      <div class="hist__actions">
        <button class="btn btn--ghost btn--sm" data-act="research">Re-buscar</button>
        <button class="iconbtn" data-act="delete" aria-label="Borrar ${esc(h.sku)} del histórico">
          <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true"><path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/></svg>
        </button>
      </div>
    </li>`).join('')}</ol>`;
}

$('#historyList').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const row = btn.closest('.hist__row');
  const sku = row?.dataset.sku;
  if (!sku) return;
  const act = btn.dataset.act;
  if (act === 'open') location.hash = `#/sku/${encodeURIComponent(sku)}`;
  if (act === 'research') runSearch(sku);
  if (act === 'delete') {
    const cell = btn.parentElement;
    const prev = cell.innerHTML;
    cell.innerHTML = `<span class="confirm">¿Borrar? <button class="btn btn--primary btn--sm" data-act="confirm-del">Sí</button><button class="btn btn--ghost btn--sm" data-act="cancel-del">No</button></span>`;
    cell.dataset.prev = prev;
    $('[data-act="cancel-del"]', cell).focus();
  }
  if (act === 'cancel-del') {
    const cell = btn.closest('.hist__actions');
    cell.innerHTML = cell.dataset.prev;
    $('[data-act="delete"]', cell)?.focus();
  }
  if (act === 'confirm-del') {
    const cell = btn.closest('.hist__actions');
    const idx = $$('.hist__row').indexOf(row);
    btn.disabled = true;
    try {
      await api(`/api/history/${encodeURIComponent(sku)}`, { method: 'DELETE' });
    } catch (err) {
      cell.innerHTML = cell.dataset.prev;
      cell.insertAdjacentHTML('afterbegin', `<span class="confirm confirm--bad" role="alert">No se pudo borrar: ${esc(err.message)}</span>`);
      $('[data-act="delete"]', cell)?.focus();
      return;
    }
    await loadHistory();
    renderRecent();
    const rows = $$('.hist__row');
    (rows.length ? $('.hist__sku', rows[Math.min(idx, rows.length - 1)]) : $('#historyTitle')).focus();
  }
});

async function openSaved(sku) {
  try {
    const ex = state.filters.excludeThirdParty ? '1' : '0';
    const data = await api(`/api/history/${encodeURIComponent(sku)}?excludeThirdParty=${ex}`);
    if (!state.history.length) await loadHistoryQuiet();
    state.result = data.latest;
    state.resultSaved = true;
    $('#skuInput').value = sku;
    renderResult({ focus: true });
  } catch (err) {
    $('#searchState').innerHTML = `<div class="alert" role="alert"><strong>No encontré ese SKU en el histórico</strong>${esc(err.message)}</div>`;
  }
}
async function loadHistoryQuiet() {
  try { const { items } = await api('/api/history'); state.history = items; $('#historyCount').textContent = items.length || ''; } catch { /* no-op */ }
}

// Sparkline: una sola serie, línea de 2px, punto final y tooltip al pasar el cursor.
const pointText = (p) => `${money(p.total)} en ${p.store || 'tienda sin nombre'}, ${fmtDate(new Date(p.at))}`;
function sparkline(series) {
  const pts = (series || []).filter((p) => p.total != null);
  if (pts.length < 2) return `<span class="spark__empty">${pts.length ? '1 punto' : '—'}</span>`;
  const W = 132, H = 40, P = 5;
  const min = Math.min(...pts.map((p) => p.total)), max = Math.max(...pts.map((p) => p.total));
  const span = max - min || 1;
  const x = (i) => P + (i * (W - 2 * P)) / (pts.length - 1);
  const y = (v) => H - P - ((v - min) / span) * (H - 2 * P);
  const d = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.total).toFixed(1)}`).join('');
  const data = esc(JSON.stringify(pts.map((p) => [p.at, p.total, p.store])));
  const last = pts.length - 1;
  return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="slider" tabindex="0" aria-orientation="horizontal" aria-valuemin="1" aria-valuemax="${pts.length}" aria-valuenow="${pts.length}" aria-valuetext="${esc(pointText(pts[last]))}" aria-label="Evolución del mejor precio: de ${money(pts[0].total)} a ${money(pts[last].total)}. Usa las flechas para recorrer los puntos." data-pts="${data}">
    <line class="spark__cross" x1="0" x2="0" y1="0" y2="${H}" visibility="hidden"/>
    <path class="spark__line" d="${d}"/>
    <circle class="spark__dot" cx="${x(last).toFixed(1)}" cy="${y(pts[last].total).toFixed(1)}" r="4"/>
    <rect class="spark__hit" x="0" y="0" width="${W}" height="${H}"/>
  </svg>`;
}

const tooltip = document.createElement('div');
tooltip.className = 'tooltip';
tooltip.hidden = true;
document.body.appendChild(tooltip);
const sparkPts = new WeakMap();   // el JSON de cada serie se parsea una sola vez
let activeSpark = null, sparkTimer = null;
const getPts = (svg) => {
  let pts = sparkPts.get(svg);
  if (!pts) { pts = JSON.parse(svg.dataset.pts); sparkPts.set(svg, pts); }
  return pts;
};
function hideSpark() {
  tooltip.hidden = true;
  activeSpark?.querySelector('.spark__cross')?.setAttribute('visibility', 'hidden');
  activeSpark = null;
}
// Muestra el punto i de la serie: cruz, tooltip y valor para lectores de pantalla.
function showSparkPoint(svg, i) {
  if (activeSpark && activeSpark !== svg) hideSpark();
  activeSpark = svg;
  const pts = getPts(svg);
  i = Math.max(0, Math.min(pts.length - 1, i));
  const [at, total, st] = pts[i];
  const rect = svg.getBoundingClientRect();
  const px = 5 + (i * (132 - 10)) / (pts.length - 1);
  const cross = $('.spark__cross', svg);
  cross.setAttribute('x1', px); cross.setAttribute('x2', px); cross.setAttribute('visibility', 'visible');
  svg.setAttribute('aria-valuenow', i + 1);
  svg.setAttribute('aria-valuetext', pointText({ total, store: st, at }));
  tooltip.innerHTML = `<b>${money(total)}</b> · ${esc(st || '')}<br>${esc(fmtDate(new Date(at)))}`;
  tooltip.style.left = rect.left + (px / 132) * rect.width + 'px';
  tooltip.style.top = rect.top + 'px';
  tooltip.hidden = false;
  svg.dataset.i = i;
  return i;
}
function showSpark(e) {
  const svg = e.target.closest?.('.spark');
  if (!svg) { if (activeSpark) hideSpark(); return; }
  const pts = getPts(svg);
  const rect = svg.getBoundingClientRect();
  const rel = Math.max(0, Math.min(1, (e.clientX - rect.left - 5) / (rect.width - 10)));
  showSparkPoint(svg, Math.round(rel * (pts.length - 1)));
  clearTimeout(sparkTimer);
  if (e.pointerType !== 'mouse') sparkTimer = setTimeout(hideSpark, 2200);   // en táctil no hay "salir": se apaga solo
}
document.addEventListener('pointermove', showSpark);
document.addEventListener('pointerdown', showSpark);
// Teclado: foco muestra el último punto; flechas, Inicio y Fin recorren la serie.
document.addEventListener('focusin', (e) => {
  const svg = e.target.closest?.('.spark');
  if (svg) showSparkPoint(svg, getPts(svg).length - 1);
});
document.addEventListener('focusout', (e) => { if (e.target.closest?.('.spark')) hideSpark(); });
document.addEventListener('keydown', (e) => {
  const svg = e.target.closest?.('.spark');
  if (!svg) return;
  const last = getPts(svg).length - 1;
  const cur = Number(svg.dataset.i ?? last);
  const next = { ArrowLeft: cur - 1, ArrowDown: cur - 1, ArrowRight: cur + 1, ArrowUp: cur + 1, Home: 0, End: last }[e.key];
  if (next == null) return;
  e.preventDefault();
  showSparkPoint(svg, next);
});
window.addEventListener('blur', hideSpark);

// ---------------------------------------------------------------- Recientes
function renderRecent() {
  loadHistoryQuiet().then(() => {
    const recent = [...state.history].sort((a, b) => String(b.lastSearched).localeCompare(String(a.lastSearched))).slice(0, 6);
    const el = $('#recent');
    if (!recent.length) { el.hidden = true; return; }
    el.hidden = false;
    el.innerHTML = `<span class="recent__label">Recientes</span>` + recent.map((h) => `<button type="button" class="chip" data-sku="${esc(h.sku)}">${esc(h.sku)}</button>`).join('');
  });
}
$('#recent').addEventListener('click', (e) => {
  const c = e.target.closest('.chip');
  if (c) runSearch(c.dataset.sku);
});
function refreshHistoryCount() { loadHistoryQuiet(); }

// ---------------------------------------------------------------- Ajustes
const dlg = $('#settings');
const setStatus = (msg, kind = 'ok') => { const s = $('#settingsStatus'); s.textContent = msg; s.dataset.state = kind; };
$$('[data-close]', dlg).forEach((b) => b.addEventListener('click', () => dlg.close()));
$('#openSettings').addEventListener('click', async () => {
  const save = $('#saveSettings');
  try {
    await loadSettings();
    save.disabled = false;
    setStatus('');
  } catch (err) {
    // sin ajustes cargados, guardar sobrescribiría la configuración real con campos vacíos
    save.disabled = true;
    $('#storeToggles').innerHTML = '';
    setStatus(`No se pudieron cargar los ajustes: ${err.message}`, 'error');
  }
  dlg.showModal();
});

async function loadSettings() {
  const s = await api('/api/settings');
  state.settings = s;
  $('#showBrowser').checked = !!s.showBrowser;
  const groups = {};
  for (const st of s.stores) (groups[st.group] ||= []).push(st);
  $('#storeToggles').innerHTML = Object.entries(groups).map(([g, list]) => `<h3>${esc(g)}</h3>` + list.map((st) => `
    <label class="switch"><input type="checkbox" data-store="${esc(st.id)}" ${s.disabledStores.includes(st.id) ? '' : 'checked'}>
    <span class="switch__track" aria-hidden="true"></span><span>${esc(st.name)}${st.requiresKey && !s.hasSerpapiKey ? ' <small class="muted">(requiere SERPAPI_KEY)</small>' : ''}</span></label>`).join('')).join('');
  updateHints(s);
}

function updateHints(s) {
  const active = s.stores.filter((st) => !s.disabledStores.includes(st.id) && st.kind !== 'discovery' && st.kind !== 'api').length;
  $('#storeCount').textContent = `${active} tiendas`;
  const googleOn = s.hasSerpapiKey && !s.disabledStores.includes('google');
  $('#googleHint').textContent = googleOn ? ' y Google Shopping' : '';
}

$('#settingsForm').addEventListener('submit', async (e) => {
  e.preventDefault();                       // Enter en un campo guarda; nunca cierra en silencio
  const save = $('#saveSettings');
  if (save.disabled) return;
  const disabledStores = $$('[data-store]').filter((i) => !i.checked).map((i) => i.dataset.store);
  save.disabled = true;
  try {
    const s = await api('/api/settings', { method: 'PUT', body: { showBrowser: $('#showBrowser').checked, disabledStores } });
    state.settings = s;
    updateHints(s);
    setStatus('Guardado');
    setTimeout(() => dlg.close(), 450);
  } catch (err) {
    setStatus(err.message, 'error');
  } finally {
    save.disabled = false;
  }
});

// ---------------------------------------------------------------- Utilidades
function fmtDate(d) {
  return d.toLocaleString('es-MX', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
function relTime(iso) {
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return 'hace un momento';
  if (s < 3600) return `hace ${Math.round(s / 60)} min`;
  if (s < 86400) return `hace ${Math.round(s / 3600)} h`;
  if (s < 86400 * 30) return `hace ${Math.round(s / 86400)} d`;
  return fmtDate(new Date(iso));
}

// ---------------------------------------------------------------- Inicio
window.addEventListener('hashchange', () => route(true));
api('/api/settings').then((s) => { state.settings = s; updateHints(s); }).catch(() => {});
renderRecent();
route();
$('#skuInput').focus();
