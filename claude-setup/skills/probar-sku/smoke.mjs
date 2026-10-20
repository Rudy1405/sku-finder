// Búsqueda real de un SKU sin servidor HTTP ni histórico del usuario.
// Uso: node .claude/skills/probar-sku/smoke.mjs <SKU> [tienda1,tienda2]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const [sku, only] = process.argv.slice(2);
if (!sku) {
  console.error('Uso: node .claude/skills/probar-sku/smoke.mjs <SKU> [tienda1,tienda2]');
  process.exit(1);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
process.env.DATA_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'skufinder-smoke-'));
const imp = (p) => import(pathToFileURL(path.join(root, p)).href);

const { ADAPTERS, startSearch, getJob } = await imp('server/search.js');
const { updateSettings } = await imp('server/storage.js');
const { closeBrowser } = await imp('server/browser.js');

if (only) {
  const keep = new Set(only.split(',').map((s) => s.trim()));
  const unknown = [...keep].filter((id) => !ADAPTERS.some((a) => a.id === id));
  if (unknown.length) console.error(`Tiendas desconocidas: ${unknown.join(', ')}`);
  await updateSettings({ disabledStores: ADAPTERS.map((a) => a.id).filter((id) => !keep.has(id)) });
}

const started = Date.now();
const id = startSearch(sku);
let job;
do {
  await new Promise((r) => setTimeout(r, 1500));
  job = getJob(id);
} while (job.status === 'running');

const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n);
console.log(`\nSKU ${job.sku} · ${job.status} · ${Math.round((Date.now() - started) / 1000)} s\n`);
console.log(pad('tienda', 16), pad('estado', 9), pad('exactas', 8), pad('lector', 10), pad('tiempo', 7), 'nota');
for (const s of job.stores) {
  console.log(pad(s.id, 16), pad(s.status, 9), pad(s.count, 8), pad(s.parser || '', 10), pad(s.ms ? (s.ms / 1000).toFixed(1) + 's' : '', 7), s.message || '');
}
if (job.error) console.log(`\nError: ${job.error}`);
const r = job.result;
if (r) {
  console.log(`\nOfertas exactas: ${r.offerCount} · parecidas: ${r.similar.length}`);
  for (const o of r.offers.slice(0, 8)) {
    const flags = [o.available ? '' : 'NO-DISP', o.totalKnown ? '' : 'envío?', o.promo.has ? 'PROMO:' + o.promo.reasons.join('/') : '', o.sellerType !== 'official' ? o.sellerType : ''].filter(Boolean).join(' ');
    console.log(`  $${o.total.toLocaleString('es-MX')}  ${pad(o.store, 18)} ${pad(o.title, 60)} ${flags}`);
  }
  if (r.best) console.log(`\nMejor: $${r.best.total.toLocaleString('es-MX')} en ${r.best.store}`);
}
await closeBrowser();
fs.rmSync(process.env.DATA_DIR, { recursive: true, force: true });
process.exit(job.status === 'done' ? 0 : 1);
