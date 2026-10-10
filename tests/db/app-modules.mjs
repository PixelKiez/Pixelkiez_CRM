/**
 * Führt App-Module (TypeScript mit Pfad-Alias @/) in Node aus — ohne Next.js
 * und ohne Loader-Hooks. Die .ts-Dateien werden mit dem typescript-Paket in ein
 * Temp-Verzeichnis übersetzt und ihre Importe auf absolute file:-URLs
 * umgeschrieben. Das läuft auf jeder Node-Version des Engine-Bereichs
 * (>= 22.14); module.registerHooks gibt es erst ab Node 22.15.
 *
 * Jeder Aufruf von runAppScript startet einen eigenen Prozess: Modulzustand
 * (gecachte Verbindung) und Umgebung (SQLITE_PATH, Arbeitsverzeichnis) sind so
 * je Szenario frisch, wie bei einem echten Serverstart.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, tempDir } from './helpers.mjs';

const requireFromRoot = createRequire(join(ROOT, 'package.json'));
const ts = requireFromRoot('typescript');
const compiled = new Map();

/**
 * @param {string} entry Pfad relativ zum Projekt, z. B. 'lib/database.ts'
 * @returns {string} file:-URL des übersetzten Moduls
 */
export function compileAppModule(entry) {
  if (compiled.has(entry)) return compiled.get(entry);
  const out = tempDir();
  const done = new Map();
  const compile = (rel) => {
    if (done.has(rel)) return done.get(rel);
    const target = join(out, rel.replace(/\.tsx?$/, '.mjs'));
    const url = pathToFileURL(target).href;
    done.set(rel, url);
    const { outputText } = ts.transpileModule(readFileSync(join(ROOT, rel), 'utf8'), {
      compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    });
    const js = outputText.replace(
      /(\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])([^'"]+)\2/g,
      (_, lead, quote, spec) => `${lead}${quote}${resolveSpecifier(spec, rel)}${quote}`,
    );
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, js);
    return url;
  };
  const resolveSpecifier = (spec, fromRel) => {
    if (spec.startsWith('node:')) return spec;
    let path;
    if (spec.startsWith('@/')) path = join(ROOT, spec.slice(2));
    else if (spec.startsWith('.')) path = resolve(ROOT, dirname(fromRel), spec);
    else return pathToFileURL(requireFromRoot.resolve(spec)).href;
    if (/\.(m?js|cjs|json)$/.test(path)) return pathToFileURL(path).href;
    const source = [`${path}.ts`, `${path}.tsx`, path].find(p => /\.tsx?$/.test(p) && existsSync(p));
    if (!source) throw new Error(`Modul nicht gefunden: ${spec} (aus ${fromRel})`);
    return compile(relative(ROOT, source));
  };
  const url = compile(entry);
  compiled.set(entry, url);
  return url;
}

/** Schema-Anweisungen (DDL) und PRAGMAs, die ein Schema prüfen oder umbauen. */
export const DDL_PATTERN = /\b(CREATE|ALTER|DROP)\s+((TEMP|TEMPORARY|UNIQUE|VIRTUAL)\s+)?(TABLE|INDEX|TRIGGER|VIEW)\b|\bPRAGMA\s+["'`]?(table_info|table_xinfo|user_version|writable_schema)\b/i;

/**
 * Alle Zeichenketten- und Template-Literale einer Quelldatei (per TypeScript-AST,
 * also ohne Kommentare). SQL erreicht SQLite nur über solche Literale.
 * @param {string} rel Pfad relativ zum Projekt
 * @returns {string[]}
 */
export function stringLiterals(rel) {
  const source = ts.createSourceFile(rel, readFileSync(join(ROOT, rel), 'utf8'), ts.ScriptTarget.Latest, true);
  const out = [];
  const visit = (node) => {
    if (ts.isStringLiteralLike(node) || ts.isTemplateHead(node) || ts.isTemplateMiddle(node) || ts.isTemplateTail(node)) out.push(node.text);
    ts.forEachChild(node, visit);
  };
  visit(source);
  return out;
}

/**
 * Führt `body` als ES-Modul in einem eigenen Node-Prozess aus. `body` sieht
 * `app` (die Exporte von lib/database.ts) und gibt mit `return` ein
 * JSON-fähiges Ergebnis zurück. Fehler kommen als { error: { name, code, message } }.
 *
 * @param {{ cwd?: string, env: Record<string, string>, body: string }} options
 */
export function runAppScript({ cwd = ROOT, env, body }) {
  const url = compileAppModule('lib/database.ts');
  const script = `
    const app = await import(${JSON.stringify(url)});
    let out;
    try {
      out = { value: await (async () => { ${body} })() };
    } catch (error) {
      out = { error: { name: error?.name, code: error?.code, message: String(error?.message) } };
    }
    process.stdout.write(JSON.stringify(out));
  `;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd,
    env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env },
    encoding: 'utf8',
  });
  if (result.status !== 0) throw new Error(`App-Skript endete mit ${result.status}: ${result.stderr}`);
  return JSON.parse(result.stdout);
}
