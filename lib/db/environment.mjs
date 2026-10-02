/**
 * Welche Sicherheitsregeln gelten? Eine Einordnung für CLI, Bericht und Runner.
 *
 * Produktionsregeln (Fresh-DB-Schutz, Pflicht-Sicherungsziel, fester
 * Migrationsordner, .env.production*) gelten, sobald EIN Signal dafür spricht:
 *   - NODE_ENV = production
 *   - RAILWAY_ENVIRONMENT_NAME (bzw. das ältere RAILWAY_ENVIRONMENT) = production
 * Verglichen wird ohne Groß-/Kleinschreibung und Leerraum am Rand.
 *
 * Im Zweifel gilt Produktion:
 *   - NODE_ENV mit einem Wert außer development/test (z. B. "prod")
 *   - jeder Railway-Prozess (Umgebungsname oder RAILWAY_*_ID gesetzt), auch
 *     ohne oder mit anderem Umgebungsnamen — jede Railway-Umgebung hat ein
 *     Volume, das nicht still neu angelegt werden darf
 *   - ein widersprechendes NODE_ENV=development überstimmt ein
 *     Produktionssignal nicht
 * Entwicklung gilt nur, wenn kein Railway-Kontext erkennbar ist und NODE_ENV
 * fehlt, leer, development oder test ist.
 *
 * Es werden nur Variablennamen und diese nicht geheimen Werte ausgegeben.
 */

const DEVELOPMENT_NODE_ENVS = new Set(['', 'development', 'test']);
const RAILWAY_ID_VARIABLES = ['RAILWAY_PROJECT_ID', 'RAILWAY_ENVIRONMENT_ID', 'RAILWAY_SERVICE_ID', 'RAILWAY_DEPLOYMENT_ID'];

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
  const railwayVariable = env.RAILWAY_ENVIRONMENT_NAME !== undefined ? 'RAILWAY_ENVIRONMENT_NAME' : 'RAILWAY_ENVIRONMENT';
  const railwayName = env[railwayVariable];
  const railwayIds = RAILWAY_ID_VARIABLES.filter(name => typeof env[name] === 'string' && env[name].trim() !== '');

  if (nodeEnv === 'production') reasons.push('NODE_ENV=production');
  else if (!DEVELOPMENT_NODE_ENVS.has(nodeEnv)) reasons.push(`NODE_ENV=${shown(env.NODE_ENV)}(unbekannt)`);

  if (normalize(railwayName) === 'production') reasons.push(`${railwayVariable}=production`);
  else if (normalize(railwayName) !== '') reasons.push(`${railwayVariable}=${shown(railwayName)}(Railway)`);
  else if (railwayIds.length) reasons.push(`${railwayIds[0]}(Railway-ohne-Umgebungsnamen)`);

  // Jeder Grund oben bedeutet Produktion; ein Entwicklungs-NODE_ENV ändert daran nichts.
  const production = reasons.length > 0;
  if (production && (nodeEnv === 'development' || nodeEnv === 'test')) reasons.push(`NODE_ENV=${nodeEnv}(überstimmt)`);
  return {
    production,
    mode: production ? 'production' : 'development',
    reasons: production ? reasons : ['kein-Produktionssignal'],
  };
}
