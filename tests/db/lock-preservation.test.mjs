/**
 * D1 (PXK-113): Die Vorprüfung vor dem Öffnen lässt die Sperren einer offenen
 * Verbindung stehen. Next.js bündelt lib/d1-node.ts zweimal (API-Chunk und
 * SSR-Chunk für /dokument); die zweite Instanz ruft getSqlite() auf, während
 * die Verbindung der ersten offen ist. Öffnete und schlösse die Prüfung die
 * Datenbankdatei in diesem Prozess, gäbe POSIX seine SHARED-Sperre frei: Ein
 * anderer Lese-Schreib-Client (SQLite < 3.51) hielte sich beim Schließen für
 * den letzten, schriebe das -wal zurück und löschte -wal und -shm — alles
 * danach Bestätigte ginge beim nächsten Stopp verloren.
 *
 * Beobachtet wird echt, in eigenen Prozessen: F_GETLK (python3) und fremde
 * Clients über node:sqlite (diese Laufzeit und PXK_TEST_NODE_BINARIES; Node
 * 22.13/22.14 bringen SQLite 3.47.2 mit) und python3-sqlite3.
 */
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { test } from 'node:test';
import Database from 'better-sqlite3';
import { runMigrations } from '../../lib/db/migrate.mjs';
import { openDatabase } from '../../lib/db/open.mjs';
import { compileAppModule, runAppScript } from './app-modules.mjs';
import { MIGRATIONS_DIR, ROOT, tempDir } from './helpers.mjs';

// Sperren des Unix-VFS (os_unix.c): SHARED = Lesesperre auf PENDING_BYTE + 2 … + 510; DMS-Byte im -shm
const SHARED_FIRST = 0x40000000 + 2;
const SHARED_SIZE = 510;
const SHM_DMS = 128;

/** F_GETLK für eine Schreibsperre auf [start, start + len): wer hält eine Sperre dagegen? (struct flock je Plattform) */
const GETLK = `import fcntl,json,os,struct,sys
p,s,n=sys.argv[1],int(sys.argv[2]),int(sys.argv[3])
mac=sys.platform=='darwin'
f='qqihh' if mac else 'hhqqixxxx'
fd=os.open(p,os.O_RDONLY)
v=struct.unpack(f,fcntl.fcntl(fd,fcntl.F_GETLK,struct.pack(f,*((s,n,0,fcntl.F_WRLCK,0) if mac else (fcntl.F_WRLCK,0,s,n,0)))))
os.close(fd)
t,pid=(v[3],v[2]) if mac else (v[0],v[4])
print(json.dumps({'type':{fcntl.F_RDLCK:'read',fcntl.F_WRLCK:'write'}.get(t,'none'),'pid':pid if t!=fcntl.F_UNLCK else 0}))`;
const hasGetlk = ['darwin', 'linux'].includes(process.platform) && spawnSync('python3', ['-c', 'import fcntl'], { encoding: 'utf8' }).status === 0;
const lockHolder = (path, start, length) => {
  const result = spawnSync('python3', ['-c', GETLK, path, String(start), String(length)], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout);
};

/** Fremde Lese-Schreib-Clients wie ein Betreiber: Standard-Öffnen, eine Abfrage, Schließen (optional mit Checkpoint). */
const nodeClients = [process.execPath, ...(process.env.PXK_TEST_NODE_BINARIES ?? '').split(':').filter(Boolean)];
const pythonSqlite = spawnSync('python3', ['-c', 'import sqlite3'], { encoding: 'utf8' }).status === 0;
function foreignClients(path, sql = 'SELECT count(*) FROM activities') {
  const used = [];
  for (const bin of nodeClients) {
    const run = spawnSync(bin, ['--no-warnings', '-e', `const { DatabaseSync } = require('node:sqlite'); const db = new DatabaseSync(${JSON.stringify(path)}); db.prepare(${JSON.stringify(sql)}).all(); db.close(); process.stdout.write(process.versions.sqlite);`], { encoding: 'utf8' });
    if (run.status === 0) used.push(`node:sqlite ${run.stdout}`);
    else assert.match(run.stderr, /node:sqlite|ERR_UNKNOWN_BUILTIN_MODULE/, `${bin}: ${run.stderr}`);
  }
  if (pythonSqlite) {
    const run = spawnSync('python3', ['-c', `import sqlite3,sys\nc=sqlite3.connect(sys.argv[1])\nc.execute(sys.argv[2]).fetchall()\nc.close()\nprint(sqlite3.sqlite_version,end='')`, path, sql], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    used.push(`python3-sqlite3 ${run.stdout}`);
  }
  assert.ok(used.length > 0, 'mindestens ein fremder Client');
  return used;
}

async function migratedDb() {
  const path = join(tempDir(), 'crm.db');
  const db = openDatabase(path, 'apply');
  await runMigrations(db, { migrationsDir: MIGRATIONS_DIR, production: false, backup: false });
  db.close();
  return path;
}

/**
 * App-Prozess wie `next start`: Verbindung A aus Instanz 1 von lib/d1-node.ts; `second` lädt eine weitere
 * Instanz, deren getSqlite() die Vorprüfung erneut durchläuft; `write n` schreibt über A und bestätigt je ID.
 */
function startApp(path) {
  const url = compileAppModule('lib/d1-node.ts');
  const script = `
    import { createInterface } from 'node:readline';
    const say = (value) => process.stdout.write(JSON.stringify(value) + '\\n');
    const a = (await import(${JSON.stringify(url)} + '?instance=1')).getSqlite();
    const insert = a.prepare("INSERT INTO activities (lead_id, type, detail, created_at) VALUES ('d1', 'test', ?, datetime('now'))");
    let instance = 1;
    say({ ids: [Number(insert.run('A').lastInsertRowid)] });
    for await (const line of createInterface({ input: process.stdin })) {
      const [command, n] = line.split(' ');
      if (command === 'second') {
        instance += 1;
        const b = (await import(${JSON.stringify(url)} + '?instance=' + instance)).getSqlite();
        say({ separate: b !== a, ids: b.prepare("SELECT id FROM activities WHERE lead_id = 'd1' ORDER BY id").all().map(r => r.id) });
      } else if (command === 'write') {
        const ids = [];
        for (let i = 0; i < Number(n); i += 1) ids.push(Number(insert.run(String(i)).lastInsertRowid));
        say({ ids });
      }
    }
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: ROOT, env: { PATH: process.env.PATH, HOME: process.env.HOME, SQLITE_PATH: path }, stdio: ['pipe', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.on('data', (chunk) => { stderr += chunk; });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const next = async () => {
    const { value, done } = await lines.next();
    if (done) throw new Error(`App-Prozess beendet: ${stderr}`);
    return JSON.parse(value);
  };
  const first = next();
  first.catch(() => {});
  return {
    pid: child.pid,
    first,
    send: (command) => { child.stdin.write(`${command}\n`); return next(); },
    kill: () => new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) return resolve();
      child.once('exit', resolve);
      child.kill('SIGKILL');
    }),
  };
}

/** Ein Client unter SQLite 3.51 nutzt eine verlorene SHARED-Sperre aus; 3.51 und neuer nicht. */
const exploitable = (clients) => clients.some(client => /\b3\.([0-4]\d|50)\.\d+$/.test(client));

const sidecars = (path) => ({ wal: existsSync(`${path}-wal`), shm: existsSync(`${path}-shm`) });

test('D1: ein zweiter geprüfter getSqlite() lässt die SHARED-Sperre der offenen Verbindung stehen (F_GETLK)', { skip: !hasGetlk && 'python3 mit fcntl auf darwin/linux fehlt', timeout: 120000 }, async () => {
  const path = await migratedDb();
  const app = startApp(path);
  try {
    await app.first;
    const held = { type: 'read', pid: app.pid };
    assert.deepEqual(lockHolder(path, SHARED_FIRST, SHARED_SIZE), held, 'Verbindung A hält SHARED');
    assert.deepEqual(lockHolder(`${path}-shm`, SHM_DMS, 1), held, 'Verbindung A hält das DMS-Byte im -shm');
    for (let round = 1; round <= 3; round += 1) {
      assert.equal((await app.send('second')).separate, true);
      assert.deepEqual(lockHolder(path, SHARED_FIRST, SHARED_SIZE), held, `Runde ${round}: SHARED nach der Vorprüfung`);
      assert.deepEqual(lockHolder(`${path}-shm`, SHM_DMS, 1), held, `Runde ${round}: DMS nach der Vorprüfung`);
    }
    // das -wal trägt keine Sperre, die ein Öffnen in diesem Prozess freigeben könnte
    assert.deepEqual(lockHolder(`${path}-wal`, 0, 0), { type: 'none', pid: 0 });
  } finally {
    await app.kill();
  }
});

test('D1: fremde Lese-Schreib-Clients nach erneuter Vorprüfung — -wal bleibt, keine bestätigte Schreibung geht bei Stopp und Neustart verloren', { timeout: 120000 }, async (t) => {
  const path = await migratedDb();
  const app = startApp(path);
  const acked = [];
  try {
    acked.push(...(await app.first).ids);
    for (let round = 1; round <= 4; round += 1) {
      const seen = await app.send('second');
      assert.deepEqual(seen.ids, acked, `Runde ${round}: die zweite Instanz liest alles Bestätigte`);
      const clients = foreignClients(path, round === 2 ? 'PRAGMA wal_checkpoint(PASSIVE)' : undefined);
      if (round === 1) {
        t.diagnostic(`fremde Clients: ${clients.join(', ')}`);
        if (!exploitable(clients) && !hasGetlk) t.diagnostic('kein Client unter SQLite 3.51 und kein F_GETLK: dieser Lauf belegt D1 nicht (PXK_TEST_NODE_BINARIES mit Node 22.14 setzen)');
      }
      assert.deepEqual(sidecars(path), { wal: true, shm: true }, `Runde ${round}: -wal und -shm der laufenden App stehen noch`);
      acked.push(...(await app.send('write 25')).ids);
    }
  } finally {
    await app.kill();
  }
  // Neustart über den CRM-Pfad (Vorprüfung und getSqlite) wie nach einem Redeploy
  const restarted = runAppScript({ env: { SQLITE_PATH: path }, body: "return (await app.getD1().prepare(\"SELECT id FROM activities WHERE lead_id = 'd1' ORDER BY id\").all()).results.map(r => r.id);" });
  assert.deepEqual(restarted, { value: acked }, 'jede bestätigte ID überlebt SIGKILL und Neustart');
  const db = new Database(path, { readonly: true });
  try {
    assert.equal(db.pragma('integrity_check', { simple: true }), 'ok');
  } finally {
    db.close();
  }
});
