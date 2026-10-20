import fs from 'node:fs/promises';
import path from 'node:path';
import { DATA_DIR, config } from './config.js';

const DB_FILE = path.join(DATA_DIR, 'db.json');

const DEFAULT_SETTINGS = {
  showBrowser: false,
  disabledStores: [],
  excludeThirdParty: false
};

let db = null;
let writing = Promise.resolve();

async function load() {
  if (db) return db;
  await fs.mkdir(DATA_DIR, { recursive: true });
  try {
    db = JSON.parse(await fs.readFile(DB_FILE, 'utf8'));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // archivo corrupto: se respalda y se empieza de cero
      await fs.rename(DB_FILE, DB_FILE + '.corrupt-' + Date.now()).catch(() => {});
    }
    db = { version: 1, skus: {}, settings: {} };
  }
  db.skus ||= {};
  db.settings = { ...DEFAULT_SETTINGS, ...(db.settings || {}) };
  // Las API keys ya no se guardan en disco: se limpia la que haya quedado de versiones anteriores.
  if ('serpapiKey' in db.settings) {
    delete db.settings.serpapiKey;
    await persist();
  }
  return db;
}

function persist() {
  // Escritura atómica y serializada (tmp + rename)
  writing = writing.then(async () => {
    const tmp = DB_FILE + '.tmp';
    await fs.writeFile(tmp, JSON.stringify(db, null, 1));
    await fs.rename(tmp, DB_FILE);
  }).catch((e) => console.error('[storage] no se pudo guardar:', e.message));
  return writing;
}

export async function getSettings() {
  const d = await load();
  return { ...d.settings };
}

export async function updateSettings(patch) {
  const d = await load();
  const allowed = Object.keys(DEFAULT_SETTINGS);
  for (const k of Object.keys(patch || {})) {
    if (allowed.includes(k)) d.settings[k] = patch[k];
  }
  await persist();
  return { ...d.settings };
}

/** Guarda una búsqueda como snapshot dentro del SKU (serie de precios). */
export async function saveSnapshot(snapshot) {
  const d = await load();
  const key = snapshot.sku;
  const entry = d.skus[key] || { sku: key, firstSearched: snapshot.at, snapshots: [] };
  entry.lastSearched = snapshot.at;
  const best = snapshot.best || snapshot.bestAny;
  if (best) {
    entry.title = best.title || entry.title;
    entry.image = best.image || entry.image;
  }
  entry.snapshots.push(snapshot);
  // Solo los 3 snapshots más recientes conservan todas las ofertas; los demás guardan el resumen.
  entry.snapshots = entry.snapshots.slice(-config.historySnapshotsKept).map((s, i, arr) => {
    if (i < arr.length - 3 && s.offers) {
      const { offers, similar, stores, ...rest } = s;
      return { ...rest, offerCount: s.offerCount ?? offers.length };
    }
    return s;
  });
  d.skus[key] = entry;
  await persist();
  return entry;
}

export async function listSkus() {
  const d = await load();
  return Object.values(d.skus);
}

export async function getSku(sku) {
  const d = await load();
  return d.skus[sku] || null;
}

export async function deleteSku(sku) {
  const d = await load();
  const existed = !!d.skus[sku];
  delete d.skus[sku];
  await persist();
  return existed;
}

/** Solo para pruebas */
export function __resetForTests(newDb) { db = newDb; }
