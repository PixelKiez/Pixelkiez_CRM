import assert from 'node:assert/strict';
import { openSync, readdirSync, statSync, writeFileSync, writeSync, closeSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { contentDigest, fingerprint, sameFingerprint } from '../../lib/db/fingerprint.mjs';
import { runMigrations } from '../../lib/db/migrate.mjs';
import { MIGRATIONS_DIR, buildLegacy, errorCode, insertSyntheticRows, ledgerRows, tempDir } from './helpers.mjs';

/** Legacy-Datenbank mit Daten; Übernahme mit den angegebenen Sicherungsoptionen. */
async function adoptWithBackup(backupOptions) {
  const dir = tempDir();
  const db = buildLegacy(join(dir, 'crm.db'), 'S5');
  insertSyntheticRows(db);
  const digest = contentDigest(db);
  const backups = join(dir, 'backups');
  const error = await errorCode(() => runMigrations(db, { migrationsDir: MIGRATIONS_DIR, backup: { dir: backups, ...backupOptions } }));
  return { db, digest, error, backups };
}

test('Sicherung einer WAL-Datenbank ist vollständig, geprüft und im DELETE-Modus', async () => {
  const dir = tempDir();
  const db = buildLegacy(join(dir, 'crm.db'), 'S5');
  insertSyntheticRows(db, 5);
  const digest = contentDigest(db);
  const fp = fingerprint(db);
  const { backup } = await runMigrations(db, { migrationsDir: MIGRATIONS_DIR, backup: { dir: join(dir, 'backups') } });
  const copy = new Database(backup.path, { readonly: true });
  assert.equal(copy.pragma('integrity_check', { simple: true }), 'ok');
  assert.equal(copy.pragma('journal_mode', { simple: true }), 'delete');
  assert.deepEqual(contentDigest(copy), digest);
  assert.ok(sameFingerprint(fingerprint(copy), fp));
  assert.equal(ledgerRows(copy), null, 'Sicherung zeigt den Stand vor der Übernahme');
  copy.close();
  db.close();
});

test('Schreibzugriff zwischen Sicherung und Migration → BACKUP_STALE, nichts geschrieben', async () => {
  const dir = tempDir();
  const db = buildLegacy(join(dir, 'crm.db'), 'S5');
  insertSyntheticRows(db);
  const error = await errorCode(() => runMigrations(db, {
    migrationsDir: MIGRATIONS_DIR,
    backup: { dir: join(dir, 'backups') },
    hooks: { beforeLock: conn => conn.prepare("INSERT INTO settings (key, value) VALUES ('parallel', 'x')").run() },
  }));
  assert.equal(error?.code, 'BACKUP_STALE');
  assert.equal(ledgerRows(db), null);
  db.close();
});

test('Sicherungsziel nicht anlegbar → BACKUP_FAILED, Quelle unberührt', async () => {
  const dir = tempDir();
  const db = buildLegacy(join(dir, 'crm.db'), 'S5');
  insertSyntheticRows(db);
  const digest = contentDigest(db);
  const blocker = join(dir, 'datei-statt-ordner');
  writeFileSync(blocker, 'x');
  const error = await errorCode(() => runMigrations(db, { migrationsDir: MIGRATIONS_DIR, backup: { dir: join(blocker, 'backups') } }));
  assert.equal(error?.code, 'BACKUP_FAILED');
  assert.equal(ledgerRows(db), null);
  assert.deepEqual(contentDigest(db), digest);
  db.close();
});

test('Sicherung, deren Prüfung scheitert → BACKUP_FAILED, Kopie als .unverified, nichts migriert', async () => {
  const cases = {
    integrity_check: (path) => {
      // Freelist-Zähler im Header verfälschen: Lesen geht, nur integrity_check schlägt an
      const fd = openSync(path, 'r+');
      const count = Buffer.alloc(4);
      count.writeUInt32BE(5);
      writeSync(fd, count, 0, 4, 36);
      closeSync(fd);
    },
    'Schema der Kopie': (path) => {
      const copy = new Database(path);
      copy.exec('CREATE TABLE nur_in_kopie (x)');
      copy.close();
    },
    'Inhalt der Kopie': (path) => {
      const copy = new Database(path);
      copy.exec("UPDATE leads SET name = 'anders'");
      copy.close();
    },
  };
  for (const [reason, afterCopy] of Object.entries(cases)) {
    const { db, digest, error, backups } = await adoptWithBackup({ afterCopy });
    assert.equal(error?.code, 'BACKUP_FAILED', reason);
    assert.match(error.message, /Prüfung der Sicherung fehlgeschlagen/, reason);
    assert.match(error.message, new RegExp(reason), reason);
    assert.equal(ledgerRows(db), null, reason);
    assert.deepEqual(contentDigest(db), digest, reason);
    const files = readdirSync(backups);
    assert.ok(files.some(f => f.endsWith('.db.unverified')), `${reason}: ${files}`);
    assert.ok(!files.some(f => f.endsWith('.db')), `${reason}: keine ungeprüfte Datei unter pre-*.db`);
    db.close();
  }
});

test('Sicherung: zu wenig Speicher oder Zieldatei existiert → BACKUP_FAILED, nichts überschrieben', async () => {
  const space = await adoptWithBackup({ statfs: () => ({ bavail: 1, bsize: 4096 }) });
  assert.equal(space.error?.code, 'BACKUP_FAILED');
  assert.match(space.error.message, /zu wenig freier Speicher/);
  assert.equal(ledgerRows(space.db), null);
  space.db.close();

  const now = new Date('2026-10-02T12:00:00.000Z');
  const dir = tempDir();
  const db = buildLegacy(join(dir, 'crm.db'), 'S5');
  const backups = join(dir, 'backups');
  const existing = await adoptWithBackup({ dir: backups, now, token: 'fest' });
  assert.equal(existing.error, null);
  const before = statSync(join(backups, 'pre-0001_baseline-20261002T120000Z-fest.db'));
  const error = await errorCode(() => runMigrations(db, { migrationsDir: MIGRATIONS_DIR, backup: { dir: backups, now, token: 'fest' } }));
  assert.equal(error?.code, 'BACKUP_FAILED');
  assert.match(error.message, /existiert bereits/);
  assert.deepEqual(statSync(join(backups, 'pre-0001_baseline-20261002T120000Z-fest.db')).mtimeMs, before.mtimeMs);
  assert.equal(ledgerRows(db), null);
  existing.db.close();
  db.close();
});

test('Sicherung enthält OAuth-Zugänge: Datei 0600, neuer Ordner 0700', async () => {
  const { db, error, backups } = await adoptWithBackup({});
  assert.equal(error, null);
  assert.equal(statSync(backups).mode & 0o777, 0o700);
  const [file] = readdirSync(backups);
  assert.match(file, /^pre-0001_baseline-\d{8}T\d{6}Z-\d+-[0-9a-f]{6}\.db$/);
  assert.equal(statSync(join(backups, file)).mode & 0o777, 0o600);
  db.close();
});
