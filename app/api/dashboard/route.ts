import { ensureDatabase, getD1 } from '@/lib/database';
import { LOST_REASONS, isLost, isRecontact, isWon, isoWeekKey, monthKey, monthLabel } from '@/lib/crm-vocab';
import type { DashboardData } from '@/lib/types';

type LeadRow = { status: string; price_cents: number | null; won_at: string | null; updated_at: string; lost_reason: string | null; recontact_at: string | null };
type InvoiceRow = { status: string; gross_cents: number };

/** Woche als Anzeigetext, z. B. "KW 35 · 2026". */
const weekLabel = (key: string) => {
  const [year, week] = key.split('-W');
  return `KW ${week} · ${year}`;
};

export async function GET() {
  await ensureDatabase();
  const db = getD1();

  const [leadRows, invoiceRows] = await Promise.all([
    db.prepare('SELECT status, price_cents, won_at, updated_at, lost_reason, recontact_at FROM leads').all<LeadRow>(),
    db.prepare('SELECT status, gross_cents FROM invoices').all<InvoiceRow>(),
  ]);
  const leads = leadRows.results;

  const buckets = { gewonnen: 0, verloren: 0, offen: 0, wiedervorlage: 0 };
  const weekMap = new Map<string, { cents: number; count: number }>();
  const monthMap = new Map<string, { cents: number; count: number }>();
  const reasonMap = new Map<string, number>();
  const today = new Date().toISOString().slice(0, 10);

  let totalCents = 0;
  let wonCount = 0;
  let dueRecontacts = 0;

  for (const lead of leads) {
    if (isWon(lead.status)) buckets.gewonnen++;
    else if (isLost(lead.status)) buckets.verloren++;
    else if (isRecontact(lead.status)) buckets.wiedervorlage++;
    else buckets.offen++;

    if (lead.lost_reason) reasonMap.set(lead.lost_reason, (reasonMap.get(lead.lost_reason) ?? 0) + 1);
    if (lead.recontact_at && lead.recontact_at <= today) dueRecontacts++;

    if (!isWon(lead.status)) continue;
    wonCount++;
    const cents = lead.price_cents ?? 0;
    totalCents += cents;

    // Ältere Gewinne haben kein won_at — dann zählt das Änderungsdatum.
    const stamp = new Date(lead.won_at ?? lead.updated_at);
    if (Number.isNaN(stamp.getTime())) continue;

    const wk = isoWeekKey(stamp);
    const mk = monthKey(stamp);
    const week = weekMap.get(wk) ?? { cents: 0, count: 0 };
    weekMap.set(wk, { cents: week.cents + cents, count: week.count + 1 });
    const month = monthMap.get(mk) ?? { cents: 0, count: 0 };
    monthMap.set(mk, { cents: month.cents + cents, count: month.count + 1 });
  }

  const invoices = { openCents: 0, paidCents: 0, openCount: 0, paidCount: 0 };
  for (const invoice of invoiceRows.results) {
    if (invoice.status === 'bezahlt') { invoices.paidCents += invoice.gross_cents; invoices.paidCount++; }
    else if (invoice.status !== 'storniert') { invoices.openCents += invoice.gross_cents; invoices.openCount++; }
  }

  const sortDesc = <T extends { key: string }>(rows: T[]) => rows.sort((a, b) => (a.key < b.key ? 1 : -1));

  const data: DashboardData = {
    buckets,
    revenue: {
      totalCents,
      wonCount,
      averageCents: wonCount ? Math.round(totalCents / wonCount) : 0,
      byWeek: sortDesc([...weekMap].map(([key, v]) => ({ key, label: weekLabel(key), ...v }))).slice(0, 12),
      byMonth: sortDesc([...monthMap].map(([key, v]) => ({ key, label: monthLabel(key), ...v }))).slice(0, 12),
    },
    invoices,
    lostReasons: LOST_REASONS
      .map(r => ({ reason: r.value, label: r.label, count: reasonMap.get(r.value) ?? 0 }))
      .filter(r => r.count > 0)
      .sort((a, b) => b.count - a.count),
    dueRecontacts,
  };

  return Response.json(data);
}
