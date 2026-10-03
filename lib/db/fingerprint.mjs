/**
 * Schema-Fingerabdruck und Inhalts-Digest.
 *
 * Der Fingerabdruck hat zwei Ebenen:
 * - strukturell: Tabellen, Spalten (Reihenfolge, Typ, NOT NULL, Default, PK),
 *   Tabellen-Flags, Indizes inkl. Autoindizes, Indexspalten, Fremdschlüssel,
 *   Trigger- und View-Namen — aus den PRAGMA-Tabellenfunktionen;
 * - Text: sqlite_master.sql jedes Objekts mit zusammengefasstem Leerraum
 *   (deckt CHECK, COLLATE, Konfliktklauseln, Trigger- und View-Körper ab).
 *
 * Interne Objekte (sqlite_*) und die Ledger-Tabelle selbst bleiben außen vor.
 */
import { createHash } from 'node:crypto';

export const LEDGER_TABLE = 'schema_migrations';

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * Nicht-interne Objekte aus sqlite_master, ohne die Ledger-Tabelle selbst.
 * Alles andere zählt mit — auch ein Trigger, Index oder View, der am Ledger
 * hängt oder so heißt: Solche Objekte sind Drift und dürfen nie unsichtbar sein.
 */
export function schemaObjects(db) {
  return db.prepare(
    "SELECT type, name, tbl_name, sql FROM sqlite_master WHERE substr(name, 1, 7) <> 'sqlite_' ORDER BY type, name",
  ).all().filter(o => !(o.type === 'table' && o.name === LEDGER_TABLE));
}

/** Tabellen in Namensreihenfolge (ohne interne und ohne Ledger). */
export function userTables(db) {
  return schemaObjects(db).filter(o => o.type === 'table').map(o => o.name);
}

/**
 * @param {import('better-sqlite3').Database} db
 * @returns {{ structural: object, text: object, hashes: { structural: string, text: string } }}
 */
export function fingerprint(db) {
  const objects = schemaObjects(db);
  const tables = {};
  for (const table of objects.filter(o => o.type === 'table')) {
    const columns = db.prepare(
      'SELECT cid, name, type, "notnull" AS nn, dflt_value AS dflt, pk, hidden FROM pragma_table_xinfo(?) ORDER BY cid',
    ).all(table.name).map(c => [c.cid, c.name, String(c.type).trim().toUpperCase(), c.nn, c.dflt, c.pk, c.hidden]);
    const flags = db.prepare("SELECT wr, strict FROM pragma_table_list(?) WHERE schema = 'main'").get(table.name) ?? {};
    const indexes = db.prepare(
      'SELECT name, "unique" AS uq, origin, partial FROM pragma_index_list(?) ORDER BY name',
    ).all(table.name).map(ix => ({
      name: ix.name,
      unique: ix.uq,
      origin: ix.origin,
      partial: ix.partial,
      keys: db.prepare(
        'SELECT seqno, cid, name, "desc" AS dsc, coll FROM pragma_index_xinfo(?) WHERE key = 1 ORDER BY seqno',
      ).all(ix.name).map(k => [k.seqno, k.cid, k.name, k.dsc, k.coll]),
    }));
    const foreignKeys = db.prepare(
      'SELECT id, seq, "table" AS tbl, "from" AS src, "to" AS dst, on_update, on_delete, "match" AS mt FROM pragma_foreign_key_list(?) ORDER BY id, seq',
    ).all(table.name).map(f => [f.id, f.seq, f.tbl, f.src, f.dst, f.on_update, f.on_delete, f.mt]);
    tables[table.name] = {
      columns,
      withoutRowid: flags.wr ?? null,
      strict: flags.strict ?? null,
      autoincrement: /\bAUTOINCREMENT\b/i.test(table.sql ?? ''),
      indexes,
      foreignKeys,
    };
  }
  const structural = {
    tables,
    triggers: objects.filter(o => o.type === 'trigger').map(o => [o.name, o.tbl_name]),
    views: objects.filter(o => o.type === 'view').map(o => o.name),
  };
  const text = {};
  for (const o of objects) {
    if (o.sql) text[`${o.type}:${o.name}`] = o.sql.replace(/\s+/g, ' ').trim();
  }
  return {
    structural,
    text,
    hashes: { structural: sha256(stableStringify(structural)), text: sha256(stableStringify(text)) },
  };
}

/** JSON mit sortierten Objektschlüsseln, damit der Hash nicht von der Einfügereihenfolge abhängt. */
export function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

/** Beide Ebenen gleich? */
export function sameFingerprint(a, b) {
  return a.hashes.structural === b.hashes.structural && a.hashes.text === b.hashes.text;
}

/**
 * Benennt die Unterschiede zwischen zwei Fingerabdrücken — nur Objekt- und
 * Spaltennamen, nie Inhalte.
 * @returns {string[]}
 */
export function describeDifference(actual, expected) {
  const out = [];
  const at = actual.structural.tables;
  const et = expected.structural.tables;
  for (const name of Object.keys(et)) if (!at[name]) out.push(`Tabelle fehlt: ${name}`);
  for (const name of Object.keys(at)) if (!et[name]) out.push(`zusätzliche Tabelle: ${name}`);
  for (const name of Object.keys(et)) {
    if (!at[name]) continue;
    const ac = at[name].columns.map(c => c[1]);
    const ec = et[name].columns.map(c => c[1]);
    for (const c of ec) if (!ac.includes(c)) out.push(`Spalte fehlt: ${name}.${c}`);
    for (const c of ac) if (!ec.includes(c)) out.push(`zusätzliche Spalte: ${name}.${c}`);
    if (stableStringify(at[name].columns) !== stableStringify(et[name].columns) && ac.every(c => ec.includes(c)) && ec.every(c => ac.includes(c))) {
      out.push(`Spaltendefinition oder -reihenfolge weicht ab: ${name}`);
    }
    const ai = at[name].indexes.map(i => i.name);
    const ei = et[name].indexes.map(i => i.name);
    for (const i of ei) if (!ai.includes(i)) out.push(`Index fehlt: ${i}`);
    for (const i of ai) if (!ei.includes(i)) out.push(`zusätzlicher Index: ${i}`);
    for (const i of ei.filter(n => ai.includes(n))) {
      const a = at[name].indexes.find(x => x.name === i);
      const e = et[name].indexes.find(x => x.name === i);
      if (stableStringify(a) !== stableStringify(e)) out.push(`Index weicht ab: ${i}`);
    }
    if (stableStringify(at[name].foreignKeys) !== stableStringify(et[name].foreignKeys)) out.push(`Fremdschlüssel weichen ab: ${name}`);
    if (at[name].withoutRowid !== et[name].withoutRowid || at[name].strict !== et[name].strict || at[name].autoincrement !== et[name].autoincrement) {
      out.push(`Tabellen-Flags weichen ab: ${name}`);
    }
  }
  const trig = (f) => f.structural.triggers.map(t => t[0]);
  for (const t of trig(actual)) if (!trig(expected).includes(t)) out.push(`zusätzlicher Trigger: ${t}`);
  for (const t of trig(expected)) if (!trig(actual).includes(t)) out.push(`Trigger fehlt: ${t}`);
  for (const v of actual.structural.views) if (!expected.structural.views.includes(v)) out.push(`zusätzliche View: ${v}`);
  for (const v of expected.structural.views) if (!actual.structural.views.includes(v)) out.push(`View fehlt: ${v}`);
  if (!out.length && actual.hashes.text !== expected.hashes.text) {
    for (const key of new Set([...Object.keys(actual.text), ...Object.keys(expected.text)])) {
      if (actual.text[key] !== expected.text[key]) out.push(`SQL-Text weicht ab: ${key}`);
    }
  }
  return out;
}

/**
 * Inhalts-Digest je Tabelle, in SQL berechnet (quote() erhält Speicherklasse
 * und volle Genauigkeit). Sortiert nach allen Spalten, ohne rowid.
 *
 * @param {import('better-sqlite3').Database} db
 * @param {Record<string, string[]>} [projection] Tabelle → zu prüfende Spalten
 * @returns {Record<string, { rows: number, sha256: string }>}
 */
export function contentDigest(db, projection) {
  const result = {};
  const tables = projection ? Object.keys(projection).sort() : userTables(db);
  for (const table of tables) {
    const columns = projection
      ? projection[table]
      : db.prepare('SELECT name FROM pragma_table_xinfo(?) WHERE hidden = 0 ORDER BY cid').all(table).map(c => c.name);
    const q = (name) => `"${name.replace(/"/g, '""')}"`;
    const expr = columns.map(c => `quote(${q(c)})`).join(" || char(31) || ");
    const hash = createHash('sha256');
    let rows = 0;
    for (const row of db.prepare(`SELECT ${expr} AS r FROM ${q(table)} ORDER BY ${columns.map(q).join(', ')}`).raw().iterate()) {
      hash.update(row[0]);
      hash.update('\x1e');
      rows += 1;
    }
    result[table] = { rows, sha256: hash.digest('hex') };
  }
  return result;
}

/** Spalten jeder Tabelle (für Projektionen bei der Übernahme älterer Stände). */
export function tableColumns(db) {
  const out = {};
  for (const table of userTables(db)) {
    out[table] = db.prepare('SELECT name FROM pragma_table_xinfo(?) WHERE hidden = 0 ORDER BY cid').all(table).map(c => c.name);
  }
  return out;
}

export { sha256 };
