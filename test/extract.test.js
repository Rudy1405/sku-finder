// Pruebas del extractor con un navegador real sobre páginas de ejemplo locales.
// Se omiten automáticamente si no hay navegador disponible.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'skufinder-test-'));

const { withPage, closeBrowser, getContext } = await import('../server/browser.js');
const { openAndExtract, mergeCandidates } = await import('../server/extract/index.js');
const { amazonParse, mercadoLibreParse, walmartParse } = await import('../server/adapters/stores.js');
const { finalizeCustom } = await import('../server/adapters/base.js');
const { normalizeOffer } = await import('../server/normalize.js');

let server, base, skip = false;

before(async () => {
  server = http.createServer((req, res) => {
    const f = path.join(here, 'fixtures', path.basename(req.url.split('?')[0]));
    if (!fs.existsSync(f)) { res.writeHead(404); return res.end('no'); }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  try { await getContext({ headless: true }); } catch (e) { skip = e.message; }
});

after(async () => {
  await closeBrowser();
  server.close();
});

const open = (file, opts) => withPage({ headless: true }, (page) => openAndExtract(page, `${base}/${file}`, { scrollSteps: 1, settleMs: 50, priceTimeout: 3000, ...opts }));

test('DOM universal: tarjetas tipo Sears con tachado, envío y agotado', async (t) => {
  if (skip) return t.skip(skip);
  const r = await open('sears-like.html');
  const c = mergeCandidates(r.sources);
  assert.equal(c.length, 3, JSON.stringify(c.map((x) => x.title)));
  const first = c.find((x) => /Rt53Dg6128S9Em/.test(x.title));
  assert.equal(first.price, 11799);
  assert.equal(first.listPrice, 20499);
  const o = normalizeOffer(first, { id: 'sears', name: 'Sears' }, 'RT53DG6128S9EM');
  assert.equal(o.shipping.status, 'free');
  assert.equal(o.match, 'exact');
  const second = normalizeOffer(c.find((x) => /Rf22A4110S9/.test(x.title)), { id: 'sears', name: 'Sears' }, 'RF22A4110S9/EM');
  assert.equal(second.shipping.cost, 499);
  assert.equal(second.total, 18799 + 499);
  const third = normalizeOffer(c.find((x) => /Mabe/.test(x.title)), { id: 'sears', name: 'Sears' }, 'RME360FVMRS0');
  assert.equal(third.available, false);
});

test('DOM universal: tarjeta-ancla tipo Liverpool (font-bold no es tachado)', async (t) => {
  if (skip) return t.skip(skip);
  const r = await open('liverpool-like.html');
  const c = mergeCandidates(r.sources);
  const a = c.find((x) => /RF29DB9950QDEM/.test(x.title));
  assert.ok(a, 'encuentra la tarjeta');
  assert.equal(a.price, 91295);
  assert.equal(a.listPrice, 126799);
  const b = normalizeOffer(c.find((x) => /RT38K5930S8/.test(x.title)), { id: 'liverpool', name: 'Liverpool' }, 'RT38K5930S8');
  assert.equal(b.price, 12499);
  assert.equal(b.installments.months, 18);
  assert.equal(b.promo.has, true);
});

test('JSON-LD en ficha de producto', async (t) => {
  if (skip) return t.skip(skip);
  const r = await open('product-jsonld.html', { scroll: false });
  assert.equal(r.siteName, 'Tienda Ejemplo MX');
  const c = mergeCandidates(r.sources);
  const p = c[0];
  assert.equal(p.price, 14999);
  assert.ok(p.skus.includes('WT1818A'));
  const o = normalizeOffer({ ...p, rawText: r.text }, { id: 'web', name: 'Ej' }, 'WT1818A');
  assert.equal(o.shipping.status, 'free');
  assert.ok(o.promo.labels.includes('Hot Sale'));
});

test('Parser Walmart (__NEXT_DATA__): precio, tachado, MSI, vendedor y stock', async (t) => {
  if (skip) return t.skip(skip);
  const items = await withPage({ headless: true }, async (page) => {
    await page.goto(`${base}/next-data.html`);
    return finalizeCustom(await walmartParse(page));
  });
  assert.equal(items.length, 2);
  const o = normalizeOffer(items[0], { id: 'walmart', name: 'Walmart' }, 'GT57BPSX');
  assert.equal(o.price, 17490);
  assert.equal(o.listPrice, 21999);
  assert.equal(o.installments.months, 12);
  assert.equal(o.shipping.status, 'conditional');
  assert.ok(o.promo.labels.includes('Rebaja'));
  assert.equal(o.sellerType, 'official');
  const o2 = normalizeOffer(items[1], { id: 'walmart', name: 'Walmart' }, 'GT57BPSX');
  assert.equal(o2.sellerType, 'third_party');
  assert.equal(o2.available, false);
});

test('Parser Amazon: precio, lista, badge y MSI', async (t) => {
  if (skip) return t.skip(skip);
  const items = await withPage({ headless: true }, async (page) => {
    await page.goto(`${base}/amazon-like.html`);
    return finalizeCustom(await amazonParse(page));
  });
  const o = normalizeOffer(items[0], { id: 'amazon', name: 'Amazon', sellerType: 'unknown' }, 'RT38K5930S8');
  assert.equal(o.price, 13349);
  assert.equal(o.listPrice, 16999);
  assert.equal(o.url, `${base}/dp/B07ABC1234`);
  assert.equal(o.installments.months, 9);
  assert.equal(o.shipping.status, 'free');
  assert.ok(o.promo.labels.includes('Oferta por tiempo limitado'));
  const funda = normalizeOffer(items[1], { id: 'amazon', name: 'Amazon' }, 'RT38K5930S8');
  assert.equal(funda.match, 'unrelated');
});

test('Parser Mercado Libre: tienda oficial, oferta del día y usado', async (t) => {
  if (skip) return t.skip(skip);
  const items = await withPage({ headless: true }, async (page) => {
    await page.goto(`${base}/ml-like.html`);
    return finalizeCustom(await mercadoLibreParse(page));
  });
  const o = normalizeOffer(items[0], { id: 'mercadolibre', name: 'Mercado Libre' }, 'RT38K5930S8');
  assert.equal(o.price, 12949);
  assert.equal(o.listPrice, 15999);
  assert.equal(o.sellerType, 'official');
  assert.ok(o.promo.labels.includes('Oferta del día'));
  assert.equal(o.installments.months, 18);
  const used = normalizeOffer(items[1], { id: 'mercadolibre', name: 'Mercado Libre' }, 'RT38K5930S8');
  assert.equal(used.available, false);
  assert.equal(used.sellerType, 'third_party');
});
