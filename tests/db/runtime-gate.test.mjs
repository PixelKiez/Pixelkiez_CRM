/**
 * Node-Laufzeit (PXK-113, Option A): unterstützt ist Node >=22.14.0 <23 mit
 * Node-API >= 10 — wie "engines". better-sqlite3 13 stürzt unter Node 22.13
 * (Node-API 9) beim Laden mit SIGSEGV ab; Migration, Bericht, AC3-Prüfstand und
 * App verweigern deshalb vorher mit klarer Meldung (Exit 17 bzw. UNSUPPORTED_RUNTIME).
 *
 * Ältere und neuere Laufzeiten werden hier per --import simuliert (process.versions
 * überschrieben, bevor das Skript lädt). Mit PXK_TEST_NODE_BINARIES=/pfad/node:…
 * laufen dieselben Prüfungen zusätzlich mit echten Node-Binaries.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { EXIT_CODES } from '../../lib/db/errors.mjs';
import { MIN_NODE_API, SUPPORTED_NODE, assertSupportedRuntime, runtimeProblem } from '../../lib/db/runtime.mjs';
import { runAppScript } from './app-modules.mjs';
import { ROOT, tempDir } from './helpers.mjs';

const SCRIPTS = ['scripts/db-migrate.mjs', 'scripts/db-verify-copy.mjs'];
const MESSAGE = /^PXK-DB \[UNSUPPORTED_RUNTIME\] node: Node v[\w.?+-]+ \(Node-API [\w.?+-]+\) wird nicht unterstützt — erforderlich: Node >=22\.14\.0 <23 mit Node-API >= 10/;

/** Preload, das die Laufzeit vor dem Skript als `versions` ausgibt. */
function fakeRuntime(versions) {
  const file = join(tempDir(), 'laufzeit.mjs');
  writeFileSync(file, Object.entries(versions).map(([key, value]) => `Object.defineProperty(process.versions, ${JSON.stringify(key)}, { value: ${JSON.stringify(value)} });`).join('\n'));
  return pathToFileURL(file).href;
}

test('Laufzeitbereich: nur Node 22.x ab 22.14.0 mit Node-API >= 10', () => {
  const cases = [
    [{ node: '22.13.1', napi: '9' }, false],
    [{ node: '22.13.0', napi: '9' }, false],
    [{ node: '22.13.1', napi: '10' }, false],
    [{ node: '22.14.0', napi: '10' }, true],
    [{ node: '22.23.3', napi: '10' }, true],
    [{ node: '22.99.0', napi: '11' }, true],
    [{ node: '22.14.0', napi: '9' }, false],
    [{ node: '22.14.0-pre', napi: '10' }, false],
    [{ node: '23.0.0', napi: '10' }, false],
    [{ node: '26.10.0', napi: '10' }, false],
    [{ node: '21.7.3', napi: '9' }, false],
    [{ node: '22.14.0' }, false],
    [{ napi: '10' }, false],
    [{ node: 'x', napi: 'y' }, false],
  ];
  for (const [versions, supported] of cases) {
    assert.equal(runtimeProblem(versions) === null, supported, JSON.stringify(versions));
    if (!supported) assert.match(`PXK-DB [UNSUPPORTED_RUNTIME] node: ${runtimeProblem(versions)}`, MESSAGE, JSON.stringify(versions));
  }
  assert.throws(() => assertSupportedRuntime({ node: '22.13.1', napi: '9' }), { code: 'UNSUPPORTED_RUNTIME', exitCode: 17 });
  assert.equal(EXIT_CODES.UNSUPPORTED_RUNTIME, 17);
  assert.equal(MIN_NODE_API, 10);
  assert.equal(runtimeProblem(), null, 'die Testlaufzeit selbst liegt im Bereich');
});

test('engines in package.json und package-lock.json sind genau der geprüfte Bereich', () => {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
  const lock = JSON.parse(readFileSync(join(ROOT, 'package-lock.json'), 'utf8'));
  assert.equal(SUPPORTED_NODE, '>=22.14.0 <23');
  assert.equal(pkg.engines.node, SUPPORTED_NODE);
  assert.equal(lock.packages[''].engines.node, SUPPORTED_NODE);
  assert.equal(pkg.dependencies['better-sqlite3'], '^13.0.3', 'kein Downgrade von better-sqlite3');
});

test('Skripte: die Laufzeitprüfung ist der erste Import (vor better-sqlite3 und lib/db)', () => {
  for (const script of SCRIPTS) {
    const first = readFileSync(join(ROOT, script), 'utf8').split('\n').find(line => /^import\b/.test(line));
    assert.equal(first, "import '../lib/db/runtime-gate.mjs';", script);
  }
});

test('simuliert Node 22.13.1 (Node-API 9) und 23.0.0: jedes Skript endet mit Exit 17 vor jedem Dateizugriff', () => {
  for (const versions of [{ node: '22.13.1', napi: '9' }, { node: '23.0.0', napi: '10' }, { node: '22.14.0', napi: '9' }]) {
    const preload = fakeRuntime(versions);
    for (const [script, args] of [[SCRIPTS[0], []], [SCRIPTS[0], ['--report']], [SCRIPTS[0], ['--check']], [SCRIPTS[1], []]]) {
      const db = join(tempDir(), 'crm.db');
      const result = spawnSync(process.execPath, ['--import', preload, join(ROOT, script), ...args], {
        cwd: ROOT,
        env: { PATH: process.env.PATH, HOME: process.env.HOME, SQLITE_PATH: db },
        encoding: 'utf8',
      });
      const label = `${versions.node}/${versions.napi} ${script} ${args.join(' ')}`;
      assert.equal(result.signal, null, `${label}: kein Absturz`);
      assert.equal(result.status, 17, `${label}: ${result.stderr}`);
      assert.match(result.stderr, MESSAGE, label);
      assert.equal(result.stdout, '', `${label}: nichts weiter ausgegeben`);
      assert.equal(existsSync(db), false, `${label}: keine Datenbank angelegt`);
    }
  }
});

test('simuliert Node 22.13.1: die App verweigert (UNSUPPORTED_RUNTIME), bevor sie die migrierte Datenbank öffnet', () => {
  const dir = tempDir();
  const db = join(dir, 'crm.db');
  const setup = spawnSync(process.execPath, [join(ROOT, SCRIPTS[0]), '--no-seed'], { cwd: ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME, SQLITE_PATH: db }, encoding: 'utf8' });
  assert.equal(setup.status, 0, setup.stderr);
  const before = { files: readdirSync(dir).sort(), main: readFileSync(db) };
  const refused = runAppScript({
    env: { SQLITE_PATH: db, NODE_OPTIONS: `--import=${fakeRuntime({ node: '22.13.1', napi: '9' })}` },
    body: 'await app.ensureDatabase(); return true;',
  });
  assert.equal(refused.error?.code, 'UNSUPPORTED_RUNTIME', JSON.stringify(refused));
  assert.match(refused.error.message, /erforderlich: Node >=22\.14\.0 <23 mit Node-API >= 10/);
  assert.deepEqual({ files: readdirSync(dir).sort(), main: readFileSync(db) }, before, 'nicht geöffnet: kein -wal/-shm, Datei bytegleich');
  // dieselbe Datei unter unterstützter Laufzeit: bereit
  assert.deepEqual(runAppScript({ env: { SQLITE_PATH: db }, body: 'await app.ensureDatabase(); return true;' }), { value: true });
});

const binaries = (process.env.PXK_TEST_NODE_BINARIES ?? '').split(':').filter(Boolean);
test('echte Node-Binaries (PXK_TEST_NODE_BINARIES): unterstützte migrieren, ältere/neuere enden mit Exit 17 — nie SIGSEGV', { skip: !binaries.length && 'PXK_TEST_NODE_BINARIES nicht gesetzt' }, () => {
  for (const bin of binaries) {
    const versions = JSON.parse(spawnSync(bin, ['-p', 'JSON.stringify(process.versions)'], { encoding: 'utf8' }).stdout);
    const supported = runtimeProblem(versions) === null;
    const db = join(tempDir(), 'crm.db');
    const migrate = spawnSync(bin, [join(ROOT, SCRIPTS[0]), '--no-seed'], { cwd: ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME, SQLITE_PATH: db }, encoding: 'utf8' });
    const harness = spawnSync(bin, [join(ROOT, SCRIPTS[1])], { cwd: ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME }, encoding: 'utf8' });
    const label = `v${versions.node} (Node-API ${versions.napi})`;
    for (const result of [migrate, harness]) assert.equal(result.signal, null, `${label}: kein Absturz (${result.signal})`);
    if (supported) {
      assert.equal(migrate.status, 0, `${label}: ${migrate.stderr}`);
      assert.match(migrate.stdout, /^PXK-DB ok head=1 applied 0001_baseline$/m, label);
      assert.equal(harness.status, 2, `${label}: Prüfstand läuft bis zur Argumentprüfung`);
    } else {
      for (const result of [migrate, harness]) {
        assert.equal(result.status, 17, `${label}: ${result.stderr}`);
        assert.match(result.stderr, MESSAGE, label);
      }
      assert.equal(existsSync(db), false, `${label}: keine Datenbank angelegt`);
    }
  }
});
