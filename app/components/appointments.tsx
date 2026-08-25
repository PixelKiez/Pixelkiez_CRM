'use client';

import { useEffect, useState } from 'react';
import type { Appointment, Lead } from '@/lib/types';

function fmtDate(iso: string) {
  return new Date(iso).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}

export default function AppointmentsPage({ leads, onOpenLead, onToast }: { leads: Lead[]; onOpenLead: (lead: Lead) => void; onToast: (msg: string, kind?: 'ok' | 'err') => void }) {
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    fetch('/api/appointments')
      .then(async r => (await r.json()) as { appointments: Appointment[] })
      .then(d => { setAppointments(d.appointments); setLoading(false); })
      .catch(() => { onToast('Termine konnten nicht geladen werden.', 'err'); setLoading(false); });
  }, [onToast]);

  async function cancel(id: number) {
    if (!confirm('Termin löschen?')) return;
    const response = await fetch(`/api/appointments/${id}`, { method: 'DELETE' });
    const data = (await response.json()) as { ok?: boolean; error?: string; warnings?: string[] };
    if (!response.ok) return onToast(data.error || 'Löschen fehlgeschlagen.', 'err');
    setAppointments(list => list.filter(a => a.id !== id));
    onToast(data.warnings?.length ? data.warnings.join(' ') : 'Termin entfernt.');
  }

  const now = Date.now();
  const upcoming = appointments.filter(a => new Date(a.startTs).getTime() >= now);
  const past = appointments.filter(a => new Date(a.startTs).getTime() < now).reverse();

  if (loading) return <div className="panel settings-panel"><p className="muted">Lade Termine …</p></div>;

  return (
    <section className="appointments-view">
      <div className="panel">
        <div className="panel-head"><div><span className="eyebrow">KOMMENDE TERMINE</span><h2>{upcoming.length} anstehend</h2></div></div>
        {upcoming.length ? (
          <ul className="appointment-list">
            {upcoming.map(a => (
              <li key={a.id}>
                <div className="appt-when">
                  <strong>{fmtDate(a.startTs)}</strong>
                  <small>bis {new Date(a.endTs).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' })} Uhr</small>
                </div>
                <div className="appt-body">
                  <strong>{a.title}</strong>
                  <p className="muted">{a.leadName || a.leadId}{a.location ? ` · ${a.location}` : ''}</p>
                  {a.notes && <p>{a.notes}</p>}
                </div>
                <div className="appt-actions">
                  {a.gcalLink && <a href={a.gcalLink} target="_blank" rel="noreferrer" className="ghost-btn">Google öffnen</a>}
                  <button className="ghost-btn" onClick={() => { const lead = leads.find(l => l.id === a.leadId); if (lead) onOpenLead(lead); }}>Lead öffnen</button>
                  <button className="danger-btn" onClick={() => cancel(a.id)}>Absagen</button>
                </div>
              </li>
            ))}
          </ul>
        ) : <p className="muted">Aktuell keine Termine geplant. Termine legst du direkt in einem Lead an.</p>}
      </div>

      {past.length > 0 && (
        <div className="panel">
          <div className="panel-head"><div><span className="eyebrow">VERGANGENE TERMINE</span><h2>{past.length}</h2></div></div>
          <ul className="appointment-list">
            {past.slice(0, 20).map(a => (
              <li key={a.id} className="past">
                <div className="appt-when"><strong>{fmtDate(a.startTs)}</strong></div>
                <div className="appt-body"><strong>{a.title}</strong><p className="muted">{a.leadName || a.leadId}</p></div>
                <div className="appt-actions">
                  <button className="ghost-btn" onClick={() => { const lead = leads.find(l => l.id === a.leadId); if (lead) onOpenLead(lead); }}>Lead</button>
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
