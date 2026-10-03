/**
 * Eingefrorene Definition der bekannten Altstände (vor PXK-113).
 *
 * Alle Schema-Anweisungen, die je ein Release seit der Railway-Portierung
 * ausgeführt hat, stehen wortgleich in 0001_baseline.sql (24 Anweisungen).
 * Jeder Altstand ist daher eine Teilmenge davon, abhängig vom zuletzt
 * gestarteten Release. Herleitung: TypeScript-AST-Extraktion von
 * createStatements und *_COLUMNS aus lib/database.ts der genannten Commits.
 *
 * Hier steht bewusst kein DDL-Text, nur Prüfsummen und Nummern: das SQL lebt
 * ausschließlich in der Migrationsdatei. Weicht deren Zerlegung von diesen
 * Prüfsummen ab, verweigert der Runner den Start (LEGACY_DEFINITION_INVALID).
 */

/** sha256 je Anweisung von 0001_baseline.sql, in Dateireihenfolge (#1–#24). */
export const BASELINE_STATEMENT_SHA256 = [
  'c9afbbdc518cef9901fc8aa8169db6736938e07e0f0e4a45014bc1796e696346', // 1 CREATE TABLE leads
  '91fa8f68ac9ce7aae5a6720a95f9ca0d92c201f3aa33fa977c7e2404312bcd32', // 2 CREATE TABLE activities
  '9a00983ee5d5dd40769f74208a43c54875bb30bf6722c5ba29fde1217322fdf3', // 3 CREATE TABLE settings
  'a28fac8be9ef8f6dbfe0c5d185d4f89c0e77ab40f29098a854895b9f3c96379e', // 4 CREATE TABLE email_templates
  'a007e4d2d65d046641f135fd4d07c2d71ef85708096cbe4e9bf57aecdc08b8b9', // 5 CREATE TABLE appointments
  '51945ef61e95abae44ad8efdf2485af32bd7fa1f85ac24330dc4d513168a22e6', // 6 idx_leads_status_score
  '685779b93b80f584dbf054fd01278fd32eb28b0cf7fdd18a9df9fa9cb47969f5', // 7 idx_leads_website_status
  'b8932f32035e3edab4d8e12108a6d2ac9fdb2239893197edc1c440ad86f8d2ce', // 8 idx_leads_follow_up
  '58f91ca269924732029035abf40c60177cad6539c9d4697a9c66ebbab6ed6cab', // 9 idx_activities_lead_id
  '19d3125d2d5f8c6acf2511bca6471b92d05280bf2a412d888ad6233a47fd9941', // 10 idx_appointments_lead_id
  '96f7965ef55a9c20c9ba76f4886c996425fad2e6627270e233f7b6fd4c0868da', // 11 idx_appointments_start
  'a1f304ba6db234f7122b19289a33e378b2e6def2718a73a40a4a0d7b25ece88b', // 12 CREATE TABLE invoices
  'fa016274ad4e1938996912c9ff47721baed0ea97a22ca42853120b7fd06eafa0', // 13 idx_invoices_lead_id
  '787459d0f586592250c4119148e8abd8d1617c4f16572e30592796c454ad7a72', // 14 idx_invoices_issued
  '0574bf531fdb6ef831be67592bcbcec7d342d36f982e72fe357e6331e311d327', // 15 CREATE TABLE users
  '46e5f88fc47f5144075ec0f7cb66478de04ef2a036fcd0cd6703032fede2407f', // 16 leads.price_cents
  '5b507122de3010a11c884072fb7cd85d0db58b0f257c0610eb4f1337a2d53824', // 17 leads.won_at
  '08f34bead706729617b38e583e614701a157adbff46644f59b8051f9e2dce488', // 18 leads.lost_reason
  '20d58f4995727bc88a090e62593953c7db849793c194735dd2f0e54bd6b8b1bd', // 19 leads.recontact_at
  'b6de6ac958d20adcea36e43d3190d5727f11e034bcf5e4697c6a83cd9d253de4', // 20 leads.contact_attempts
  'be9319d4c109b9344810e4daeaf0c8389b3cd7bea7d37e3ec2e23e9f0088adff', // 21 leads.owner_email
  '8d056d8bf227d2b227951448bcca3c8e52028273efe6de987076082e441964db', // 22 invoices.kind
  '7682c9bc96f174d428a1552788dc1eb4657141bd23fb8cdd83d9951c4abfd305', // 23 invoices.share_percent
  '7e8d217a2cc329139c78ef534dd5fbfb7fd0a49d5ae4ff2e3caee9ef68820e6d', // 24 activities.actor_email
];

const sorted = (list) => [...list].sort((a, b) => a - b);
const S1 = [1, 2, 3, 6, 7, 8, 9];
const S2 = [...S1, 4, 5, 10, 11];
const S3 = [...S2, 12, 13, 14, 16, 17, 18, 19, 20];
const S4 = [...S3, 22, 23];
const S5 = Array.from({ length: 24 }, (_, i) => i + 1);

/**
 * Bekannte Altstände: welche Baseline-Anweisungen (1-basiert) ein Stand
 * enthält und welches Release ihn zuletzt erzeugt hat.
 */
export const LEGACY_VARIANTS = {
  S1: { release: '0a0c430/6d0732e', statements: sorted(S1) },
  S2: { release: 'c759b67…5256602', statements: sorted(S2) },
  S3: { release: 'b8a8f0d/db260fe', statements: sorted(S3) },
  S4: { release: '48b7333', statements: sorted(S4) },
  S5: { release: 'cd2c098', statements: S5 },
};

/** Der aktuelle Altstand, der ohne DDL übernommen werden darf. */
export const CURRENT_LEGACY_VARIANT = 'S5';
