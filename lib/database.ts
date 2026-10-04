import { batch, getSqlite, prepare } from '@/lib/d1-node';
import type { Lead } from '@/lib/types';

/**
 * Bereitschaftsprüfung für den Request-Pfad (PXK-113). Hier entsteht kein Schema
 * mehr und es werden keine Startdaten geschrieben: Schema, Ledger und Seeds legt
 * ausschließlich der Pre-Start-Schritt `node scripts/db-migrate.mjs` an
 * (`npm start`: Migration && next start).
 *
 * Die Prüfung ist nur lesend und repariert nichts (siehe getSqlite in
 * lib/d1-node.ts): Fehlt die Datei, ist sie nicht migrationsverwaltet, steht eine
 * Migration aus oder weicht das Schema ab, wird der Grund als MigrationError
 * gemeldet. Ein Erfolg gilt für die Lebensdauer des Prozesses.
 */
export async function ensureDatabase() {
  getSqlite();
}

export function getD1() {
  return {
    prepare(sql: string) {
      return prepare(sql);
    },
    batch,
  };
}

export function rowToLead(row: Record<string, unknown>): Lead {
  return { id:String(row.id),status:String(row.status),priority:String(row.priority),score:Number(row.score),name:String(row.name),category:row.category as string|null,street:row.street as string|null,zip:row.zip as string|null,city:row.city as string|null,phone:row.phone as string|null,email:row.email as string|null,website:row.website as string|null,websiteStatus:String(row.website_status),websiteClass:row.website_class as string|null,ageScore:Number(row.age_score),problems:row.problems as string|null,pitch:row.pitch as string|null,source:row.source as string|null,lastContact:row.last_contact as string|null,nextAction:row.next_action as string|null,followUp:row.follow_up as string|null,notes:row.notes as string|null,updatedAt:String(row.updated_at),
    priceCents: row.price_cents === null || row.price_cents === undefined ? null : Number(row.price_cents),
    wonAt: (row.won_at as string | null) ?? null,
    lostReason: (row.lost_reason as string | null) ?? null,
    recontactAt: (row.recontact_at as string | null) ?? null,
    contactAttempts: Number(row.contact_attempts ?? 0),
    ownerEmail: (row.owner_email as string | null) ?? null };
}

export function rowToInvoice(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    leadId: String(row.lead_id),
    number: String(row.number),
    kind: String(row.kind ?? 'komplett'),
    sharePercent: Number(row.share_percent ?? 100),
    issuedAt: String(row.issued_at),
    serviceDate: (row.service_date as string | null) ?? null,
    netCents: Number(row.net_cents),
    vatRate: Number(row.vat_rate),
    vatCents: Number(row.vat_cents),
    grossCents: Number(row.gross_cents),
    title: (row.title as string | null) ?? null,
    status: String(row.status),
    paidAt: (row.paid_at as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export function rowToTemplate(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    slug: String(row.slug),
    name: String(row.name),
    kind: String(row.kind),
    subject: String(row.subject),
    bodyHtml: String(row.body_html),
    updatedAt: String(row.updated_at),
  };
}

export function rowToAppointment(row: Record<string, unknown>) {
  return {
    id: Number(row.id),
    leadId: String(row.lead_id),
    title: String(row.title),
    startTs: String(row.start_ts),
    endTs: String(row.end_ts),
    location: (row.location as string | null) ?? null,
    notes: (row.notes as string | null) ?? null,
    gcalEventId: (row.gcal_event_id as string | null) ?? null,
    gcalLink: (row.gcal_link as string | null) ?? null,
    status: String(row.status),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}
