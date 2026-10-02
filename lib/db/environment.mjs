/**
 * Welche Sicherheitsregeln gelten? Eine Einordnung für CLI, Bericht und Runner.
 *
 * Produktionsregeln (Fresh-DB-Schutz, Pflicht-Sicherungsziel, fester
 * Migrationsordner, .env.production*) gelten, sobald EIN Signal dafür spricht:
 *   - NODE_ENV = production
 *   - RAILWAY_ENVIRONMENT_NAME oder das ältere RAILWAY_ENVIRONMENT = production
 *     (beide werden unabhängig geprüft; ein leerer Name verdeckt den anderen nicht)
 * Verglichen wird ohne Groß-/Kleinschreibung und Leerraum am Rand.
 *
 * Im Zweifel gilt Produktion:
 *   - NODE_ENV mit einem Wert außer development/test (z. B. "prod")
 *   - jeder Railway-Prozess (irgendeine nicht leere RAILWAY_*-Variable außer
 *     Zugangstokens), auch ohne oder mit anderem Umgebungsnamen — jede
 *     Railway-Umgebung hat ein Volume, das nicht still neu angelegt werden darf
 *   - ein widersprechendes NODE_ENV=development überstimmt ein
 *     Produktionssignal nicht
 * Entwicklung gilt nur, wenn kein Railway-Kontext erkennbar ist und NODE_ENV
 * fehlt, leer, development oder test ist.
 *
 * Es werden nur Variablennamen und diese nicht geheimen Werte ausgegeben.
 */

const DEVELOPMENT_NODE_ENVS = new Set(['', 'development', 'test']);
const RAILWAY_NAME_VARIABLES = ['RAILWAY_ENVIRONMENT_NAME', 'RAILWAY_ENVIRONMENT'];
/** Zugangstokens der Railway-CLI auf Entwicklerrechnern sind kein Laufzeitkontext. */
const isRailwayCredential = (name) => name.includes('TOKEN');

const normalize = (value) => (typeof value === 'string' ? value.trim().toLowerCase() : '');
/** Wert für die Ausgabe: gekürzt und auf harmlose Zeichen beschränkt. */
const shown = (value) => String(value).trim().replace(/[^A-Za-z0-9_.-]/g, '?').slice(0, 32) || '(leer)';

/**
 * @param {Record<string, string | undefined>} [env]
 * @returns {{ production: boolean, mode: 'production' | 'development', reasons: string[] }}
 *   `reasons` nennt jedes Signal, das zur Einordnung geführt hat (ohne Leerzeichen).
 */
export function classifyEnvironment(env = process.env) {
  const reasons = [];
  const nodeEnv = normalize(env.NODE_ENV);
  const railwayNames = RAILWAY_NAME_VARIABLES.filter(name => normalize(env[name]) !== '');
  const railwayProduction = railwayNames.find(name => normalize(env[name]) === 'production');
  const railwayContext = Object.keys(env)
    .filter(name => name.startsWith('RAILWAY_') && !RAILWAY_NAME_VARIABLES.includes(name) && !isRailwayCredential(name))
    .filter(name => typeof env[name] === 'string' && env[name].trim() !== '')
    .sort();

  if (nodeEnv === 'production') reasons.push('NODE_ENV=production');
  else if (!DEVELOPMENT_NODE_ENVS.has(nodeEnv)) reasons.push(`NODE_ENV=${shown(env.NODE_ENV)}(unbekannt)`);

  if (railwayProduction) reasons.push(`${railwayProduction}=production`);
  else if (railwayNames.length) reasons.push(`${railwayNames[0]}=${shown(env[railwayNames[0]])}(Railway)`);
  else if (railwayContext.length) reasons.push(`${railwayContext[0]}(Railway-ohne-Umgebungsnamen)`);

  // Jeder Grund oben bedeutet Produktion; ein Entwicklungs-NODE_ENV ändert daran nichts.
  const production = reasons.length > 0;
  if (production && (nodeEnv === 'development' || nodeEnv === 'test')) reasons.push(`NODE_ENV=${nodeEnv}(überstimmt)`);
  return {
    production,
    mode: production ? 'production' : 'development',
    reasons: production ? reasons : ['kein-Produktionssignal'],
  };
}
