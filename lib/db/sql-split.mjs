/**
 * Zerlegt eine Migrationsdatei in einzelne SQL-Anweisungen.
 *
 * Kommentare (-- … und /* … *\/) werden übersprungen, Zeichenketten und
 * Bezeichner in '…', "…", `…` und […] gelten als ein Token. Eine Anweisung
 * endet am Semikolon — außer bei CREATE TRIGGER: dort endet sie erst an einem
 * END, das direkt auf ein Semikolon folgt (dieselbe Regel wie sqlite3_complete()).
 */

/**
 * @typedef {{ sql: string, tokens: string[] }} SqlStatement
 * `sql` ist der Text ab dem ersten Token bis vor das abschließende Semikolon.
 * `tokens` enthält Wörter in Großbuchstaben, Satzzeichen und Zeichenketten
 * unverändert.
 */

const WORD = /[A-Za-z0-9_$]/;
const isWord = (token) => WORD.test(token[0]);

/** @param {string} text @returns {SqlStatement[]} */
export function splitStatements(text) {
  /** @type {SqlStatement[]} */
  const statements = [];
  /** @type {string[]} */
  let tokens = [];
  let start = -1;
  let i = 0;

  const finish = (end) => {
    if (start >= 0 && tokens.some(t => t !== ';')) {
      statements.push({ sql: text.slice(start, end).trim(), tokens });
    }
    tokens = [];
    start = -1;
  };

  const isTrigger = () => {
    const words = tokens.filter(isWord);
    if (words[0] !== 'CREATE') return false;
    const next = words[1] === 'TEMP' || words[1] === 'TEMPORARY' ? words[2] : words[1];
    return next === 'TRIGGER';
  };

  while (i < text.length) {
    const c = text[i];
    if (/\s/.test(c)) { i += 1; continue; }
    if (c === '-' && text[i + 1] === '-') {
      const nl = text.indexOf('\n', i);
      i = nl === -1 ? text.length : nl + 1;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      const close = text.indexOf('*/', i + 2);
      i = close === -1 ? text.length : close + 2;
      continue;
    }
    if (start < 0) start = i;
    if (c === "'" || c === '"' || c === '`' || c === '[') {
      const closeChar = c === '[' ? ']' : c;
      let j = i + 1;
      while (j < text.length) {
        if (text[j] === closeChar) {
          if (closeChar !== ']' && text[j + 1] === closeChar) { j += 2; continue; }
          break;
        }
        j += 1;
      }
      tokens.push(text.slice(i, j + 1));
      i = j + 1;
      continue;
    }
    if (WORD.test(c)) {
      let j = i;
      while (j < text.length && WORD.test(text[j])) j += 1;
      tokens.push(text.slice(i, j).toUpperCase());
      i = j;
      continue;
    }
    if (c === ';') {
      if (isTrigger()) {
        const prev = tokens[tokens.length - 1];
        const beforePrev = tokens[tokens.length - 2];
        if (!(prev === 'END' && beforePrev === ';')) {
          tokens.push(';');
          i += 1;
          continue;
        }
      }
      finish(i);
      i += 1;
      continue;
    }
    tokens.push(c);
    i += 1;
  }
  finish(text.length);
  return statements;
}

/** Anweisungen, die die Transaktion des Runners verlassen oder umgehen würden. */
const FORBIDDEN_FIRST_WORDS = new Set(['BEGIN', 'COMMIT', 'END', 'ROLLBACK', 'SAVEPOINT', 'RELEASE', 'VACUUM', 'ATTACH', 'DETACH']);
/**
 * Erlaubte PRAGMAs: nur prüfende und defer_foreign_keys (endet mit der
 * Transaktion). Alles andere — journal_mode, foreign_keys, user_version,
 * writable_schema, ignore_check_constraints, … — verwaltet der Runner selbst
 * oder wirkt über die Migration hinaus auf die Verbindung.
 */
const ALLOWED_PRAGMAS = new Set([
  'DEFER_FOREIGN_KEYS', 'FOREIGN_KEY_CHECK', 'FOREIGN_KEY_LIST', 'INDEX_INFO', 'INDEX_LIST', 'INDEX_XINFO',
  'INTEGRITY_CHECK', 'OPTIMIZE', 'QUICK_CHECK', 'TABLE_INFO', 'TABLE_XINFO',
]);

/** 'name', "name", `name` und [name] wie SQLite als Bezeichner lesen. */
function identifier(token) {
  if (!token) return '';
  const open = token[0];
  if (!['"', "'", '`', '['].includes(open)) return token;
  const inner = token.slice(1, -1);
  return (open === '[' ? inner : inner.split(open + open).join(open)).toUpperCase();
}

/**
 * Prüft eine Anweisung auf verbotene Transaktionssteuerung.
 * @param {SqlStatement} statement
 * @returns {string | null} Grund oder null
 */
export function forbiddenReason(statement) {
  const [first, second, third, fourth] = statement.tokens;
  if (FORBIDDEN_FIRST_WORDS.has(first)) return `${first} ist in Migrationen verboten (der Runner steuert die Transaktion)`;
  if (first === 'PRAGMA') {
    // PRAGMA [schema.]name — mit Schema-Präfix steht der Name hinter dem Punkt.
    const name = identifier(third === '.' ? fourth : second);
    if (!ALLOWED_PRAGMAS.has(name)) return `PRAGMA ${name.toLowerCase() || '?'} ist in Migrationen nicht erlaubt`;
  }
  return null;
}
