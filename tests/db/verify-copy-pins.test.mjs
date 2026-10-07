/**
 * M-1: „cleanup=verified“ nur, wenn nachweislich kein Klartext des AC3-Prüfstands
 * übrig ist (scripts/db-verify-copy-scratch.mjs). Jeder Eingriff von außen —
 * Ordner gesperrt, verschoben, ersetzt, durch einen Symlink getauscht — endet mit
 * FAIL (Exit 3), und nichts Fremdes wird gelöscht. Gegenstück zu den
 * M-4-Fällen in tests/db/verify-copy-cleanup.test.mjs.
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { harness, project, sha, skip, source } from './ac3-helpers.mjs';
import { tempDir } from './helpers.mjs';

const snapshot = (dir) => Object.fromEntries(readdirSync(dir).sort().map(name => [name, name.endsWith('-shm') ? 'vorhanden' : sha(join(dir, name))]));

/**
 * M-1: Eingriff von außen nach dem letzten Lesen der Quelle, also unmittelbar
 * vor dem Aufräumen — der Lauf wäre sonst PASS. Ein Vorab-Modul (--import)
 * hängt sich an readFileSync des Prüfstands und greift beim zweiten Lesen der
 * Quelle (contentFiles am Ende von compare) ein.
 */
function interfering(source, script) {
  const preload = join(tempDir(), 'eingriff.mjs');
  writeFileSync(preload, `
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    const fs = createRequire(import.meta.url)('node:fs');
    const read = fs.readFileSync;
    let reads = 0;
    fs.readFileSync = function (path, ...rest) {
      const value = read.call(this, path, ...rest);
      if (path === ${JSON.stringify(realpathSync(source))} && ++reads === 2) { ${script} }
      return value;
    };
    syncBuiltinESMExports();
  `);
  return preload;
}
const harnessWith = (preload, args) => {
  const result = spawnSync(process.execPath, ['--import', preload, join(project(), 'scripts', 'db-verify-copy.mjs'), ...args], {
    cwd: tempDir(),
    env: { PATH: process.env.PATH, HOME: process.env.HOME },
    encoding: 'utf8',
  });
  const lines = result.stdout.split('\n').filter(Boolean);
  return { ...result, value: (prefix) => lines.find(l => l.startsWith(`PXK-AC3 ${prefix}`)) };
};
/** Klartext, den der Prüfstand angelegt hat, liegt noch (hier: unter `dir`). */
const plaintextLeft = (dir) => readdirSync(dir, { recursive: true }).some(entry => /ac3-[^/]+\/copy\.db$/.test(entry));

test('M-1 unerreichbar ist nicht gelöscht: Elternordner nach dem letzten Lesen gesperrt (0000) → Exit 3, nie PASS', { skip }, () => {
  const { dir, path } = source();
  const before = snapshot(dir);
  const parent = tempDir();
  const result = harnessWith(interfering(path, `fs.chmodSync(${JSON.stringify(parent)}, 0o000);`), [`--source=${path}`, `--workdir=${join(parent, 'arbeit')}`]);
  try {
    assert.equal(result.status, 3, result.stdout + result.stderr);
    assert.equal(result.value('failures='), 'PXK-AC3 failures=cleanup');
    assert.equal(result.value('cleanup='), 'PXK-AC3 cleanup=FAILED');
    assert.equal(result.value('verdict='), 'PXK-AC3 verdict=FAIL');
  } finally {
    chmodSync(parent, 0o700);
  }
  assert.ok(plaintextLeft(parent), 'die Klartext-Kopie liegt tatsächlich noch dort — „verified“ wäre falsch gewesen');
  assert.deepEqual(snapshot(dir), before, 'Quelle unverändert');
  rmSync(join(parent, 'arbeit'), { recursive: true, force: true });
});

test('M-1 umbenannter Elternordner: der Klartext liegt woanders → Exit 3, nie PASS', { skip }, () => {
  const { dir, path } = source();
  const before = snapshot(dir);
  const parent = join(tempDir(), 'eltern');
  mkdirSync(parent);
  const moved = `${parent}-verschoben`;
  const result = harnessWith(interfering(path, `fs.renameSync(${JSON.stringify(parent)}, ${JSON.stringify(moved)});`), [`--source=${path}`, `--workdir=${join(parent, 'arbeit')}`]);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.equal(result.value('cleanup='), 'PXK-AC3 cleanup=FAILED');
  assert.equal(result.value('verdict='), 'PXK-AC3 verdict=FAIL');
  assert.ok(plaintextLeft(moved), 'Klartext unter dem verschobenen Ordner');
  assert.deepEqual(snapshot(dir), before);
  rmSync(moved, { recursive: true, force: true });
});

test('M-1 ersetzter Arbeitsordner: der fremde Ordner wird nicht gelöscht, der eigene ist nicht nachweislich weg → Exit 3', { skip }, () => {
  const { path } = source();
  const parent = tempDir();
  const work = join(parent, 'arbeit');
  const result = harnessWith(interfering(path, `fs.renameSync(${JSON.stringify(work)}, ${JSON.stringify(`${work}-alt`)}); fs.mkdirSync(${JSON.stringify(work)}); fs.writeFileSync(${JSON.stringify(join(work, 'fremd.txt'))}, 'nicht vom Prüfstand');`), [`--source=${path}`, `--workdir=${work}`]);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.equal(result.value('cleanup='), 'PXK-AC3 cleanup=FAILED');
  assert.equal(readFileSync(join(work, 'fremd.txt'), 'utf8'), 'nicht vom Prüfstand', 'fremder Ordner unberührt');
  assert.ok(plaintextLeft(`${work}-alt`));
});

test('M-1 Gegenprobe: dasselbe Vorab-Modul ohne Eingriff → PASS, cleanup=verified', { skip }, () => {
  const { path } = source();
  const parent = tempDir();
  const result = harnessWith(interfering(path, ''), [`--source=${path}`, `--workdir=${join(parent, 'arbeit')}`]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.equal(result.value('cleanup='), 'PXK-AC3 cleanup=verified');
  assert.equal(result.value('verdict='), 'PXK-AC3 verdict=PASS');
  assert.deepEqual(readdirSync(parent), []);
});

test('M-1 Symlink über dem Arbeitsordner (macOS: /tmp) und Arbeitsordner als Symlink: PASS, nichts bleibt zurück', { skip }, () => {
  const { path } = source();
  const base = tempDir();
  mkdirSync(join(base, 'echt'));
  symlinkSync(join(base, 'echt'), join(base, 'verweis'));
  const created = harness([`--source=${path}`, `--workdir=${join(base, 'verweis', 'neu', 'arbeit')}`]);
  assert.equal(created.status, 0, created.stdout + created.stderr);
  assert.equal(created.value('cleanup='), 'PXK-AC3 cleanup=verified');
  assert.deepEqual(readdirSync(join(base, 'echt')), [], 'angelegte Ordner hinter dem Symlink entfernt');
  mkdirSync(join(base, 'leer'));
  symlinkSync(join(base, 'leer'), join(base, 'arbeit-verweis'));
  const linked = harness([`--source=${path}`, `--workdir=${join(base, 'arbeit-verweis')}`]);
  assert.equal(linked.status, 0, linked.stdout + linked.stderr);
  assert.equal(linked.value('cleanup='), 'PXK-AC3 cleanup=verified');
  assert.deepEqual(readdirSync(join(base, 'leer')), [], 'vorhandener Arbeitsordner wieder leer');
});

test('M-1 ac3-Ordner vor dem Aufräumen verschoben oder durch einen fremden ersetzt: Exit 3, nichts Fremdes gelöscht', { skip }, () => {
  const { path } = source();
  const parent = tempDir();
  const work = join(parent, 'neu', 'arbeit');
  const elsewhere = join(parent, 'woanders');
  // verschoben: der angelegte Arbeitsordner bleibt, sein ac3-Ordner liegt nun außerhalb
  const moved = harnessWith(interfering(path, `
    const dir = ${JSON.stringify(work)};
    const ac3 = fs.readdirSync(dir).find(name => name.startsWith('ac3-'));
    fs.renameSync(dir + '/' + ac3, ${JSON.stringify(elsewhere)});
  `), [`--source=${path}`, `--workdir=${work}`]);
  assert.equal(moved.status, 3, moved.stdout + moved.stderr);
  assert.equal(moved.value('cleanup='), 'PXK-AC3 cleanup=FAILED');
  assert.ok(existsSync(join(elsewhere, 'copy.db')), 'die Kopie liegt verschoben noch da — „verified“ wäre falsch gewesen');
  rmSync(elsewhere, { recursive: true, force: true });
  rmSync(join(parent, 'neu'), { recursive: true, force: true });
  // ersetzt: an der Stelle des ac3-Ordners liegt ein fremder Ordner
  const replaced = harnessWith(interfering(path, `
    const dir = ${JSON.stringify(work)};
    const ac3 = fs.readdirSync(dir).find(name => name.startsWith('ac3-'));
    fs.renameSync(dir + '/' + ac3, ${JSON.stringify(elsewhere)});
    fs.mkdirSync(dir + '/' + ac3);
    fs.writeFileSync(dir + '/' + ac3 + '/fremd.txt', 'nicht vom Prüfstand');
  `), [`--source=${path}`, `--workdir=${work}`]);
  assert.equal(replaced.status, 3, replaced.stdout + replaced.stderr);
  assert.equal(replaced.value('cleanup='), 'PXK-AC3 cleanup=FAILED');
  const ac3 = readdirSync(work).find(name => name.startsWith('ac3-'));
  assert.equal(readFileSync(join(work, ac3, 'fremd.txt'), 'utf8'), 'nicht vom Prüfstand', 'fremder Ordner unberührt');
  // durch einen Symlink auf den verschobenen ersetzt: derselbe Ordner hinter einem Verweis zählt nicht
  const other = join(tempDir(), 'neu', 'arbeit');
  const behind = join(tempDir(), 'dahinter');
  const linked = harnessWith(interfering(path, `
    const dir = ${JSON.stringify(other)};
    const ac3 = fs.readdirSync(dir).find(name => name.startsWith('ac3-'));
    fs.renameSync(dir + '/' + ac3, ${JSON.stringify(behind)});
    fs.symlinkSync(${JSON.stringify(behind)}, dir + '/' + ac3);
  `), [`--source=${path}`, `--workdir=${other}`]);
  assert.equal(linked.status, 3, linked.stdout + linked.stderr);
  assert.equal(linked.value('cleanup='), 'PXK-AC3 cleanup=FAILED');
  assert.ok(existsSync(join(behind, 'copy.db')), 'die Kopie liegt hinter dem Verweis noch da');
});

test('M-1 Ordner verschwindet zwischen Prüfung und Löschen: kein stilles „gelöscht“ (Exit 3)', { skip }, () => {
  const { path } = source();
  const parent = tempDir();
  const work = join(parent, 'arbeit');
  const elsewhere = join(parent, 'weg');
  const preload = join(tempDir(), 'loeschen.mjs');
  writeFileSync(preload, `
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    const fs = createRequire(import.meta.url)('node:fs');
    const rm = fs.rmSync;
    fs.rmSync = function (target, ...rest) {
      if (target === ${JSON.stringify(work)}) fs.renameSync(target, ${JSON.stringify(elsewhere)});
      return rm.call(this, target, ...rest);
    };
    syncBuiltinESMExports();
  `);
  const result = harnessWith(preload, [`--source=${path}`, `--workdir=${work}`]);
  assert.equal(result.status, 3, result.stdout + result.stderr);
  assert.equal(result.value('cleanup='), 'PXK-AC3 cleanup=FAILED');
  assert.ok(plaintextLeft(elsewhere));
});

test('M-1 angelegter Ordner (oberster, dazwischen, Arbeitsordner) vor dem Aufräumen durch einen Symlink ersetzt: Exit 3, Klartext liegt woanders', { skip }, () => {
  const { path } = source();
  for (const level of ['neu', join('neu', 'zwei'), join('neu', 'zwei', 'arbeit')]) {
    // frischer Elternordner: neu/zwei/arbeit legt der Prüfstand alle selbst an
    const fresh = tempDir();
    const swapped = join(fresh, level);
    const moved = join(fresh, 'woanders');
    const result = harnessWith(interfering(path, `
      fs.renameSync(${JSON.stringify(swapped)}, ${JSON.stringify(moved)});
      fs.symlinkSync(${JSON.stringify(moved)}, ${JSON.stringify(swapped)});
    `), [`--source=${path}`, `--workdir=${join(fresh, 'neu', 'zwei', 'arbeit')}`]);
    assert.equal(result.status, 3, `${level}: ${result.stdout}${result.stderr}`);
    assert.equal(result.value('cleanup='), 'PXK-AC3 cleanup=FAILED', level);
    assert.ok(plaintextLeft(moved), `${level}: die Kopie liegt im verschobenen Ordner`);
  }
});

test('AC3-Prüfstand nennt den Grund einer abgewiesenen Quelle und rät, alle drei Dateien zu kopieren (hier: -shm nicht lesbar)', { skip }, () => {
  const { dir, path } = source({ walRows: 50 });
  assert.ok(existsSync(`${path}-shm`), 'Quelle mit -wal und -shm');
  const before = snapshot(dir);
  chmodSync(`${path}-shm`, 0o000);
  let result;
  try {
    result = harness([`--source=${path}`, `--workdir=${join(tempDir(), 'arbeit')}`]);
  } finally {
    chmodSync(`${path}-shm`, 0o600);
  }
  assert.equal(result.status, 2, result.stdout + result.stderr);
  assert.match(result.stderr, /^PXK-AC3 refused=Quelle ist keine gültige SQLite-Datei \(der WAL-Index \(-shm\) neben der Datei ist nicht lesbar/);
  assert.match(result.stderr, /vor jedem Blick mit SQLite alle drei Dateien kopieren/);
  assert.doesNotMatch(result.stderr, /\/(private|var|tmp|Users|home)\//, 'keine Pfade');
  assert.deepEqual(snapshot(dir), before, 'Quelle, -wal und -shm unverändert');
});

test('M-1 ac3-XXXXXX nicht anlegbar, nachdem der Prüfstand den Arbeitsordner angelegt hat: angelegte Ordner wieder entfernt, cleanup=verified', { skip }, () => {
  const { path } = source();
  const parent = tempDir();
  const preload = join(tempDir(), 'voll.mjs');
  writeFileSync(preload, `
    import { createRequire, syncBuiltinESMExports } from 'node:module';
    const fs = createRequire(import.meta.url)('node:fs');
    fs.mkdtempSync = () => { throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' }); };
    syncBuiltinESMExports();
  `);
  const result = harnessWith(preload, [`--source=${path}`, `--workdir=${join(parent, 'neu', 'arbeit')}`]);
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stderr, /^PXK-AC3 error=ENOSPC\nPXK-AC3 cleanup=verified$/m);
  assert.deepEqual(readdirSync(parent), [], 'neu/arbeit wieder entfernt');
});

test('M-1 Löschen meldet Erfolg, nachgewiesen ist es nicht: danach unerreichbar (EACCES statt ENOENT) oder Ordner darüber ausgetauscht → Exit 3', { skip }, () => {
  const { path } = source();
  const hooks = {
    // löscht nichts, sperrt den Ordner darüber: lstat meldet EACCES — kein Nachweis
    gesperrt: (parent) => `fs.chmodSync(${JSON.stringify(parent)}, 0o000); return;`,
    // tauscht vorher den Ordner darüber aus: gelöscht wird ein Doppelgänger, der eigene liegt woanders
    getauscht: (parent) => `fs.renameSync(${JSON.stringify(parent)}, ${JSON.stringify(`${parent}-alt`)}); fs.mkdirSync(target, { recursive: true });`,
  };
  for (const [name, hook] of Object.entries(hooks)) {
    const parent = join(tempDir(), 'eltern');
    mkdirSync(parent);
    const work = join(parent, 'neu');
    const preload = join(tempDir(), 'loeschen.mjs');
    writeFileSync(preload, `
      import { createRequire, syncBuiltinESMExports } from 'node:module';
      const fs = createRequire(import.meta.url)('node:fs');
      const rm = fs.rmSync;
      fs.rmSync = function (target, ...rest) {
        if (target === ${JSON.stringify(work)}) { ${hook(parent)} }
        return rm.call(this, target, ...rest);
      };
      syncBuiltinESMExports();
    `);
    try {
      const result = harnessWith(preload, [`--source=${path}`, `--workdir=${work}`]);
      assert.equal(result.status, 3, `${name}: ${result.stdout}${result.stderr}`);
      assert.equal(result.value('cleanup='), 'PXK-AC3 cleanup=FAILED', name);
    } finally {
      if (existsSync(parent)) chmodSync(parent, 0o700);
    }
    assert.ok(plaintextLeft(name === 'gesperrt' ? parent : `${parent}-alt`), `${name}: der Klartext liegt noch da`);
  }
});
