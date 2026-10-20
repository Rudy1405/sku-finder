import fs from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright-core';
import { DATA_DIR, config } from './config.js';

const STATE_FILE = path.join(DATA_DIR, 'browser-state.json');
let current = null; // { browser, context, headless, channel }
let launching = null;
let idleTimer = null;

function osToken() {
  if (process.platform === 'win32') return 'Windows NT 10.0; Win64; x64';
  if (process.platform === 'darwin') return 'Macintosh; Intel Mac OS X 10_15_7';
  return 'X11; Linux x86_64';
}

async function tryLaunch(channel, headless) {
  const opts = {
    headless,
    args: ['--disable-blink-features=AutomationControlled', '--lang=es-MX', '--no-default-browser-check', '--no-first-run']
  };
  if (channel && channel !== 'chromium') opts.channel = channel;
  if (process.env.CHROME_PATH) opts.executablePath = process.env.CHROME_PATH;
  return chromium.launch(opts);
}

async function launch(headless) {
  const order = config.browserChannel ? [config.browserChannel] : ['chrome', 'msedge', 'chromium'];
  let lastErr;
  for (const channel of order) {
    try {
      const browser = await tryLaunch(channel, headless);
      const version = browser.version();
      // En headless el UA dice "HeadlessChrome"; lo reemplazamos por el de un Chrome normal.
      let ua = `Mozilla/5.0 (${osToken()}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${version} Safari/537.36`;
      if (channel === 'msedge') ua += ` Edg/${version}`;
      const context = await browser.newContext({
        userAgent: ua,
        locale: 'es-MX',
        timezoneId: 'America/Mexico_City',
        viewport: { width: 1366, height: 900 },
        deviceScaleFactor: 1,
        extraHTTPHeaders: { 'Accept-Language': 'es-MX,es;q=0.9,en;q=0.5' },
        storageState: fs.existsSync(STATE_FILE) ? STATE_FILE : undefined
      });
      await context.addInitScript(() => {
        try {
          Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
          Object.defineProperty(navigator, 'languages', { get: () => ['es-MX', 'es', 'en'] });
          if (!window.chrome) window.chrome = { runtime: {} };
        } catch (e) { /* no-op */ }
      });
      // Ahorra ancho de banda: sin fuentes ni video. Las URLs de imágenes siguen en el DOM.
      await context.route('**/*', (route) => {
        const t = route.request().resourceType();
        if (t === 'media' || t === 'font') return route.abort();
        if (t === 'image' && headless) return route.abort();
        return route.continue();
      });
      console.log(`[browser] usando ${channel} ${version} (${headless ? 'oculto' : 'visible'})`);
      return { browser, context, headless, channel };
    } catch (e) {
      lastErr = e;
      console.warn(`[browser] no se pudo abrir "${channel}": ${String(e.message).split('\n')[0]}`);
    }
  }
  const err = new Error('No se encontró un navegador compatible. Instala Google Chrome o Microsoft Edge, o ejecuta "npx playwright install chromium" y usa BROWSER_CHANNEL=chromium.');
  err.cause = lastErr;
  throw err;
}

export async function getContext({ headless = true } = {}) {
  clearTimeout(idleTimer);
  if (current && current.headless !== headless) await closeBrowser();
  if (current && current.browser.isConnected()) return current.context;
  if (!launching) launching = launch(headless).finally(() => { launching = null; });
  current = await launching;
  current.browser.on('disconnected', () => { current = null; });
  return current.context;
}

export async function withPage(ctxOpts, fn) {
  const context = await getContext(ctxOpts);
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  try {
    return await fn(page);
  } finally {
    await page.close().catch(() => {});
  }
}

export async function persistState() {
  if (!current) return;
  try { await current.context.storageState({ path: STATE_FILE }); } catch { /* no-op */ }
}

/** Cierra el navegador tras un rato sin uso para liberar memoria. */
export function scheduleIdleClose(ms = 4 * 60 * 1000) {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => { closeBrowser().catch(() => {}); }, ms);
}

export async function closeBrowser() {
  const c = current;
  current = null;
  if (c) {
    await c.context.storageState({ path: STATE_FILE }).catch(() => {});
    await c.browser.close().catch(() => {});
  }
}

export function browserInfo() {
  return current ? { channel: current.channel, headless: current.headless, version: current.browser.version() } : null;
}
