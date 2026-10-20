// Diagnóstico rápido: node scripts/doctor.js  (o  npm run doctor)
import { chromium } from 'playwright-core';

const ok = (m) => console.log('  ✓ ' + m);
const bad = (m) => console.log('  ✗ ' + m);

console.log('\nSKU/FINDER · diagnóstico\n');
const major = Number(process.versions.node.split('.')[0]);
major >= 20 ? ok(`Node ${process.versions.node}`) : bad(`Node ${process.versions.node} — se necesita 20 o superior`);

let browser = null;
for (const channel of [process.env.BROWSER_CHANNEL || 'chrome', 'msedge', 'chromium']) {
  try {
    browser = await chromium.launch({ channel: channel === 'chromium' ? undefined : channel, headless: true });
    ok(`Navegador: ${channel} ${browser.version()}`);
    break;
  } catch (e) {
    bad(`No se pudo abrir "${channel}"`);
  }
}
if (!browser) {
  console.log('\n  Instala Google Chrome (https://www.google.com/chrome/) o usa Microsoft Edge.\n');
  process.exit(1);
}

const page = await browser.newPage();
for (const url of ['https://www.liverpool.com.mx', 'https://www.amazon.com.mx', 'https://listado.mercadolibre.com.mx', 'https://html.duckduckgo.com/html/']) {
  try {
    const r = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    r && r.status() < 400 ? ok(`${new URL(url).hostname} responde (${r.status()})`) : bad(`${new URL(url).hostname} respondió ${r && r.status()}`);
  } catch (e) {
    bad(`${new URL(url).hostname}: ${e.message.split('\n')[0]}`);
  }
}
await browser.close();
console.log('\nListo. Arranca la app con:  npm start\n');
