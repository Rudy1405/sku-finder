import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normSku, skuVariants, matchType, classifyShipping, classifyInstallments, promoLabels,
  normalizeOffer, rankOffers, pickBest, parseMoney, cleanSkuInput
} from '../server/normalize.js';
import { rankHistory } from '../server/history.js';
import { scanJson } from '../server/extract/scan-json.js';

const store = { id: 'x', name: 'Tienda X', sellerType: 'official' };

test('SKU: normalización y variantes', () => {
  assert.equal(normSku('rt38k5930s8/em'), 'RT38K5930S8EM');
  assert.deepEqual(skuVariants('RT38K5930S8/EM').sort(), ['RT38K5930S8', 'RT38K5930S8EM'].sort());
  assert.ok(skuVariants('RT53DG6128S9EM').includes('RT53DG6128S9'));
  assert.equal(cleanSkuInput('  rt38k 5930s8 '), 'RT38K5930S8');
});

test('match exacto, parecido y sin relación', () => {
  assert.equal(matchType({ title: 'Refrigerador Samsung Tmf 19 Ft Rt53Dg6128S9Em con Wifi' }, 'RT53DG6128S9'), 'exact');
  assert.equal(matchType({ title: 'Refrigerador Samsung 14 pies RT38K5930S8' }, 'RT38K5930S8/EM'), 'exact');
  assert.equal(matchType({ title: 'Refri', skus: ['rt38k5930s8'] }, 'RT38K5930S8'), 'exact');
  assert.equal(matchType({ title: 'Refrigerador Samsung 14 pies RT38CG6420S9' }, 'RT38K5930S8'), 'similar');
  assert.equal(matchType({ title: 'Lavadora LG 22 kg WM22VV2S6GR' }, 'RT38K5930S8'), 'unrelated');
});

test('envío: gratis, condicional, con costo, política y desconocido', () => {
  assert.equal(classifyShipping({ rawText: 'ENVÍO GRATIS', price: 1000 }).status, 'free');
  assert.equal(classifyShipping({ rawText: 'Envío sin costo con Walmart Pass', price: 1000 }).status, 'conditional');
  const paid = classifyShipping({ rawText: 'Envío $499', price: 18000 });
  assert.equal(paid.status, 'paid');
  assert.equal(paid.cost, 499);
  assert.equal(classifyShipping({ rawText: '', price: 12000 }, { shippingPolicy: { freeOver: 599 } }).status, 'free');
  assert.equal(classifyShipping({ rawText: 'Llega mañana', price: 12000 }).status, 'unknown');
  assert.equal(classifyShipping({ shippingCost: 0, price: 9000 }).status, 'free');
});

test('MSI y etiquetas de promo', () => {
  assert.equal(classifyInstallments({ rawText: '$1,483.22 x 9 meses sin intereses' }).months, 9);
  assert.equal(classifyInstallments({ rawText: 'Hasta 18 MSI' }).months, 18);
  assert.equal(classifyInstallments({ rawText: 'MSI + PAGA EN ENERO' }).label, 'MSI');
  assert.equal(classifyInstallments({ rawText: 'Desde $721 quincenal' }), null);
  assert.deepEqual(promoLabels({ badges: ['OFERTA DEL DÍA'] }), ['Oferta del día']);
  assert.deepEqual(promoLabels({ rawText: 'Hot Sale · precio' }), ['Hot Sale']);
  assert.deepEqual(promoLabels({ rawText: '$20,499 -42% $11,799' }), []);
});

test('precio tachado sin etiqueta NO es promo; con etiqueta sí', () => {
  const a = normalizeOffer({ title: 'Refri RT38K5930S8', price: 11799, listPrice: 20499, rawText: '-42%' }, store, 'RT38K5930S8');
  assert.equal(a.discountPct, 42);
  assert.equal(a.promo.has, false);
  assert.equal(a.discountIsPromo, false);
  const b = normalizeOffer({ title: 'Refri RT38K5930S8', price: 11799, listPrice: 20499, badges: ['Rebaja'] }, store, 'RT38K5930S8');
  assert.equal(b.promo.has, true);
  assert.equal(b.discountIsPromo, true);
});

test('agotados y usados no cuentan', () => {
  const out = normalizeOffer({ title: 'Refri RT38K5930S8', price: 9000, rawText: 'Agotado' }, store, 'RT38K5930S8');
  assert.equal(out.available, false);
  const used = normalizeOffer({ title: 'Refrigerador RT38K5930S8 usado buen estado', price: 7000 }, store, 'RT38K5930S8');
  assert.equal(used.available, false);
  assert.equal(used.unavailableReason, 'Usado o reacondicionado');
});

test('ranking: total conocido primero, luego envío por confirmar, agotados al final', () => {
  const mk = (price, rawText, extra = {}) => normalizeOffer({ title: 'Refri RT38K5930S8', price, rawText, url: 'https://x.mx/' + price, ...extra }, store, 'RT38K5930S8');
  const offers = [
    mk(12000, 'Llega mañana'),            // desconocido (más barato, pero va después)
    mk(12500, 'Envío gratis'),            // conocido 12500
    mk(12100, 'Envío $500'),              // conocido 12600
    mk(9000, 'Agotado')                   // agotado
  ];
  const ranked = rankOffers(offers).map((o) => o.total + (o.totalKnown ? 'k' : 'u') + (o.available ? '' : 'x'));
  assert.deepEqual(ranked, ['12500k', '12600k', '12000u', '9000ux']);
  assert.equal(pickBest(offers).total, 12500);
});

test('excluir terceros en el mejor precio', () => {
  const o1 = normalizeOffer({ title: 'Refri RT38K5930S8', price: 9000, rawText: 'Envío gratis', sellerType: 'third_party', url: 'https://a' }, store, 'RT38K5930S8');
  const o2 = normalizeOffer({ title: 'Refri RT38K5930S8', price: 9500, rawText: 'Envío gratis', url: 'https://b' }, store, 'RT38K5930S8');
  assert.equal(pickBest([o1, o2]).price, 9000);
  assert.equal(pickBest([o1, o2], { excludeThirdParty: true }).price, 9500);
});

test('parseMoney', () => {
  assert.equal(parseMoney('$13,349.00'), 13349);
  assert.equal(parseMoney('Antes: 4999 pesos mexicanos'), 4999);
  assert.equal(parseMoney('$ 13,299 00'), 13299);
});

test('scanJson encuentra productos en JSON arbitrario (VTEX / Next / APIs)', () => {
  const json = { data: { search: { products: [
    { productName: 'Refrigerador Mabe RME360FVMRS0', linkText: 'refrigerador-mabe', items: [{ sellers: [{ commertialOffer: { Price: 10999, ListPrice: 12999, AvailableQuantity: 3 } }] }], productReference: 'RME360FVMRS0' },
    { name: 'Refrigerador LG GT57BPSX', price: { value: 17490, currency: 'MXN' }, url: '/p/lg', sku: 'GT57BPSX' }
  ] } } };
  const found = scanJson(json);
  assert.equal(found.length, 2);
  assert.equal(found[0].price, 10999);
  assert.equal(found[0].listPrice, 12999);
  assert.equal(found[0].url, '/refrigerador-mabe/p');
  assert.equal(found[1].price, 17490);
});

test('histórico rankeado por menor precio', () => {
  const snap = (sku, total, at, known = true) => ({ sku, at, best: total ? { total, totalKnown: known, store: 'X' } : null, bestOfficial: null, offers: [] });
  const entries = [
    { sku: 'A', lastSearched: '2026-10-01', snapshots: [snap('A', 15000, '2026-09-01'), snap('A', 14000, '2026-10-01')] },
    { sku: 'B', lastSearched: '2026-10-02', snapshots: [snap('B', 9000, '2026-10-02')] },
    { sku: 'C', lastSearched: '2026-10-03', snapshots: [snap('C', null, '2026-10-03')] },
    { sku: 'D', lastSearched: '2026-10-03', snapshots: [snap('D', 8000, '2026-10-03', false)] }
  ];
  const rows = rankHistory(entries);
  assert.deepEqual(rows.map((r) => r.sku), ['B', 'A', 'D', 'C']);
  assert.equal(rows[1].change, -1000);
  assert.equal(rows[3].rank, null);
});
