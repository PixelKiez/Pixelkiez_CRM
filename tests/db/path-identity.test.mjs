/**
 * H-1: Vorprüfung und SQLite meinen dieselbe Datei — für jeden Pfad, den
 * SQLITE_PATH annehmen kann: absolut, relativ, mit „..“, durch Ordner-Symlinks
 * (auch „link/..“: physisch, nicht textuell), über mehrere relative Verweise,
 * ins Leere. Maßstab ist SQLite selbst (PRAGMA database_list nennt den Pfad,
 * den SQLite aufgelöst hat). Eine abgeschnittene Kopie hinter einem relativen
 * Pfad wird abgewiesen, bevor SQLite öffnet; ein Pfad mit Leerraum am Rand
 * (better-sqlite3 kürzt ihn) ebenso. Wird ein Symlink zwischen Prüfung und
 * Öffnen umgehängt, schließt openDatabase, bevor SQLite liest.
 *
 * Relative Pfade laufen in einem Kindprozess mit eigenem Arbeitsverzeichnis.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import Database from 'better-sqlite3';
import { ROOT, tempDir } from './helpers.mjs';

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
/** Dateien eines Ordners mit Prüfsumme (Ordner und Verweise darin nur mit Namen). */
const snapshot = (dir) => Object.fromEntries(readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).map(e => [e.name, e.isFile() ? sha(join(dir, e.name)) : e.isDirectory() ? 'Ordner' : 'Verweis']));
const OPEN = pathToFileURL(join(ROOT, 'lib', 'db', 'open.mjs')).href;
const PKG = join(ROOT, 'package.json');

/** Führt `body` in einem Kindprozess mit Arbeitsverzeichnis `cwd` aus; Rückgabe als JSON. */
function inDir(cwd, body, args = []) {
  const result = spawnSync(process.execPath, [...args, '--input-type=module', '-e', `
    import { createRequire } from 'node:module';
    const Database = createRequire(${JSON.stringify(PKG)})('better-sqlite3');
    const { openDatabase, openProblem, sqlitePath } = await import(${JSON.stringify(OPEN)});
    const tryOpen = (path, mode) => { try { openDatabase(path, mode).close(); return 'offen'; } catch (error) { return error.code + ': ' + error.message; } };
    const out = await (async () => { ${body} })();
    process.stdout.write(JSON.stringify(out));
  `], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: process.env.HOME } });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
}

const CLI = join(ROOT, 'scripts', 'db-migrate.mjs');
const cli = (cwd, args, env) => spawnSync(process.execPath, [CLI, ...args], { cwd, env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env }, encoding: 'utf8' });

const rowsSql = (n) => `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ${n}) INSERT INTO t SELECT printf('%0200d', i) FROM n`;

/** Hauptdatei mit allen Seiten, dazu ein -wal mit wenigen geänderten Seiten (Schreiber per SIGKILL beendet). */
function checkpointedPair() {
  const path = join(tempDir(), 'ck.db');
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`CREATE TABLE t (a); ${rowsSql(2000)}`);
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  const writer = spawnSync(process.execPath, ['--input-type=module', '-e', `
    import Database from 'better-sqlite3';
    const db = new Database(${JSON.stringify(path)});
    db.pragma('wal_autocheckpoint = 0');
    db.exec("UPDATE t SET a = 'neu' WHERE rowid % 97 = 0");
    process.kill(process.pid, 'SIGKILL');
  `], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(writer.signal, 'SIGKILL', writer.stderr);
  return { main: readFileSync(path), wal: readFileSync(`${path}-wal`) };
}
const CK = checkpointedPair();
/** Auf eine Seitengrenze abgeschnitten: Die fehlenden Seiten stehen nicht im -wal. */
const CUT = CK.main.subarray(0, Math.floor(CK.main.length / 4096 / 2) * 4096);

/**
 * root/data/crm.db (gültig), root/data/sub/, root/cwd/ als Arbeitsverzeichnis mit
 *   link → ../data/sub          (relativer Ordner-Symlink)
 *   hop1 → hop2 → ../data/sub/hop3 → ../crm.db   (Kette relativer Verweise)
 *   abs  → <root>/data/crm.db   (absoluter Verweis)
 *   dangle → ../data/fehlt.db   (ins Leere)
 *   küche → ../data/küche       (Ziel mit Umlaut, gültiges UTF-8)
 *   x/                          (echter Ordner)
 */
function layout() {
  const root = realpathSync(tempDir());
  mkdirSync(join(root, 'data', 'sub'), { recursive: true });
  mkdirSync(join(root, 'cwd', 'x'), { recursive: true });
  const db = new Database(join(root, 'data', 'crm.db'));
  db.exec('CREATE TABLE t (a); INSERT INTO t VALUES (1)');
  db.close();
  symlinkSync('../data/sub', join(root, 'cwd', 'link'));
  symlinkSync('hop2', join(root, 'cwd', 'hop1'));
  symlinkSync('../data/sub/hop3', join(root, 'cwd', 'hop2'));
  symlinkSync('../crm.db', join(root, 'data', 'sub', 'hop3'));
  symlinkSync(join(root, 'data', 'crm.db'), join(root, 'cwd', 'abs'));
  symlinkSync('../data/fehlt.db', join(root, 'cwd', 'dangle'));
  mkdirSync(join(root, 'data', 'küche'));
  symlinkSync('../data/küche', join(root, 'cwd', 'küche'));
  return root;
}

test('H-1: Vorprüfung löst jeden Pfad wie SQLite auf (Maßstab: PRAGMA database_list)', () => {
  const root = layout();
  const real = join(root, 'data', 'crm.db');
  const paths = ['../data/crm.db', 'x/../../data/crm.db', './link/../crm.db', 'link/../sub/../crm.db', 'link/../../data/sub/../crm.db', 'hop1', 'abs', 'küche/../crm.db', real, `${join(root, 'cwd', 'link')}/../crm.db`, join(root, 'cwd', 'hop1')];
  const seen = inDir(join(root, 'cwd'), `
    return ${JSON.stringify(paths)}.map(path => {
      const db = new Database(path, { readonly: true, fileMustExist: true });
      try { return { path, checked: sqlitePath(path), target: openProblem(path).target, sqlite: db.pragma('database_list')[0].file, opened: (() => { try { const d = openDatabase(path, 'inspect'); d.close(); return true; } catch (e) { return e.message; } })() }; } finally { db.close(); }
    });
  `);
  for (const entry of seen) {
    assert.equal(entry.sqlite, real, `${entry.path}: SQLite öffnet die echte Datei`);
    assert.equal(entry.checked, entry.sqlite, `${entry.path}: Vorprüfung meint dieselbe Datei`);
    assert.equal(entry.target, entry.sqlite, entry.path);
    assert.equal(entry.opened, true, entry.path);
  }
  // ein fehlender Abschnitt vor „..“ wird angehängt und wieder entfernt, der Verweis dahinter aufgelöst (wie unixFullPathname)
  assert.equal(inDir(join(root, 'cwd'), "return sqlitePath('fehlt/../abs');"), real);
  // relativer Verweis ins Leere: geprüft wird, wo SQLite die Datei anlegen würde
  assert.deepEqual(inDir(join(root, 'cwd'), "return sqlitePath('dangle');"), join(root, 'data', 'fehlt.db'));
  // 201 Verweise hintereinander löst SQLite noch auf (SQLITE_MAX_SYMLINK 200) — die Vorprüfung auch
  const chain = join(root, 'kette');
  mkdirSync(chain);
  symlinkSync(real, join(chain, 'l201'));
  for (let i = 200; i >= 1; i -= 1) symlinkSync(`l${i + 1}`, join(chain, `l${i}`));
  const far = inDir(chain, `
    const db = new Database('l1', { readonly: true, fileMustExist: true });
    try { return { sqlite: db.pragma('database_list')[0].file, checked: sqlitePath('l1') }; } finally { db.close(); }
  `);
  assert.equal(far.sqlite, real);
  assert.equal(far.checked, far.sqlite, '201 Verweise');
  // die Hauptdatei wird am aufgelösten Ziel geprüft: abgeschnitten (ohne -wal) hinter „fehlt/..“
  const lone = join(root, 'allein');
  mkdirSync(lone);
  writeFileSync(join(lone, 'crm.db'), CUT.subarray(0, 50));
  assert.equal(inDir(lone, "return openProblem('fehlt/../crm.db').verdict;"), 'invalid-file');
  // einer mehr öffnet SQLite nicht mehr (SQLITE_CANTOPEN) — die Vorprüfung löst ihn nicht mehr auf
  symlinkSync('l1', join(chain, 'l0'));
  const beyond = inDir(chain, "try { new Database('l0', { readonly: true, fileMustExist: true }).close(); return 'offen'; } catch (error) { return { code: error.code, checked: sqlitePath('l0') }; }");
  assert.deepEqual(beyond, { code: 'SQLITE_CANTOPEN', checked: join(chain, 'l201') }, '202 Verweise');
  // Verweis auf ein Ziel, das kein gültiges UTF-8 ist: Node läse es verlustbehaftet — abgewiesen
  symlinkSync(Buffer.concat([Buffer.from(join(root, 'data', 'crm')), Buffer.from([0xff]), Buffer.from('.db')]), join(root, 'cwd', 'roh.db'));
  assert.deepEqual(inDir(join(root, 'cwd'), "const p = openProblem('roh.db'); return { verdict: p.verdict, checked: sqlitePath('roh.db') };"), { verdict: 'unsafe-path', checked: null });
  // ohne Datei (':memory:', ''): nichts zu prüfen, openDatabase öffnet wie zuvor
  assert.deepEqual(inDir(root, "const db = openDatabase(':memory:', 'apply'); try { return db.prepare('SELECT 1 AS x').get().x; } finally { db.close(); }"), 1);
});

test('H-1: abgeschnittene Kopie hinter relativem Pfad mit Ordner-Symlink und „..“ — abgewiesen, bevor SQLite öffnet', () => {
  const root = realpathSync(tempDir());
  mkdirSync(join(root, 'other', 'dir'), { recursive: true });
  mkdirSync(join(root, 'cwd'));
  mkdirSync(join(root, 'kette'));
  writeFileSync(join(root, 'other', 'crm.db'), CUT);
  writeFileSync(join(root, 'other', 'crm.db-wal'), CK.wal);
  symlinkSync('../other/dir', join(root, 'cwd', 'link'));
  // dieselbe Datei über eine Kette relativer Verweise
  symlinkSync('../kette/b', join(root, 'cwd', 'a'));
  symlinkSync('../other/crm.db', join(root, 'kette', 'b'));
  const cwd = join(root, 'cwd');
  const before = snapshot(join(root, 'other'));
  for (const path of ['link/../crm.db', 'a']) {
    const seen = inDir(cwd, `
      const problem = openProblem(${JSON.stringify(path)});
      return { verdict: problem.verdict, target: problem.target, modes: ['apply', 'app', 'inspect'].map(mode => tryOpen(${JSON.stringify(path)}, mode)) };
    `);
    assert.equal(seen.target, join(root, 'other', 'crm.db'), path);
    assert.equal(seen.verdict, 'invalid-file', path);
    for (const result of seen.modes) assert.match(result, /^UNKNOWN_SCHEMA: .*Seite \d+ fehlt/, path);
    for (const env of [{}, { RAILWAY_ENVIRONMENT_NAME: 'production', PXK_DB_BACKUP_DIR: join(root, 'sicherungen') }]) {
      const result = cli(cwd, [], { SQLITE_PATH: path, ...env });
      assert.equal(result.status, 12, `${path}: ${result.stderr}`);
      assert.match(result.stderr, /keine gültige SQLite-Hauptdatei \(Seite \d+ fehlt/);
    }
    const check = cli(cwd, ['--check'], { SQLITE_PATH: path });
    assert.equal(check.status, 12, check.stdout);
    assert.deepEqual(snapshot(join(root, 'other')), before, `${path}: Hauptdatei und -wal bytegleich, kein -shm`);
    assert.deepEqual(readdirSync(cwd).sort(), ['a', 'link'], `${path}: an der textuellen Stelle nichts angelegt`);
    assert.equal(existsSync(join(root, 'sicherungen')), false, `${path}: keine Sicherung`);
  }
});

test('H-1: relativer Verweis ins Leere, nur das -wal liegt am Ziel — verwaist, nichts angelegt', () => {
  const root = layout();
  writeFileSync(join(root, 'data', 'fehlt.db-wal'), CK.wal);
  const before = snapshot(join(root, 'data'));
  const cwd = join(root, 'cwd');
  assert.equal(inDir(cwd, "return openProblem('dangle').verdict;"), 'orphaned-wal');
  const result = cli(cwd, ['--no-seed'], { SQLITE_PATH: 'dangle' });
  assert.equal(result.status, 12, result.stderr);
  assert.deepEqual(snapshot(join(root, 'data')), before, 'kein Ziel angelegt, -wal bytegleich');
});

test('H-1: Pfad mit Leerraum am Rand (better-sqlite3 kürzt ihn) — abgewiesen, keine Datei berührt', () => {
  const dir = realpathSync(tempDir());
  writeFileSync(join(dir, 'crm.db'), CUT);
  writeFileSync(join(dir, 'crm.db-wal'), CK.wal);
  const before = snapshot(dir);
  for (const path of [`${join(dir, 'crm.db')} `, ` ${join(dir, 'crm.db')}`, `${join(dir, 'crm.db')}\n`]) {
    const seen = inDir(dir, `return { verdict: openProblem(${JSON.stringify(path)}).verdict, apply: tryOpen(${JSON.stringify(path)}, 'apply') };`);
    assert.equal(seen.verdict, 'unsafe-path', JSON.stringify(path));
    assert.match(seen.apply, /^UNKNOWN_SCHEMA: [\s\S]*: Pfad beginnt oder endet mit Leerraum/);
    const result = cli(dir, [], { SQLITE_PATH: path });
    assert.equal(result.status, 12, result.stderr);
  }
  assert.deepEqual(snapshot(dir), before);
});

test('H-1: Symlink zwischen Prüfung und Öffnen umgehängt — openDatabase schließt, bevor SQLite liest', () => {
  const root = realpathSync(tempDir());
  const good = join(root, 'gut');
  const bad = join(root, 'kaputt');
  mkdirSync(good);
  mkdirSync(bad);
  const db = new Database(join(good, 'crm.db'));
  db.exec('CREATE TABLE t (a)');
  db.close();
  writeFileSync(join(bad, 'crm.db'), CUT);
  writeFileSync(join(bad, 'crm.db-wal'), CK.wal);
  const link = join(root, 'crm.db');
  // Ladehaken: better-sqlite3 in lib/db/open.mjs hängt den Symlink unmittelbar vor dem Öffnen um
  const wrapper = join(root, 'umhaengen.mjs');
  writeFileSync(wrapper, `
    import { createRequire } from 'node:module';
    import { symlinkSync, unlinkSync } from 'node:fs';
    const Real = createRequire(${JSON.stringify(PKG)})('better-sqlite3');
    export default function Database(path, options) {
      unlinkSync(${JSON.stringify(link)});
      symlinkSync(${JSON.stringify(join(bad, 'crm.db'))}, ${JSON.stringify(link)});
      return new Real(path, options);
    }
  `);
  const hooks = join(root, 'haken.mjs');
  writeFileSync(hooks, `
    export async function resolve(specifier, context, next) {
      if (specifier === 'better-sqlite3' && context.parentURL?.endsWith('/lib/db/open.mjs')) return { url: ${JSON.stringify(pathToFileURL(wrapper).href)}, shortCircuit: true };
      return next(specifier, context);
    }
  `);
  const register = join(root, 'register.mjs');
  writeFileSync(register, `import { register } from 'node:module'; register(${JSON.stringify(pathToFileURL(hooks).href)});`);
  const before = snapshot(bad);
  for (const mode of ['apply', 'app', 'inspect']) {
    symlinkSync(join(good, 'crm.db'), link);
    const result = inDir(root, `return tryOpen(${JSON.stringify(link)}, ${JSON.stringify(mode)});`, ['--import', register]);
    assert.match(result, /^UNKNOWN_SCHEMA: .*: SQLite öffnete eine andere Datei als geprüft/, mode);
    assert.deepEqual(snapshot(bad), before, `${mode}: umgehängtes Ziel bytegleich, kein -shm, nichts gelesen`);
    rmSync(link);
  }
});
