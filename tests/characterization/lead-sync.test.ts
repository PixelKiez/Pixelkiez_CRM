/**
 * PXK-114 Charakterisierung: lib/lead-sync.ts (reine Funktionen, keine Datenbank).
 * Hält das Ist-Verhalten fest. KNOWN_WEAKNESS(<Kategorie>, <Jira>) markiert Verhalten, das das genannte Ticket
 * bewusst ändert; der Test hält es nur fest und erklärt es nicht für akzeptabel.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AGENT_ACTIONS, LEAD_COLUMNS, actionToPatch, monthsFromNow, syncLeadPatch, type LeadPatch } from '@/lib/lead-sync';

const NOW = '2026-10-10T12:00:00.000Z';
const NEU = { status: 'Neu', won_at: null, price_cents: null };
const WON = { status: 'Gewonnen', won_at: '2026-01-01T00:00:00.000Z' };
const VERLOREN = { status: 'Verloren', won_at: null };
const ALLOWED = 'Erlaubt: nicht_erreicht, kein_interesse, keine_anrufe, spaeter, gewonnen';
const N_VERLOREN = 'Status automatisch auf „Verloren" gesetzt';
const N_WIEDERVORLAGE = 'Status automatisch auf „Wiedervorlage" gesetzt';
const N_6M = 'Wiedervorlage in 6 Monaten vorgemerkt';
const N_WON_SET = 'Gewonnen-Datum gesetzt';
const N_WON_REMOVED = 'Gewonnen-Datum entfernt, da Status nicht mehr „Gewonnen"';
const N_NO_DATE = 'Wiedervorlage ohne Datum — auf 6 Monate gesetzt';
const INVALID = (key: string) => `Ungültiger Wert für ${key}: nur Text, Zahl oder null erlaubt.`;

const cur = (status: string, attempts: unknown) => ({ status, contact_attempts: attempts });
/** syncLeadPatch mit sichtbarer Schlüsselreihenfolge (die bestimmt den Aktivitätstext der PATCH-Route). */
function sync(current: Parameters<typeof syncLeadPatch>[0], input: LeadPatch) {
  const result = syncLeadPatch(current, input);
  return 'error' in result ? result : { keys: Object.keys(result.patch), ...result };
}
/** wie die PATCH-Route: input = {...actionToPatch, ...body ohne action/months} */
function routeSync(current: { status: string; won_at?: unknown; contact_attempts?: unknown }, action: string, body: LeadPatch = {}) {
  const fromAction = actionToPatch(action, { status: current.status, contact_attempts: current.contact_attempts });
  if ('error' in fromAction) return fromAction;
  return sync(current, { ...fromAction, ...body });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => {
  vi.useRealTimers();
});

describe('actionToPatch', () => {
  it('LS-01 nicht_erreicht, attempts 0 → Zähler 1 + lastContact, Status unberührt', () => {
    expect(actionToPatch('nicht_erreicht', cur('Neu', 0))).toEqual({ contactAttempts: 1, lastContact: NOW });
  });
  it('LS-02 nicht_erreicht, attempts 1 → 2', () => {
    expect(actionToPatch('nicht_erreicht', cur('Neu', 1))).toEqual({ contactAttempts: 2, lastContact: NOW });
  });
  it('LS-03 nicht_erreicht, attempts 2 → 3, Verloren, kein lastContact', () => {
    const patch = actionToPatch('nicht_erreicht', cur('Neu', 2));
    expect(patch).toEqual({ contactAttempts: 3, lostReason: 'nicht_erreicht', status: 'Verloren' });
    expect(Object.keys(patch)).toEqual(['contactAttempts', 'lostReason', 'status']);
  });
  it('LS-04 nicht_erreicht, attempts 3 / 5 → 4 / 6, Verloren', () => {
    expect(actionToPatch('nicht_erreicht', cur('Neu', 3))).toEqual({ contactAttempts: 4, lostReason: 'nicht_erreicht', status: 'Verloren' });
    expect(actionToPatch('nicht_erreicht', cur('Neu', 5))).toEqual({ contactAttempts: 6, lostReason: 'nicht_erreicht', status: 'Verloren' });
  });
  it("LS-05 nicht_erreicht, attempts '2' (String) → 3, Verloren", () => {
    expect(actionToPatch('nicht_erreicht', cur('Neu', '2'))).toEqual({ contactAttempts: 3, lostReason: 'nicht_erreicht', status: 'Verloren' });
  });
  it('LS-06 nicht_erreicht, attempts null / undefined → 1', () => {
    expect(actionToPatch('nicht_erreicht', cur('Neu', null))).toEqual({ contactAttempts: 1, lastContact: NOW });
    expect(actionToPatch('nicht_erreicht', { status: 'Neu' })).toEqual({ contactAttempts: 1, lastContact: NOW });
  });
  it("LS-07 KNOWN_WEAKNESS(input-validation, PXK-117) nicht_erreicht, attempts 'abc' → NaN", () => {
    const patch = actionToPatch('nicht_erreicht', cur('Neu', 'abc')) as LeadPatch;
    expect(patch).toEqual({ contactAttempts: NaN, lastContact: NOW });
    expect(Number.isNaN(patch.contactAttempts)).toBe(true);
  });
  it('LS-08 KNOWN_WEAKNESS(input-validation, PXK-117) nicht_erreicht, attempts -5 / 2.5 → -4 offen / 3.5 Verloren', () => {
    expect(actionToPatch('nicht_erreicht', cur('Neu', -5))).toEqual({ contactAttempts: -4, lastContact: NOW });
    expect(actionToPatch('nicht_erreicht', cur('Neu', 2.5))).toEqual({ contactAttempts: 3.5, lostReason: 'nicht_erreicht', status: 'Verloren' });
  });
  it('LS-09 kein_interesse → Verloren/kein_interesse', () => {
    expect(actionToPatch('kein_interesse', cur('Neu', 0))).toEqual({ status: 'Verloren', lostReason: 'kein_interesse' });
  });
  it('LS-10 keine_anrufe → Verloren/keine_anrufe', () => {
    expect(actionToPatch('keine_anrufe', cur('Neu', 0))).toEqual({ status: 'Verloren', lostReason: 'keine_anrufe' });
  });
  it('LS-11 spaeter (Standard 6 Monate) → Wiedervorlage 2027-04-10', () => {
    expect(actionToPatch('spaeter', cur('Neu', 0))).toEqual({ status: 'Wiedervorlage', lostReason: 'spaeter', recontactAt: '2027-04-10' });
  });
  it('LS-12 spaeter {months:3} → 2027-01-10', () => {
    expect(actionToPatch('spaeter', cur('Neu', 0), { months: 3 })).toEqual({ status: 'Wiedervorlage', lostReason: 'spaeter', recontactAt: '2027-01-10' });
  });
  it('LS-13 spaeter {months:0} direkt → heute (0 ?? 6 = 0; die Route macht daraus 6, siehe U-10)', () => {
    expect(actionToPatch('spaeter', cur('Neu', 0), { months: 0 })).toMatchObject({ recontactAt: '2026-10-10' });
  });
  it('LS-14 KNOWN_WEAKNESS(input-validation, PXK-117) spaeter -1 / 1.5 → 2026-09-10 / 2026-11-10', () => {
    expect(actionToPatch('spaeter', cur('Neu', 0), { months: -1 })).toMatchObject({ recontactAt: '2026-09-10' });
    expect(actionToPatch('spaeter', cur('Neu', 0), { months: 1.5 })).toMatchObject({ recontactAt: '2026-11-10' });
  });
  it('LS-15 KNOWN_WEAKNESS(input-validation, PXK-117) spaeter 1e9 → RangeError Invalid time value', () => {
    expect(() => actionToPatch('spaeter', cur('Neu', 0), { months: 1e9 })).toThrow(new RangeError('Invalid time value'));
  });
  it('LS-16 gewonnen → {status:Gewonnen}', () => {
    expect(actionToPatch('gewonnen', cur('Neu', 0))).toEqual({ status: 'Gewonnen' });
  });
  it("LS-17 unbekannte Aktion ('foo' / '' / Großschreibung) → Fehler mit Liste", () => {
    for (const action of ['foo', '', 'NICHT_ERREICHT']) {
      expect(actionToPatch(action, cur('Neu', 0))).toEqual({ error: `Unbekannte Aktion: ${action}. ${ALLOWED}` });
    }
  });
  it('LS-18 Konstanten: AGENT_ACTIONS und LEAD_COLUMNS (25 Schlüssel)', () => {
    expect(AGENT_ACTIONS).toEqual(['nicht_erreicht', 'kein_interesse', 'keine_anrufe', 'spaeter', 'gewonnen']);
    expect(Object.keys(LEAD_COLUMNS)).toHaveLength(25);
    expect(LEAD_COLUMNS.ownerEmail).toBe('owner_email');
    for (const absent of ['id', 'source', 'ageScore', 'updatedAt']) expect(LEAD_COLUMNS[absent]).toBeUndefined();
  });
});

describe('monthsFromNow (TZ=UTC)', () => {
  const at = (iso: string) => new Date(iso);
  it('LS-19 31.01. + 1 → 2026-03-03 (Monatsende läuft über)', () => {
    expect(monthsFromNow(1, at('2026-01-31T10:00:00Z'))).toBe('2026-03-03');
  });
  it('LS-20 Schaltjahr 31.01.2028 + 1 → 2028-03-02', () => {
    expect(monthsFromNow(1, at('2028-01-31T10:00:00Z'))).toBe('2028-03-02');
  });
  it('LS-21 31.08. + 6 → 2027-03-03', () => {
    expect(monthsFromNow(6, at('2026-08-31T10:00:00Z'))).toBe('2027-03-03');
  });
  it('LS-22 15.12. + 1 → 2027-01-15', () => {
    expect(monthsFromNow(1, at('2026-12-15T10:00:00Z'))).toBe('2027-01-15');
  });
  it('LS-23 NOW mit 0 / -1 / 1.9 / -1.5', () => {
    expect([0, -1, 1.9, -1.5].map(m => monthsFromNow(m))).toEqual(['2026-10-10', '2026-09-10', '2026-11-10', '2026-08-10']);
  });
  it('LS-24 NaN → RangeError Invalid time value', () => {
    expect(() => monthsFromNow(NaN)).toThrow(new RangeError('Invalid time value'));
  });
  it('LS-25 KNOWN_WEAKNESS(timezone, PXK-118) Ergebnis hängt von der Prozess-Zeitzone ab (deshalb TZ=UTC fest)', () => {
    const from = at('2026-03-31T23:30:00Z');
    expect(monthsFromNow(6, from)).toBe('2026-10-01');
    vi.stubEnv('TZ', 'Europe/Berlin');
    try {
      expect(monthsFromNow(6, from)).toBe('2026-09-30');
      vi.stubEnv('TZ', 'Pacific/Kiritimati');
      expect(monthsFromNow(1, at('2026-01-31T10:00:00Z'))).toBe('2026-02-28');
    } finally {
      vi.unstubAllEnvs();
    }
    expect(process.env.TZ).toBe('UTC');
    expect(new Date('2026-07-01T00:00:00Z').getTimezoneOffset()).toBe(0);
  });
});

describe('syncLeadPatch', () => {
  it('LS-26 {} → Keine gültige Änderung.', () => {
    expect(sync(NEU, {})).toEqual({ error: 'Keine gültige Änderung.' });
  });
  it('LS-27 nur unbekannte/gesperrte Schlüssel → Keine gültige Änderung.', () => {
    expect(sync(NEU, { foo: 1, id: 'X', updated_at: 'x', action: 'gewonnen', months: 3 })).toEqual({ error: 'Keine gültige Änderung.' });
  });
  it('LS-28 unbekannte Schlüssel werden still verworfen', () => {
    expect(sync(NEU, { foo: 1, notes: 'n' })).toEqual({ keys: ['notes'], patch: { notes: 'n' }, notes: [] });
  });
  it("LS-29 '' wird null", () => {
    expect(sync(NEU, { notes: '' })).toEqual({ keys: ['notes'], patch: { notes: null }, notes: [] });
  });
  it("LS-30 Status 'Foo' / null / '' / 'neu' → Unbekannter Status", () => {
    expect(sync(NEU, { status: 'Foo' })).toEqual({ error: 'Unbekannter Status: Foo' });
    expect(sync(NEU, { status: null })).toEqual({ error: 'Unbekannter Status: null' });
    expect(sync(NEU, { status: '' })).toEqual({ error: 'Unbekannter Status: null' });
    expect(sync(NEU, { status: 'neu' })).toEqual({ error: 'Unbekannter Status: neu' });
  });
  it("LS-31 lostReason 'bogus' → Unbekannter Grund", () => {
    expect(sync(NEU, { lostReason: 'bogus' })).toEqual({ error: 'Unbekannter Grund: bogus' });
  });
  it("LS-32 lostReason null / '' → null, Status unverändert", () => {
    expect(sync(NEU, { lostReason: null })).toEqual({ keys: ['lostReason'], patch: { lostReason: null }, notes: [] });
    expect(sync(NEU, { lostReason: '' })).toEqual({ keys: ['lostReason'], patch: { lostReason: null }, notes: [] });
  });
  it("LS-33 priceCents -1 / 1.5 / 'abc' / Infinity → Preisfehler", () => {
    for (const priceCents of [-1, 1.5, 'abc', Infinity]) {
      expect(sync(NEU, { priceCents })).toEqual({ error: 'Preis muss eine ganze Zahl in Cent sein.' });
    }
  });
  it("LS-34 KNOWN_WEAKNESS(input-validation, PXK-117) priceCents-Umwandlung ('1500', ' 15 ', '1e3', true, 0, null, '')", () => {
    const cases: Array<[unknown, unknown]> = [['1500', 1500], [' 15 ', 15], ['1e3', 1000], [true, 1], [0, 0], [null, null], ['', null]];
    for (const [input, expected] of cases) {
      expect(sync(NEU, { priceCents: input })).toEqual({ keys: ['priceCents'], patch: { priceCents: expected }, notes: [] });
    }
  });
  it("LS-35 contactAttempts -1 / -0.5 / 'x' → Kontaktversuche-Fehler", () => {
    for (const contactAttempts of [-1, -0.5, 'x']) {
      expect(sync(NEU, { contactAttempts })).toEqual({ error: 'Kontaktversuche müssen eine Zahl ≥ 0 sein.' });
    }
  });
  it("LS-36 KNOWN_WEAKNESS(input-validation, PXK-117) contactAttempts 2.7 / '3' / null / '' → 2 / 3 / null / null (null scheitert später an NOT NULL, U-19)", () => {
    const cases: Array<[unknown, unknown]> = [[2.7, 2], ['3', 3], [null, null], ['', null]];
    for (const [input, expected] of cases) {
      expect(sync(NEU, { contactAttempts: input })).toEqual({ keys: ['contactAttempts'], patch: { contactAttempts: expected }, notes: [] });
    }
  });
  it('LS-37 contactAttempts 5 → kein automatisches Verloren', () => {
    expect(sync(NEU, { contactAttempts: 5 })).toEqual({ keys: ['contactAttempts'], patch: { contactAttempts: 5 }, notes: [] });
  });
  it('LS-38 lostReason kein_budget → Verloren, recontactAt null', () => {
    expect(sync(NEU, { lostReason: 'kein_budget' })).toEqual({
      keys: ['lostReason', 'status', 'recontactAt'],
      patch: { lostReason: 'kein_budget', status: 'Verloren', recontactAt: null },
      notes: [N_VERLOREN],
    });
  });
  it('LS-39 lostReason spaeter → Wiedervorlage + 6 Monate', () => {
    expect(sync(NEU, { lostReason: 'spaeter' })).toEqual({
      keys: ['lostReason', 'status', 'recontactAt'],
      patch: { lostReason: 'spaeter', status: 'Wiedervorlage', recontactAt: '2027-04-10' },
      notes: [N_WIEDERVORLAGE, N_6M],
    });
  });
  it('LS-40 spaeter + eigenes recontactAt → Datum bleibt, nur Status-Hinweis', () => {
    expect(sync(NEU, { lostReason: 'spaeter', recontactAt: '2027-02-01' })).toEqual({
      keys: ['lostReason', 'recontactAt', 'status'],
      patch: { lostReason: 'spaeter', recontactAt: '2027-02-01', status: 'Wiedervorlage' },
      notes: [N_WIEDERVORLAGE],
    });
  });
  it('LS-41 KNOWN_WEAKNESS(lead-state, PXK-118) spaeter + status Verloren → Verloren MIT Wiedervorlagedatum', () => {
    expect(sync(NEU, { lostReason: 'spaeter', status: 'Verloren' })).toEqual({
      keys: ['lostReason', 'status', 'recontactAt'],
      patch: { lostReason: 'spaeter', status: 'Verloren', recontactAt: '2027-04-10' },
      notes: [N_6M],
    });
  });
  it('LS-42 KNOWN_WEAKNESS(lead-state, PXK-118) kein_interesse + status Neu → Neu mit Absagegrund', () => {
    expect(sync(NEU, { lostReason: 'kein_interesse', status: 'Neu' })).toEqual({
      keys: ['lostReason', 'status'],
      patch: { lostReason: 'kein_interesse', status: 'Neu' },
      notes: [],
    });
  });
  it('LS-43 nur recontactAt (aktuell Neu) → Wiedervorlage', () => {
    expect(sync(NEU, { recontactAt: '2027-03-01' })).toEqual({
      keys: ['recontactAt', 'status'],
      patch: { recontactAt: '2027-03-01', status: 'Wiedervorlage' },
      notes: [N_WIEDERVORLAGE],
    });
  });
  it('LS-44 KNOWN_WEAKNESS(lead-state, PXK-118) nur recontactAt (aktuell gewonnen) → bleibt Gewonnen mit Wiedervorlagedatum', () => {
    expect(sync(WON, { recontactAt: '2027-03-01' })).toEqual({
      keys: ['recontactAt', 'lostReason'],
      patch: { recontactAt: '2027-03-01', lostReason: null },
      notes: [],
    });
  });
  it('LS-45 nur recontactAt (aktuell Verloren) → öffnet den Lead wieder (Wiedervorlage)', () => {
    expect(sync(VERLOREN, { recontactAt: '2027-03-01' })).toEqual({
      keys: ['recontactAt', 'status'],
      patch: { recontactAt: '2027-03-01', status: 'Wiedervorlage' },
      notes: [N_WIEDERVORLAGE],
    });
  });
  it("LS-46 recontactAt '' → null", () => {
    expect(sync(NEU, { recontactAt: '' })).toEqual({ keys: ['recontactAt'], patch: { recontactAt: null }, notes: [] });
  });
  it('LS-47 status Wiedervorlage ohne Datum (auch recontactAt:null) → +6 Monate', () => {
    expect(sync(NEU, { status: 'Wiedervorlage' })).toEqual({
      keys: ['status', 'recontactAt'],
      patch: { status: 'Wiedervorlage', recontactAt: '2027-04-10' },
      notes: [N_NO_DATE],
    });
    expect(sync(NEU, { status: 'Wiedervorlage', recontactAt: null })).toEqual({
      keys: ['status', 'recontactAt'],
      patch: { status: 'Wiedervorlage', recontactAt: '2027-04-10' },
      notes: [N_NO_DATE],
    });
  });
  it('LS-48 status Gewonnen (aktuell Neu) → wonAt NOW, Grund/Wiedervorlage null', () => {
    expect(sync(NEU, { status: 'Gewonnen' })).toEqual({
      keys: ['status', 'wonAt', 'lostReason', 'recontactAt'],
      patch: { status: 'Gewonnen', wonAt: NOW, lostReason: null, recontactAt: null },
      notes: [N_WON_SET],
    });
  });
  it('LS-49 status Gewonnen (aktuell gewonnen) → kein neues Datum', () => {
    expect(sync(WON, { status: 'Gewonnen' })).toEqual({
      keys: ['status', 'lostReason', 'recontactAt'],
      patch: { status: 'Gewonnen', lostReason: null, recontactAt: null },
      notes: [],
    });
  });
  it('LS-50 Gewonnen + eigenes wonAt → bleibt', () => {
    expect(sync(NEU, { status: 'Gewonnen', wonAt: '2025-12-24' })).toEqual({
      keys: ['status', 'wonAt', 'lostReason', 'recontactAt'],
      patch: { status: 'Gewonnen', wonAt: '2025-12-24', lostReason: null, recontactAt: null },
      notes: [],
    });
  });
  it('LS-51 KNOWN_WEAKNESS(lead-state, PXK-118) Gewonnen + lostReason / + recontactAt bleiben stehen', () => {
    expect(sync(NEU, { status: 'Gewonnen', lostReason: 'kein_budget' })).toEqual({
      keys: ['status', 'lostReason', 'wonAt', 'recontactAt'],
      patch: { status: 'Gewonnen', lostReason: 'kein_budget', wonAt: NOW, recontactAt: null },
      notes: [N_WON_SET],
    });
    expect(sync(NEU, { status: 'Gewonnen', recontactAt: '2027-02-01' })).toEqual({
      keys: ['status', 'recontactAt', 'wonAt', 'lostReason'],
      patch: { status: 'Gewonnen', recontactAt: '2027-02-01', wonAt: NOW, lostReason: null },
      notes: [N_WON_SET],
    });
  });
  it('LS-52 Neu (aktuell gewonnen) → wonAt null + Hinweis', () => {
    expect(sync(WON, { status: 'Neu' })).toEqual({ keys: ['status', 'wonAt'], patch: { status: 'Neu', wonAt: null }, notes: [N_WON_REMOVED] });
  });
  it('LS-53 Verloren (aktuell gewonnen) → wonAt null, recontactAt null + Hinweis', () => {
    expect(sync(WON, { status: 'Verloren' })).toEqual({
      keys: ['status', 'wonAt', 'recontactAt'],
      patch: { status: 'Verloren', wonAt: null, recontactAt: null },
      notes: [N_WON_REMOVED],
    });
  });
  it('LS-54 KNOWN_WEAKNESS(lead-state, PXK-118) nur notes / wonAt:null auf gewonnenem Lead → gewonnen ohne Datum möglich', () => {
    expect(sync(WON, { notes: 'x' })).toEqual({
      keys: ['notes', 'lostReason', 'recontactAt'],
      patch: { notes: 'x', lostReason: null, recontactAt: null },
      notes: [],
    });
    expect(sync(WON, { wonAt: null })).toEqual({
      keys: ['wonAt', 'lostReason', 'recontactAt'],
      patch: { wonAt: null, lostReason: null, recontactAt: null },
      notes: [],
    });
  });
  it('LS-55 KNOWN_WEAKNESS(lead-state, PXK-118) Verloren / Ausgeschlossen → recontactAt null; Verloren + recontactAt bleibt', () => {
    expect(sync(NEU, { status: 'Verloren' })).toEqual({ keys: ['status', 'recontactAt'], patch: { status: 'Verloren', recontactAt: null }, notes: [] });
    expect(sync(NEU, { status: 'Ausgeschlossen' })).toEqual({ keys: ['status', 'recontactAt'], patch: { status: 'Ausgeschlossen', recontactAt: null }, notes: [] });
    expect(sync(NEU, { status: 'Verloren', recontactAt: '2027-02-01' })).toEqual({
      keys: ['status', 'recontactAt'],
      patch: { status: 'Verloren', recontactAt: '2027-02-01' },
      notes: [],
    });
  });
  it('LS-56 KNOWN_WEAKNESS(non-scalar-binding, PXK-133) Felder werden in Eingabereihenfolge durchgereicht, null/Objekt ungeprüft', () => {
    expect(sync(NEU, { ownerEmail: 'a@b.de' })).toEqual({ keys: ['ownerEmail'], patch: { ownerEmail: 'a@b.de' }, notes: [] });
    expect(sync(NEU, { name: 'X', phone: '1', foo: 2, city: 'Y' })).toEqual({ keys: ['name', 'phone', 'city'], patch: { name: 'X', phone: '1', city: 'Y' }, notes: [] });
    expect(sync(NEU, { name: null })).toEqual({ keys: ['name'], patch: { name: null }, notes: [] });
    expect(sync(NEU, { notes: { a: 1 } })).toEqual({ keys: ['notes'], patch: { notes: { a: 1 } }, notes: [] });
  });
});

describe('PXK-133 syncLeadPatch: nur Einzelwerte', () => {
  const NON_SCALAR: unknown[] = [[], ['x'], ['a', 'b'], [['n']], [{ a: 1 }], {}, { a: 1 }, { a: { b: 1 } }];
  const NUMERIC = ['priceCents', 'contactAttempts'];
  const VOCAB: Record<string, string> = { status: 'Unbekannter Status', lostReason: 'Unbekannter Grund' };
  it('V-01 Array/Objekt/verschachtelt für jedes Lead-Feld → Fehler mit Feldname, kein Patch', () => {
    for (const key of Object.keys(LEAD_COLUMNS)) {
      for (const value of NON_SCALAR) expect([key, sync(NEU, { [key]: value })]).toEqual([key, { error: INVALID(key) }]);
    }
  });
  it('V-02 true/false → Fehler mit Feldname; status/lostReason behalten die Vokabelprüfung (priceCents/contactAttempts: LS-34, PXK-117)', () => {
    for (const key of Object.keys(LEAD_COLUMNS).filter(k => !NUMERIC.includes(k))) {
      for (const value of [true, false]) {
        expect([key, sync(NEU, { [key]: value })]).toEqual([key, { error: VOCAB[key] ? `${VOCAB[key]}: ${value}` : INVALID(key) }]);
      }
    }
  });
  it('V-03 gemischt gültig + ungültig → ganzer Patch abgelehnt, erster Nicht-Einzelwert in Eingabereihenfolge; Array/Objekt vor, true/false nach der Vokabel-/Zahlprüfung', () => {
    expect(sync(NEU, { notes: 'ok', city: { a: 1 } })).toEqual({ error: INVALID('city') });
    expect(sync(NEU, { status: 'Gewonnen', notes: ['a', 'b'] })).toEqual({ error: INVALID('notes') });
    expect(sync(NEU, { status: 'KEIN_GUELTIGER_STATUS', notes: { a: 1 } })).toEqual({ error: INVALID('notes') });
    expect(sync(NEU, { notes: ['n', 'KEIN_GUELTIGER_STATUS'], status: 'Neu', recontactAt: [] })).toEqual({ error: INVALID('notes') });
    expect(sync(NEU, { notes: 'ok', phone: true })).toEqual({ error: INVALID('phone') });
    expect(sync(NEU, { status: 'KEIN_GUELTIGER_STATUS', notes: true })).toEqual({ error: 'Unbekannter Status: KEIN_GUELTIGER_STATUS' });
    expect(sync(NEU, { notes: true, priceCents: 'abc' })).toEqual({ error: 'Preis muss eine ganze Zahl in Cent sein.' });
  });
  it('V-04 unbekannte Schlüssel bleiben ignoriert; Object.prototype-Namen jetzt auch (vorher __proto__-Durchgriff bzw. SQL-Fehler)', () => {
    expect(sync(NEU, { notes: 'n', unknownKey: [1, 2], foo: { a: 1 }, id: 'X', months: [3], action: {} })).toEqual({ keys: ['notes'], patch: { notes: 'n' }, notes: [] });
    expect(sync(NEU, JSON.parse('{"__proto__":{"status":"Gewonnen"},"notes":"x"}'))).toEqual({ keys: ['notes'], patch: { notes: 'x' }, notes: [] });
    expect(sync(NEU, { constructor: 'x' })).toEqual({ error: 'Keine gültige Änderung.' });
    expect(sync(NEU, { toString: 'x', notes: 'n' })).toEqual({ keys: ['notes'], patch: { notes: 'n' }, notes: [] });
  });
  it("V-05 Kontrolle: Text, Zahl, null und '' bleiben gültig (UI-Entwurf)", () => {
    expect(sync(NEU, { name: 'X', score: 50, notes: null, website: '', priceCents: 1500, contactAttempts: 2, lostReason: '', recontactAt: '' })).toEqual({
      keys: ['name', 'score', 'notes', 'website', 'priceCents', 'contactAttempts', 'lostReason', 'recontactAt'],
      patch: { name: 'X', score: 50, notes: null, website: null, priceCents: 1500, contactAttempts: 2, lostReason: null, recontactAt: null },
      notes: [],
    });
  });
});

describe('Aktion + Synchronisation wie in der PATCH-Route', () => {
  const NEU0 = { ...NEU, contact_attempts: 0 };
  const WON0 = { ...WON, contact_attempts: 0 };
  it('LS-57 gewonnen / gewonnen auf gewonnenem Lead', () => {
    expect(routeSync(NEU0, 'gewonnen')).toEqual({
      keys: ['status', 'wonAt', 'lostReason', 'recontactAt'],
      patch: { status: 'Gewonnen', wonAt: NOW, lostReason: null, recontactAt: null },
      notes: [N_WON_SET],
    });
    expect(routeSync(WON0, 'gewonnen')).toEqual({
      keys: ['status', 'lostReason', 'recontactAt'],
      patch: { status: 'Gewonnen', lostReason: null, recontactAt: null },
      notes: [],
    });
  });
  it('LS-58 nicht_erreicht auf gewonnenem Lead (0) / (2)', () => {
    expect(routeSync(WON0, 'nicht_erreicht')).toEqual({
      keys: ['contactAttempts', 'lastContact', 'lostReason', 'recontactAt'],
      patch: { contactAttempts: 1, lastContact: NOW, lostReason: null, recontactAt: null },
      notes: [],
    });
    expect(routeSync({ ...WON, contact_attempts: 2 }, 'nicht_erreicht')).toEqual({
      keys: ['contactAttempts', 'lostReason', 'status', 'wonAt', 'recontactAt'],
      patch: { contactAttempts: 3, lostReason: 'nicht_erreicht', status: 'Verloren', wonAt: null, recontactAt: null },
      notes: [N_WON_REMOVED],
    });
  });
  it('LS-59 kein_interesse / spaeter auf gewonnenem Lead → wonAt null + Hinweis', () => {
    expect(routeSync(WON0, 'kein_interesse')).toEqual({
      keys: ['status', 'lostReason', 'wonAt', 'recontactAt'],
      patch: { status: 'Verloren', lostReason: 'kein_interesse', wonAt: null, recontactAt: null },
      notes: [N_WON_REMOVED],
    });
    expect(routeSync(WON0, 'spaeter')).toEqual({
      keys: ['status', 'lostReason', 'recontactAt', 'wonAt'],
      patch: { status: 'Wiedervorlage', lostReason: 'spaeter', recontactAt: '2027-04-10', wonAt: null },
      notes: [N_WON_REMOVED],
    });
  });
  it('LS-60 ausdrückliche Felder überschreiben die Aktion', () => {
    expect(routeSync(NEU0, 'gewonnen', { status: 'Neu' })).toEqual({ keys: ['status'], patch: { status: 'Neu' }, notes: [] });
    expect(routeSync(NEU0, 'kein_interesse', { lostReason: 'kein_budget' })).toEqual({
      keys: ['status', 'lostReason', 'recontactAt'],
      patch: { status: 'Verloren', lostReason: 'kein_budget', recontactAt: null },
      notes: [],
    });
    expect(routeSync(NEU0, 'spaeter', { recontactAt: '2027-02-01' })).toEqual({
      keys: ['status', 'lostReason', 'recontactAt'],
      patch: { status: 'Wiedervorlage', lostReason: 'spaeter', recontactAt: '2027-02-01' },
      notes: [],
    });
  });
  it('LS-61 KNOWN_WEAKNESS(lead-state, PXK-118) nicht_erreicht (2) + {contactAttempts:0} → Verloren mit Zähler 0', () => {
    expect(routeSync({ ...NEU, contact_attempts: 2 }, 'nicht_erreicht', { contactAttempts: 0 })).toEqual({
      keys: ['contactAttempts', 'lostReason', 'status', 'recontactAt'],
      patch: { contactAttempts: 0, lostReason: 'nicht_erreicht', status: 'Verloren', recontactAt: null },
      notes: [],
    });
  });
  it("LS-62 nicht_erreicht mit gespeichertem Zähler 'abc' → Kontaktversuche-Fehler", () => {
    expect(routeSync({ ...NEU, contact_attempts: 'abc' }, 'nicht_erreicht')).toEqual({ error: 'Kontaktversuche müssen eine Zahl ≥ 0 sein.' });
  });
});
