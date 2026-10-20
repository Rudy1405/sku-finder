import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

export const ROOT = path.resolve(here, '..');

// Secretos (p. ej. SERPAPI_KEY) viven en .env, que git ignora. Si no existe, se usan las variables del entorno.
try { process.loadEnvFile(path.join(ROOT, '.env')); } catch { /* sin .env o Node sin loadEnvFile */ }
export const DATA_DIR = process.env.DATA_DIR ? path.resolve(process.env.DATA_DIR) : path.join(ROOT, 'data');
export const PUBLIC_DIR = path.join(ROOT, 'public');

export const config = {
  port: Number(process.env.PORT || 3737),
  host: process.env.HOST || '127.0.0.1',
  // Navegador: 'chrome' (tu Google Chrome), 'msedge' (Edge, viene con Windows) o 'chromium' (de Playwright)
  browserChannel: process.env.BROWSER_CHANNEL || '',
  concurrency: Number(process.env.CONCURRENCY || 5),
  storeTimeoutMs: Number(process.env.STORE_TIMEOUT_MS || 40000),
  verifyPerStore: Number(process.env.VERIFY_PER_STORE || 2),
  serpapiKey: process.env.SERPAPI_KEY || '',
  historySnapshotsKept: 60
};
