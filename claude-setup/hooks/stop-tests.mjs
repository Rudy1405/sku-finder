// Stop: antes de que Claude termine, corre `node --test` si cambió código desde la última revisión.
// Evita bucles: solo vuelve a correr cuando hay archivos más nuevos que la última corrida
// (si Claude no puede arreglarlo y no cambia nada, se le deja terminar).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { /* sin entrada */ }
const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
if (!fs.existsSync(path.join(root, 'node_modules'))) process.exit(0); // aún no hay npm install

const WATCH = ['server', 'public', 'test', 'scripts', 'package.json'];
function latestMtime(p) {
  let st;
  try { st = fs.statSync(p); } catch { return 0; }
  if (!st.isDirectory()) return st.mtimeMs;
  let max = 0;
  for (const name of fs.readdirSync(p)) max = Math.max(max, latestMtime(path.join(p, name)));
  return max;
}
const latest = Math.max(...WATCH.map((w) => latestMtime(path.join(root, w))));

const stateDir = path.join(root, '.claude', '.state');
const stateFile = path.join(stateDir, 'last-test-run.json');
let state = {};
try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { /* primera vez */ }
if (state.checkedMtime && latest <= state.checkedMtime) process.exit(0);

const run = spawnSync(process.execPath, ['--test'], { cwd: root, encoding: 'utf8', timeout: 170000, env: process.env });
const ok = run.status === 0;
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(stateFile, JSON.stringify({ checkedMtime: latest, ok, at: new Date().toISOString() }, null, 1));
if (ok) process.exit(0);

const out = `${run.stdout || ''}\n${run.stderr || ''}`;
const summary = out.split('\n')
  .filter((l) => /^not ok|^# (pass|fail)|AssertionError|expected:|actual:|Error:/.test(l.trim()))
  .slice(0, 30).join('\n');
process.stderr.write(`npm test falla con los cambios actuales. Corrige la causa (no las pruebas) antes de terminar:\n${summary || out.slice(-1500)}\n`);
process.exit(2);
