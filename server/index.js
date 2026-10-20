import express from 'express';
import path from 'node:path';
import { ROOT, PUBLIC_DIR, config } from './config.js';
import { startSearch, getJob, listAdapters } from './search.js';
import { listSkus, getSku, deleteSku, getSettings, updateSettings } from './storage.js';
import { rankHistory, summarizeEntry } from './history.js';
import { closeBrowser, browserInfo } from './browser.js';
import { cleanSkuInput } from './normalize.js';

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '200kb' }));

// Fuentes empaquetadas (funciona sin conexión a Google Fonts)
app.use('/fonts/grotesk', express.static(path.join(ROOT, 'node_modules/@fontsource-variable/schibsted-grotesk/files'), { maxAge: '30d' }));
app.use('/fonts/mono', express.static(path.join(ROOT, 'node_modules/@fontsource/ibm-plex-mono/files'), { maxAge: '30d' }));
app.use(express.static(PUBLIC_DIR, { extensions: ['html'] }));

const wrap = (fn) => (req, res) => Promise.resolve(fn(req, res)).catch((e) => {
  res.status(e.status || 500).json({ error: e.message || 'Error inesperado' });
});

app.post('/api/search', wrap(async (req, res) => {
  const jobId = startSearch(req.body && req.body.sku);
  res.status(202).json({ jobId });
}));

app.get('/api/search/:jobId', wrap(async (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Búsqueda no encontrada' });
  res.json(job);
}));

app.get('/api/history', wrap(async (req, res) => {
  const excludeThirdParty = req.query.excludeThirdParty === '1';
  res.json({ items: rankHistory(await listSkus(), { excludeThirdParty }) });
}));

app.get('/api/history/:sku', wrap(async (req, res) => {
  const entry = await getSku(cleanSkuInput(req.params.sku));
  if (!entry) return res.status(404).json({ error: 'SKU sin historial' });
  const last = [...entry.snapshots].reverse().find((s) => s.offers) || entry.snapshots[entry.snapshots.length - 1];
  res.json({
    summary: summarizeEntry(entry, { excludeThirdParty: req.query.excludeThirdParty === '1' }),
    latest: last
  });
}));

app.delete('/api/history/:sku', wrap(async (req, res) => {
  const ok = await deleteSku(cleanSkuInput(req.params.sku));
  res.json({ deleted: ok });
}));

app.get('/api/settings', wrap(async (req, res) => {
  const s = await getSettings();
  res.json({ ...s, hasSerpapiKey: !!config.serpapiKey, stores: listAdapters(), browser: browserInfo() });
}));

app.put('/api/settings', wrap(async (req, res) => {
  const s = await updateSettings(req.body);
  res.json({ ...s, hasSerpapiKey: !!config.serpapiKey, stores: listAdapters() });
}));

app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

const server = app.listen(config.port, config.host, () => {
  console.log(`\n  SKU/FINDER listo →  http://localhost:${config.port}\n`);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    await closeBrowser().catch(() => {});
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  });
}

export { app, server };
