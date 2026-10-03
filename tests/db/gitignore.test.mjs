import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { copyFileSync, readdirSync, realpathSync } from 'node:fs';
import { basename, join } from 'node:path';
import { test } from 'node:test';
import { backupVerified } from '../../lib/db/backup.mjs';
import { contentDigest } from '../../lib/db/fingerprint.mjs';
import { ROOT, buildLegacy, errorCode, insertSyntheticRows, tempDir } from './helpers.mjs';

/**
 * Sicherungen enthalten users.google_tokens und Geschäftsdaten. Erzeugte
 * Datenbank- und Sicherungsdateien dürfen nie versehentlich in Git landen;
 * Migrationen und Test-Fixtures müssen versionierbar bleiben.
 */
const hasGit = spawnSync('git', ['--version']).status === 0;
/** Ohne globale/systemweite Git-Konfiguration: eine fremde excludesFile darf keine fehlende Regel verdecken. */
const HERMETIC_GIT = { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' };

/**
 * Prüft Pfade gegen die .gitignore des Repos in einem leeren Wegwerf-Repo: Pfad → ignoriert?
 * Zählt nur Treffer aus genau dieser .gitignore.
 */
function ignored(paths) {
  const repo = tempDir();
  execFileSync('git', ['init', '-q', '--template=', repo], { env: HERMETIC_GIT });
  copyFileSync(join(ROOT, '.gitignore'), join(repo, '.gitignore'));
  const result = spawnSync('git', ['-C', repo, '-c', 'core.excludesFile=', 'check-ignore', '--no-index', '-v', '-n', '--stdin'], {
    input: paths.join('\n'), encoding: 'utf8', env: HERMETIC_GIT,
  });
  assert.ok(result.status === 0 || result.status === 1, result.stderr);
  const lines = result.stdout.trim().split('\n');
  assert.equal(lines.length, paths.length, 'eine Antwort je Pfad');
  return Object.fromEntries(lines.map((line) => {
    const [source, path] = line.split('\t');
    const [file, , pattern] = source.split(':');
    return [path, file === '.gitignore' && !pattern.startsWith('!')];
  }));
}

/** Erzeugt mit dem echten Code eine geprüfte und eine verworfene Sicherung und liefert die Dateinamen. */
async function realBackupNames() {
  const dir = tempDir();
  const db = buildLegacy(join(dir, 'crm.db'), 'S5');
  insertSyntheticRows(db);
  const digest = contentDigest(db);
  const backups = join(dir, 'backups');
  await backupVerified(db, { dir: backups, label: '0001_baseline', digest });
  const failed = await errorCode(() => backupVerified(db, { dir: backups, label: '0002_neu', digest: { anders: true } }));
  assert.equal(failed?.code, 'BACKUP_FAILED');
  db.close();
  return readdirSync(backups);
}

test('erzeugte Datenbank- und Sicherungsdateien werden ignoriert', { skip: !hasGit && 'git fehlt' }, async () => {
  const names = await realBackupNames();
  assert.ok(names.some(n => n.endsWith('.db')) && names.some(n => n.endsWith('.db.unverified')), names.join(', '));
  const generated = [
    'data/crm.db', 'data/crm.db-wal', 'data/crm.db-shm', 'data/crm.db-journal',
    // Standardziel außerhalb der Produktion: <Datenbankordner>/backups
    ...names.map(n => `data/backups/${n}`),
    ...names.map(n => `data/backups/${n}-journal`),
    'data/backups/notiz.txt',
    // PXK_DB_BACKUP_DIR kann auf jeden Ordner im Repo zeigen — auch Seitendateien einer geöffneten Kopie
    ...names.map(n => `backups/${basename(n)}`),
    ...names.flatMap(n => ['-wal', '-shm', '-journal'].map(suffix => `backups/${basename(n)}${suffix}`)),
    'tmp/pre-0002_x-20261002T120000Z-1-abcdef.db.unverified',
  ];
  const result = ignored(generated);
  assert.deepEqual(Object.entries(result).filter(([, isIgnored]) => !isIgnored).map(([path]) => path), [], 'nicht ignoriert');
});

test('Migrationen, Fixtures und Startdaten bleiben versionierbar', { skip: !hasGit && 'git fehlt' }, () => {
  const sources = [
    'db/migrations/0001_baseline.sql', 'db/migrations/0002_kuenftig.sql', 'db/migrations/README.md',
    'tests/db/fixtures/legacy-cd2c098.sql', 'tests/db/fixtures/schema-cd2c098.json', 'tests/db/fixtures/legacy-history.json',
    'data/leads.json', 'lib/db/backup.mjs', 'scripts/db-migrate.mjs',
  ];
  const result = ignored(sources);
  assert.deepEqual(Object.entries(result).filter(([, isIgnored]) => isIgnored).map(([path]) => path), [], 'fälschlich ignoriert');
});

test('kein versioniertes File fällt unter die Ignore-Regeln', { skip: !hasGit && 'git fehlt' }, (t) => {
  const top = spawnSync('git', ['-C', ROOT, 'rev-parse', '--show-toplevel'], { encoding: 'utf8' });
  if (top.status !== 0 || realpathSync(top.stdout.trim()) !== realpathSync(ROOT)) {
    return t.skip('ROOT ist nicht die Wurzel eines Git-Arbeitsbaums (z. B. git-archive-Kopie)');
  }
  const tracked = execFileSync('git', ['-C', ROOT, 'ls-files'], { encoding: 'utf8' }).trim().split('\n');
  const result = ignored(tracked);
  assert.deepEqual(Object.entries(result).filter(([, isIgnored]) => isIgnored).map(([path]) => path), []);
  for (const required of ['db/migrations/0001_baseline.sql', 'tests/db/fixtures/legacy-cd2c098.sql', 'data/leads.json']) {
    assert.ok(tracked.includes(required), `${required} ist versioniert`);
  }
});
