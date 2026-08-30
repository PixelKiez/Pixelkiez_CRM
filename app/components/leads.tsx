'use client';

import { useEffect, useMemo, useState } from 'react';
import { STATUS_OPTIONS } from '@/lib/crm-vocab';
import { resolveRegion } from '@/lib/regions';
import type { Lead } from '@/lib/types';

const label = (value: string | null) => value ? value.replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Nicht angegeben';
const websiteTone = (value: string) => value === 'Ja' ? 'yes' : value === 'Nein' ? 'no' : 'check';
const websiteLabel = (value: string) => value === 'Ja' ? 'Bestätigt' : value === 'Nein' ? 'Keine' : 'Prüfen';
const telHref = (phone: string) => `tel:${phone.replace(/[^\d+]/g, '')}`;
const smartAction = (lead: Lead) => lead.websiteStatus === 'Nein' && lead.phone ? 'Telefonisch anbieten' : lead.websiteStatus === 'Prüfen' ? 'Website verifizieren' : lead.email ? 'E-Mail mit Vorschlag' : 'Daten ergänzen';

export function LeadTable({ leads, onOpen, onAskDelete }: { leads: Lead[]; onOpen: (l: Lead) => void; onAskDelete: (lead: Lead) => void }) {
  return (
    <div className="lead-table">
      <div className="table-head"><span>Unternehmen</span><span>Status</span><span>Telefon</span><span>Webseite</span><span>Score</span><span>Nächster Schritt</span><span /></div>
      {leads.map(lead => (
        <div className="lead-row" key={lead.id}>
          <button className="row-open" onClick={() => onOpen(lead)}>
            <span className="company"><i>{lead.name.charAt(0)}</i><span><strong>{lead.name}</strong><small><em className="area-tag">{resolveRegion(lead.zip, lead.city).ortsteil}</em>{label(lead.category)}</small></span></span>
            <span><em className={`pill ${lead.status === 'Recherche offen' ? 'checking' : websiteTone(lead.websiteStatus) === 'no' ? 'lost' : ''}`}>{lead.status}</em></span>
            <span className="cell-phone">{lead.phone ? <a href={telHref(lead.phone)} onClick={e => e.stopPropagation()} title={`Anrufen: ${lead.phone}`}>☎ {lead.phone}</a> : <em className="no-data">—</em>}</span>
            <span className={`web-status ${websiteTone(lead.websiteStatus)}`}>● {websiteLabel(lead.websiteStatus)}</span>
            <span className="score"><b>{lead.score}</b><i><u style={{ width: `${lead.score}%` }} /></i></span>
            <span className="next">{lead.ownerEmail && <em className="owner-tag" title={`Zuständig: ${lead.ownerEmail}`}>{lead.ownerEmail.split('@')[0]}</em>}{lead.nextAction || smartAction(lead)}</span>
          </button>
          <button className="row-delete" title={`${lead.name} löschen`} aria-label={`${lead.name} löschen`} onClick={() => onAskDelete(lead)}>✕</button>
        </div>
      ))}
      {!leads.length && <div className="empty"><strong>Keine passenden Unternehmen</strong><span>Ändere Suche oder Filter.</span></div>}
    </div>
  );
}

const PAGE_SIZE_OPTIONS = [25, 50, 100, 200];

export default function LeadWorkspace({
  title, subtitle, leads,
  websiteFilter, setWebsiteFilter, priorityFilter, setPriorityFilter, statusFilter, setStatusFilter,
  regionFilter, setRegionFilter, regionOptions,
  ownerFilter, setOwnerFilter, userEmail,
  onOpen, onAskDelete,
}: {
  title: string; subtitle: string; leads: Lead[];
  ownerFilter: 'alle' | 'meine' | 'frei'; setOwnerFilter: (v: 'alle' | 'meine' | 'frei') => void;
  userEmail: string | null;
  websiteFilter: string; setWebsiteFilter: (v: string) => void;
  priorityFilter: string; setPriorityFilter: (v: string) => void;
  statusFilter: string; setStatusFilter: (v: string) => void;
  regionFilter: string; setRegionFilter: (v: string) => void;
  regionOptions: Array<{ bezirk: string; ortsteile: Array<{ name: string; count: number }> }>;
  onOpen: (l: Lead) => void; onAskDelete: (lead: Lead) => void;
}) {
  const [pageSize, setPageSize] = useState<number>(50);
  const [page, setPage] = useState<number>(1);

  const totalPages = Math.max(1, Math.ceil(leads.length / pageSize));
  const currentPage = Math.min(page, totalPages);

  useEffect(() => { setPage(1); }, [statusFilter, websiteFilter, priorityFilter, leads.length, pageSize]);

  const pageLeads = useMemo(() => {
    const start = (currentPage - 1) * pageSize;
    return leads.slice(start, start + pageSize);
  }, [leads, currentPage, pageSize]);

  const from = leads.length === 0 ? 0 : (currentPage - 1) * pageSize + 1;
  const to = Math.min(currentPage * pageSize, leads.length);

  return (
    <article className="panel list-workspace">
      <div className="list-title">
        <div><h2>{title}</h2><p>{subtitle}</p></div>
        <div className="filter-row">
          <div className="owner-switch" role="group" aria-label="Zuständigkeit filtern">
            <button type="button" className={ownerFilter === 'alle' ? 'active' : ''} onClick={() => setOwnerFilter('alle')}>Alle</button>
            <button type="button" className={ownerFilter === 'meine' ? 'active' : ''} disabled={!userEmail} onClick={() => setOwnerFilter('meine')}>Meine</button>
            <button type="button" className={ownerFilter === 'frei' ? 'active' : ''} onClick={() => setOwnerFilter('frei')}>Ohne Zuständigkeit</button>
          </div>
          <select value={statusFilter} onChange={e => setStatusFilter(e.target.value)} aria-label="Status filtern">
            <option>Alle</option>{STATUS_OPTIONS.map(s => <option key={s}>{s}</option>)}
          </select>
          <select value={websiteFilter} onChange={e => setWebsiteFilter(e.target.value)} aria-label="Website-Status filtern"><option>Alle</option><option value="Nein">Keine Webseite</option><option value="Prüfen">Prüfen</option><option value="Ja">Bestätigt</option></select>
          <select value={priorityFilter} onChange={e => setPriorityFilter(e.target.value)} aria-label="Priorität filtern"><option>Alle</option><option>Hoch</option><option>Mittel</option><option>Niedrig</option></select>
          <select className="area-select" value={regionFilter} onChange={e => setRegionFilter(e.target.value)} aria-label="Bezirk oder Ortsteil filtern">
            <option value="Alle">Alle Gebiete</option>
            {regionOptions.map(group => (
              <optgroup key={group.bezirk} label={group.bezirk}>
                {group.ortsteile.map(o => <option key={o.name} value={o.name}>{o.name} ({o.count})</option>)}
              </optgroup>
            ))}
          </select>
        </div>
      </div>

      <LeadTable leads={pageLeads} onOpen={onOpen} onAskDelete={onAskDelete} />

      {leads.length > 0 && (
        <Pagination
          currentPage={currentPage}
          totalPages={totalPages}
          pageSize={pageSize}
          from={from}
          to={to}
          total={leads.length}
          onChangePage={setPage}
          onChangeSize={setPageSize}
        />
      )}
    </article>
  );
}

function Pagination({
  currentPage, totalPages, pageSize, from, to, total, onChangePage, onChangeSize,
}: {
  currentPage: number; totalPages: number; pageSize: number;
  from: number; to: number; total: number;
  onChangePage: (n: number) => void; onChangeSize: (n: number) => void;
}) {
  const [jump, setJump] = useState<string>('');
  const numbers = buildPageNumbers(currentPage, totalPages);

  function goto(n: number) { onChangePage(Math.min(Math.max(1, n), totalPages)); }
  function handleJump() {
    const parsed = Number(jump);
    if (!Number.isFinite(parsed) || parsed < 1) return;
    goto(Math.floor(parsed));
    setJump('');
  }

  return (
    <nav className="pagination" aria-label="Seiten-Navigation">
      <span className="page-info">Zeige <b>{from}–{to}</b> von <b>{total}</b> Unternehmen</span>
      <div className="page-controls">
        <button type="button" className="page-btn" disabled={currentPage <= 1} onClick={() => goto(1)} aria-label="Erste Seite">«</button>
        <button type="button" className="page-btn" disabled={currentPage <= 1} onClick={() => goto(currentPage - 1)} aria-label="Vorherige Seite">‹</button>
        {numbers.map((n, i) => n === '…'
          ? <span key={`gap-${i}`} className="page-gap">…</span>
          : <button
              key={n}
              type="button"
              className={`page-btn ${n === currentPage ? 'active' : ''}`}
              onClick={() => goto(n as number)}
              aria-current={n === currentPage ? 'page' : undefined}
            >{n}</button>)}
        <button type="button" className="page-btn" disabled={currentPage >= totalPages} onClick={() => goto(currentPage + 1)} aria-label="Nächste Seite">›</button>
        <button type="button" className="page-btn" disabled={currentPage >= totalPages} onClick={() => goto(totalPages)} aria-label="Letzte Seite">»</button>
      </div>
      <div className="page-extras">
        <label className="page-jump">
          Springe zu
          <input
            type="number"
            min={1}
            max={totalPages}
            value={jump}
            onChange={e => setJump(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); handleJump(); } }}
            placeholder={String(currentPage)}
          />
          <button type="button" className="ghost-btn" onClick={handleJump} disabled={!jump}>OK</button>
        </label>
        <label className="page-size">
          Pro Seite
          <select value={pageSize} onChange={e => onChangeSize(Number(e.target.value))}>
            {PAGE_SIZE_OPTIONS.map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </label>
      </div>
    </nav>
  );
}

/** Erzeugt kompakte Seitennummer-Liste mit „…"-Lücken, z. B. [1, '…', 4, 5, 6, '…', 20]. */
function buildPageNumbers(current: number, total: number): Array<number | '…'> {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const pages = new Set<number>([1, total, current, current - 1, current + 1]);
  const sorted = [...pages].filter(n => n >= 1 && n <= total).sort((a, b) => a - b);
  const out: Array<number | '…'> = [];
  for (let i = 0; i < sorted.length; i++) {
    if (i > 0 && sorted[i] - sorted[i - 1] > 1) out.push('…');
    out.push(sorted[i]);
  }
  return out;
}
