/**
 * Release B (PXK-113): Die App legt kein Schema mehr an (AC5) und öffnet nur
 * eine Datenbank, die der Pre-Start-Schritt migriert hat.
 *
 * Statisch über den Quelltext (Literale per AST) und ausführend über
 * ensureDatabase() aus lib/database.ts in einem eigenen Prozess je Szenario
 * (tests/db/app-modules.mjs, ohne Next.js und ohne Loader-Hooks).
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { contentDigest, fingerprint } from '../../lib/db/fingerprint.mjs';
import { runMigrations } from '../../lib/db/migrate.mjs';
import { openDatabase } from '../../lib/db/open.mjs';
import { runSeeds } from '../../lib/db/seed.mjs';
import { DDL_PATTERN, runAppScript, stringLiterals } from './app-modules.mjs';
import { MIGRATIONS_DIR, ROOT, buildLegacy, insertSyntheticRows, ledgerRows, tempDir } from './helpers.mjs';

const sha = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');
const sidecars = (path) => ['-wal', '-shm', '-journal'].filter(suffix => existsSync(path + suffix));

/** Alles, was ein Schreibzugriff ändern könnte — ohne die Datei für Schreiber zu öffnen. */
function snapshot(path) {
  const db = openDatabase(path, 'inspect');
  try {
    return {
      objects: db.prepare('SELECT type, name, sql FROM sqlite_master ORDER BY type, name').all(),
      schema: fingerprint(db).hashes,
      ledger: ledgerRows(db),
      userVersion: db.pragma('user_version', { simple: true }),
      digest: contentDigest(db),
    };
  } finally {
    db.close();
  }
}

/** Migriert und befüllt (wie npm start), dann sauber geschlossen. */
async function migratedDb() {
  const path = join(tempDir(), 'crm.db');
  const db = openDatabase(path, 'apply');
  await runMigrations(db, { migrationsDir: MIGRATIONS_DIR, production: false, backup: false });
  runSeeds(db);
  db.close();
  return path;
}

const ensure = (path, options = {}) => runAppScript({ ...options, env: { SQLITE_PATH: path, ...options.env }, body: 'await app.ensureDatabase(); return true;' });

test('AC5 statisch: lib/database.ts und lib/d1-node.ts enthalten kein DDL, kein migrateColumns und keine Seeds', () => {
  for (const file of ['lib/database.ts', 'lib/d1-node.ts']) {
    const ddl = stringLiterals(file).filter(text => DDL_PATTERN.test(text));
    assert.deepEqual(ddl, [], `${file}: DDL in Literalen`);
    assert.deepEqual(stringLiterals(file).filter(text => /\bINSERT\s+INTO\b/i.test(text)), [], `${file}: Seeds`);
  }
  const source = readFileSync(join(ROOT, 'lib/database.ts'), 'utf8');
  for (const gone of ['migrateColumns', 'createStatements', 'LEAD_COLUMNS', 'seedTemplatesIfEmpty', 'SEED_TEMPLATES', 'DOCUMENT_TEMPLATES', 'leads.json', 'PRAGMA optimize']) {
    assert.equal(source.includes(gone), false, `lib/database.ts enthält noch ${gone}`);
  }
  // Der Rumpf von ensureDatabase() führt selbst kein SQL aus.
  const body = /export async function ensureDatabase\(\) \{([\s\S]*?)\n\}/.exec(source)?.[1];
  assert.ok(body !== undefined, 'ensureDatabase() nicht gefunden');
  assert.doesNotMatch(body, /\b(prepare|exec|run|pragma|batch)\s*\(/);
  // Die Verbindungsschicht legt weder Ordner noch Datei an.
  assert.doesNotMatch(readFileSync(join(ROOT, 'lib/d1-node.ts'), 'utf8'), /\bmkdirSync\b|new Database\(/);
});

test('AC5 ausführend: ensureDatabase() auf migrierter Datenbank ändert weder Schema noch Daten noch Datei', async () => {
  const path = await migratedDb();
  const before = snapshot(path);
  const fileBefore = sha(path);
  const result = runAppScript({
    env: { SQLITE_PATH: path },
    body: "await app.ensureDatabase(); await app.ensureDatabase(); return (await app.getD1().prepare('SELECT count(*) AS c FROM leads').first()).c;",
  });
  assert.deepEqual(result, { value: 952 });
  assert.deepEqual(snapshot(path), before);
  assert.equal(sha(path), fileBefore, 'Hauptdatei unverändert');
  if (existsSync(`${path}-wal`)) assert.equal(statSync(`${path}-wal`).size, 0, 'keine WAL-Frames geschrieben');
});

test('App gegen fehlende Datei: DB_NOT_MIGRATED, weder Datei noch Ordner angelegt', () => {
  const dir = tempDir();
  const path = join(dir, 'unterordner', 'crm.db');
  const result = ensure(path);
  assert.equal(result.error?.code, 'DB_NOT_MIGRATED');
  assert.match(result.error.message, /npm run db:migrate/);
  assert.deepEqual(readdirSync(dir), []);
});

test('App gegen leere 0-Byte-Datei: DB_NOT_MIGRATED, Datei bleibt 0 Byte (kein WAL-Header)', () => {
  const path = join(tempDir(), 'crm.db');
  writeFileSync(path, '');
  const result = ensure(path);
  assert.equal(result.error?.code, 'DB_NOT_MIGRATED');
  assert.equal(statSync(path).size, 0);
  assert.deepEqual(sidecars(path), []);
});

test('App gegen leere Hauptdatei mit nicht leerem -wal: DB_NOT_MIGRATED ohne Öffnen, das -wal bleibt bytegleich', async () => {
  const { default: Database } = await import('better-sqlite3');
  const dir = tempDir();
  const path = join(dir, 'crm.db');
  const writer = new Database(join(dir, 'schreiber.db'));
  writer.pragma('journal_mode = WAL');
  writer.pragma('wal_autocheckpoint = 0');
  writer.exec("CREATE TABLE t (a); INSERT INTO t VALUES ('nur im WAL')");
  copyFileSync(join(dir, 'schreiber.db-wal'), `${path}-wal`);
  writer.close();
  writeFileSync(path, '');
  const wal = sha(`${path}-wal`);
  const result = ensure(path);
  assert.equal(result.error?.code, 'DB_NOT_MIGRATED');
  assert.match(result.error.message, /Datenbankdatei ist leer/);
  assert.equal(sha(`${path}-wal`), wal);
  assert.equal(statSync(path).size, 0);
});

test('App gegen Altstand ohne Ledger (cd2c098, S5): DB_NOT_MIGRATED, kein CREATE/ALTER, keine Seeds', () => {
  const path = join(tempDir(), 'crm.db');
  const legacy = buildLegacy(path, 'S5');
  insertSyntheticRows(legacy);
  legacy.prepare("DELETE FROM email_templates WHERE id = (SELECT min(id) FROM email_templates)").run();
  legacy.close();
  const before = snapshot(path);
  const result = ensure(path);
  assert.equal(result.error?.code, 'DB_NOT_MIGRATED');
  assert.deepEqual(snapshot(path), before, 'weder Schema noch Vorlagen nachgezogen');
  assert.equal(snapshot(path).ledger, null);
});

test('App gegen ausstehende Migration: MIGRATIONS_PENDING, nichts angewandt', async () => {
  const path = await migratedDb();
  const project = tempDir();
  mkdirSync(join(project, 'db', 'migrations'), { recursive: true });
  copyFileSync(join(MIGRATIONS_DIR, '0001_baseline.sql'), join(project, 'db', 'migrations', '0001_baseline.sql'));
  writeFileSync(join(project, 'db', 'migrations', '0002_district.sql'), 'ALTER TABLE leads ADD COLUMN district TEXT;\n');
  const before = snapshot(path);
  const result = ensure(path, { cwd: project });
  assert.equal(result.error?.code, 'MIGRATIONS_PENDING');
  assert.match(result.error.message, /0002_district/);
  assert.deepEqual(snapshot(path), before);
});

test('App gegen Schemaabweichung (SCHEMA_DRIFT) und veränderte Ledger-Prüfsumme (CHECKSUM_MISMATCH): verweigert, nichts repariert', async () => {
  const drift = await migratedDb();
  const db = openDatabase(drift, 'apply');
  db.exec('ALTER TABLE leads ADD COLUMN eigenmaechtig TEXT');
  db.close();
  const driftBefore = snapshot(drift);
  assert.equal(ensure(drift).error?.code, 'SCHEMA_DRIFT');
  assert.deepEqual(snapshot(drift), driftBefore);

  const tampered = await migratedDb();
  const t = openDatabase(tampered, 'apply');
  t.prepare("UPDATE schema_migrations SET checksum = 'manipuliert' WHERE version = 1").run();
  t.close();
  const tamperedBefore = snapshot(tampered);
  assert.equal(ensure(tampered).error?.code, 'CHECKSUM_MISMATCH');
  assert.deepEqual(snapshot(tampered), tamperedBefore);
});

test('App gegen beschädigte oder fremde Datei: Fehler, Datei unverändert, kein WAL angelegt', () => {
  for (const [name, bytes] of [['fremd', Buffer.alloc(4096, 0x5a)], ['nur-kopf', Buffer.concat([Buffer.from('SQLite format 3\0'), Buffer.alloc(84)])]]) {
    const path = join(tempDir(), `${name}.db`);
    writeFileSync(path, bytes);
    const before = sha(path);
    const result = ensure(path);
    assert.ok(result.error, `${name}: Fehler erwartet`);
    assert.match(String(result.error.code), /^SQLITE_(NOTADB|CORRUPT)/, name);
    assert.equal(sha(path), before, name);
    assert.deepEqual(sidecars(path), [], name);
  }
});

test('ein Fehlschlag bleibt nicht hängen: nach der Migration gelingt der nächste Zugriff im selben Prozess', () => {
  const path = join(tempDir(), 'crm.db');
  const migrate = pathToFileURL(join(ROOT, 'lib/db/migrate.mjs')).href;
  const open = pathToFileURL(join(ROOT, 'lib/db/open.mjs')).href;
  const result = runAppScript({
    env: { SQLITE_PATH: path },
    body: `
      let first = null;
      try { await app.ensureDatabase(); } catch (error) { first = error.code; }
      const { runMigrations } = await import(${JSON.stringify(migrate)});
      const { openDatabase } = await import(${JSON.stringify(open)});
      const db = openDatabase(process.env.SQLITE_PATH, 'apply');
      await runMigrations(db, { production: false, backup: false });
      db.close();
      await app.ensureDatabase();
      return { first, leads: (await app.getD1().prepare('SELECT count(*) AS c FROM leads').first()).c };
    `,
  });
  assert.deepEqual(result, { value: { first: 'DB_NOT_MIGRATED', leads: 0 } });
});
