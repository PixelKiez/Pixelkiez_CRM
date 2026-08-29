'use client';

import { useEffect, useMemo, useState } from 'react';
import { formatEuro } from '@/lib/crm-vocab';
import type { DashboardData } from '@/lib/types';

type Segment = { key: string; label: string; value: number; color: string };

const RADIUS = 68;
const STROKE = 30;
const CIRCUMFERENCE = 2 * Math.PI * RADIUS;

/** Donut aus vier Kreisbögen — kein Diagramm-Paket nötig. */
function Donut({ segments, total }: { segments: Segment[]; total: number }) {
  let offset = 0;
  return (
    <svg className="donut" viewBox="0 0 180 180" role="img" aria-label="Verteilung der Kunden nach Status">
      <g transform="rotate(-90 90 90)">
        <circle cx="90" cy="90" r={RADIUS} fill="none" stroke="var(--line)" strokeWidth={STROKE} />
        {total > 0 && segments.filter(s => s.value > 0).map(segment => {
          const length = (segment.value / total) * CIRCUMFERENCE;
          const dash = `${length} ${CIRCUMFERENCE - length}`;
          const element = (
            <circle
              key={segment.key}
              cx="90" cy="90" r={RADIUS}
              fill="none" stroke={segment.color} strokeWidth={STROKE}
              strokeDasharray={dash} strokeDashoffset={-offset}
            >
              <title>{`${segment.label}: ${segment.value}`}</title>
            </circle>
          );
          offset += length;
          return element;
        })}
      </g>
      <text x="90" y="84" className="donut-value">{total}</text>
      <text x="90" y="103" className="donut-caption">Kunden</text>
    </svg>
  );
}

function Bars({ rows }: { rows: Array<{ key: string; label: string; cents: number; count: number }> }) {
  const max = Math.max(1, ...rows.map(r => r.cents));
  if (!rows.length) return <p className="muted-note">Noch kein Umsatz erfasst. Sobald ein Kunde auf „Gewonnen" steht und einen Preis hat, erscheint er hier.</p>;
  return (
    <ul className="bar-list">
      {rows.map(row => (
        <li key={row.key}>
          <span className="bar-label">{row.label}</span>
          <span className="bar-track"><i style={{ width: `${Math.round((row.cents / max) * 100)}%` }} /></span>
          <span className="bar-value">{formatEuro(row.cents)}<small>{row.count} {row.count === 1 ? 'Kunde' : 'Kunden'}</small></span>
        </li>
      ))}
    </ul>
  );
}

export default function Insights({ onToast }: { onToast: (msg: string, kind?: 'ok' | 'err') => void }) {
  const [data, setData] = useState<DashboardData | null>(null);
  const [period, setPeriod] = useState<'month' | 'week'>('month');

  useEffect(() => {
    fetch('/api/dashboard')
      .then(async r => {
        if (r.status === 401) { window.location.assign('/login'); return null; }
        if (!r.ok) throw new Error('fehlgeschlagen');
        return (await r.json()) as DashboardData;
      })
      .then(d => { if (d) setData(d); })
      .catch(() => onToast('Die Auswertung konnte nicht geladen werden.', 'err'));
  }, [onToast]);

  const segments: Segment[] = useMemo(() => data ? [
    { key: 'gewonnen', label: 'Gewonnen', value: data.buckets.gewonnen, color: 'var(--green)' },
    { key: 'offen', label: 'In Bearbeitung', value: data.buckets.offen, color: '#7fb3a0' },
    { key: 'wiedervorlage', label: 'Wiedervorlage', value: data.buckets.wiedervorlage, color: 'var(--amber)' },
    { key: 'verloren', label: 'Verloren', value: data.buckets.verloren, color: 'var(--red)' },
  ] : [], [data]);

  if (!data) return <div className="loading"><i /><h2>Auswertung wird geladen</h2><p>Kennzahlen werden zusammengestellt.</p></div>;

  const total = segments.reduce((sum, s) => sum + s.value, 0);
  const rows = period === 'month' ? data.revenue.byMonth : data.revenue.byWeek;

  return (
    <div className="insights">
      <section className="kpi-row">
        <article className="kpi"><span className="eyebrow">GESAMTUMSATZ</span><strong>{formatEuro(data.revenue.totalCents)}</strong><small>aus {data.revenue.wonCount} gewonnenen {data.revenue.wonCount === 1 ? 'Kunden' : 'Kunden'}</small></article>
        <article className="kpi"><span className="eyebrow">DURCHSCHNITTSPREIS</span><strong>{formatEuro(data.revenue.averageCents)}</strong><small>je gewonnenem Kunden</small></article>
        <article className="kpi"><span className="eyebrow">OFFENE RECHNUNGEN</span><strong>{formatEuro(data.invoices.openCents)}</strong><small>{data.invoices.openCount} offen · {data.invoices.paidCount} bezahlt</small></article>
        <article className={`kpi ${data.dueRecontacts ? 'kpi-warn' : ''}`}><span className="eyebrow">WIEDERVORLAGE FÄLLIG</span><strong>{data.dueRecontacts}</strong><small>{data.dueRecontacts ? 'jetzt angehen' : 'nichts fällig'}</small></article>
      </section>

      <section className="insight-grid">
        <article className="panel">
          <header className="panel-head"><div><span className="eyebrow">VERTEILUNG</span><h2>Kunden nach Status</h2></div></header>
          <div className="donut-wrap">
            <Donut segments={segments} total={total} />
            <ul className="legend">
              {segments.map(segment => (
                <li key={segment.key}>
                  <i style={{ background: segment.color }} />
                  <span>{segment.label}</span>
                  <b>{segment.value}</b>
                  <small>{total ? Math.round((segment.value / total) * 100) : 0} %</small>
                </li>
              ))}
            </ul>
          </div>
        </article>

        <article className="panel">
          <header className="panel-head">
            <div><span className="eyebrow">UMSATZ</span><h2>Nach {period === 'month' ? 'Monat' : 'Woche'}</h2></div>
            <div className="period-switch">
              <button className={period === 'week' ? 'active' : ''} onClick={() => setPeriod('week')}>Woche</button>
              <button className={period === 'month' ? 'active' : ''} onClick={() => setPeriod('month')}>Monat</button>
            </div>
          </header>
          <Bars rows={rows} />
        </article>
      </section>

      {data.lostReasons.length > 0 && (
        <section className="panel">
          <header className="panel-head"><div><span className="eyebrow">ABSAGEN</span><h2>Warum Kunden abspringen</h2></div></header>
          <ul className="reason-list">
            {data.lostReasons.map(reason => (
              <li key={reason.reason}><span>{reason.label}</span><b>{reason.count}</b></li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}
