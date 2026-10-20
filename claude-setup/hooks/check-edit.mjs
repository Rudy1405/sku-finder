// PostToolUse (Edit|Write): revisión rápida del archivo que Claude acaba de editar.
//  1. Sintaxis de cualquier .js/.mjs del proyecto (node --check).
//  2. scan-json.js / page-extractor.js siguen siendo autocontenidas al serializarse
//     (se inyectan en el navegador con .toString(); una referencia externa rompe todo en silencio).
//  3. Si se tocaron las reglas (normalize/history/scan-json), corre las pruebas unitarias rápidas.
// Exit 2 + stderr = Claude recibe el problema como feedback. Exit 0 = todo bien.
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

let input = {};
try { input = JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { process.exit(0); }
const file = input.tool_input && input.tool_input.file_path;
if (!file) process.exit(0);

const root = process.env.CLAUDE_PROJECT_DIR || input.cwd || process.cwd();
const abs = path.resolve(root, file);
const rel = path.relative(root, abs).split(path.sep).join('/');
if (rel.startsWith('..') || rel.startsWith('node_modules/') || !/\.m?js$/.test(rel) || !fs.existsSync(abs)) process.exit(0);

const problems = [];

const syntax = spawnSync(process.execPath, ['--check', abs], { encoding: 'utf8' });
if (syntax.status !== 0) {
  problems.push(`Error de sintaxis en ${rel}:\n${(syntax.stderr || '').trim().split('\n').slice(0, 8).join('\n')}`);
}

const SERIALIZED = ['server/extract/scan-json.js', 'server/extract/page-extractor.js'];
if (!problems.length && SERIALIZED.includes(rel)) {
  const bust = `?t=${Date.now()}`;
  try {
    const { scanJson } = await import(pathToFileURL(path.join(root, SERIALIZED[0])).href + bust);
    const { extractPage, buildExtractorScript } = await import(pathToFileURL(path.join(root, SERIALIZED[1])).href + bust);
    // Contexto vacío: si la función usa algo fuera de su cuerpo, aquí truena con ReferenceError.
    const fn = vm.runInNewContext('(' + scanJson.toString() + ')', {});
    const out = fn({ data: [{ name: 'Refrigerador Prueba RT38K5930S8', price: 12999, url: '/p/x' }] });
    if (!Array.isArray(out) || out.length !== 1) problems.push('scanJson serializada ya no encuentra un producto básico {name, price, url}.');
    new vm.Script(buildExtractorScript(scanJson, extractPage, {}));
  } catch (e) {
    problems.push(`El extractor dejó de ser autocontenido al serializarse (${e.message}). scanJson y extractPage no pueden usar imports ni variables de fuera de su cuerpo.`);
  }
}

if (!problems.length && /^server\/(normalize|history)\.js$|^server\/extract\/scan-json\.js$/.test(rel)) {
  const t = spawnSync(process.execPath, ['--test', 'test/normalize.test.js'], { cwd: root, encoding: 'utf8', timeout: 45000 });
  if (t.status !== 0) {
    const lines = `${t.stdout || ''}\n${t.stderr || ''}`.split('\n')
      .filter((l) => /not ok|AssertionError|expected|actual|Error/.test(l)).slice(0, 25);
    problems.push(`test/normalize.test.js falla después de editar ${rel}:\n${lines.join('\n')}`);
  }
}

if (problems.length) {
  process.stderr.write(problems.join('\n\n') + '\n');
  process.exit(2);
}
process.exit(0);
