'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import Dashboard from '@/app/components/dashboard';
import LeadDrawer from '@/app/components/lead-drawer';
import LeadWorkspace from '@/app/components/leads';
import Pipeline from '@/app/components/pipeline';
import SettingsPage from '@/app/components/settings';
import TemplatesPage from '@/app/components/templates';
import AppointmentsPage from '@/app/components/appointments';
import type { Activity, Appointment, EmailTemplate, Lead, LeadStats } from '@/lib/types';

type View = 'dashboard'|'leads'|'pipeline'|'tasks'|'checks'|'templates'|'appointments'|'settings';
const views: { id: View; label: string; icon: string }[] = [
  { id: 'dashboard', label: 'Übersicht', icon: '⌂' },
  { id: 'leads', label: 'Unternehmen', icon: '◎' },
  { id: 'pipeline', label: 'Pipeline', icon: '◫' },
  { id: 'tasks', label: 'Aufgaben', icon: '✓' },
  { id: 'checks', label: 'Datenprüfung', icon: '◇' },
  { id: 'templates', label: 'Vorlagen', icon: '✎' },
  { id: 'appointments', label: 'Termine', icon: '☷' },
  { id: 'settings', label: 'Einstellungen', icon: '⚙' },
];
const blankStats: LeadStats = { total: 0, withoutWebsite: 0, checking: 0, withWebsite: 0, contacted: 0, highPriority: 0, withPhone: 0, withEmail: 0 };

export default function CrmApp() {
  const [leads, setLeads] = useState<Lead[]>([]);
  const [stats, setStats] = useState<LeadStats>(blankStats);
  const [statusCounts, setStatusCounts] = useState<Record<string, number>>({});
  const [activities, setActivities] = useState<Activity[]>([]);
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [upcomingApptCount, setUpcomingApptCount] = useState(0);
  const [loading, setLoading] = useState(true);
  const [view, setView] = useState<View>('dashboard');
  const [query, setQuery] = useState('');
  const [websiteFilter, setWebsiteFilter] = useState('Alle');
  const [priorityFilter, setPriorityFilter] = useState('Alle');
  const [statusFilter, setStatusFilter] = useState('Alle');
  const [selected, setSelected] = useState<Lead | null>(null);
  const [draft, setDraft] = useState<Lead | null>(null);
  const [creating, setCreating] = useState(false);
  const [pendingDelete, setPendingDelete] = useState<Lead | null>(null);
  const [toast, setToast] = useState<{ msg: string; kind: 'ok' | 'err' } | null>(null);

  const notify = useCallback((msg: string, kind: 'ok' | 'err' = 'ok') => setToast({ msg, kind }), []);

  useEffect(() => {
    fetch('/api/leads')
      .then(async r => (await r.json()) as { leads: Lead[]; stats: LeadStats; statusCounts?: Record<string, number>; activities?: Activity[] })
      .then(data => { setLeads(data.leads); setStats(data.stats); setStatusCounts(data.statusCounts ?? {}); setActivities(data.activities ?? []); setLoading(false); })
      .catch(() => { notify('Die Daten konnten nicht geladen werden.', 'err'); setLoading(false); });
    fetch('/api/templates').then(async r => (await r.json()) as { templates: EmailTemplate[] }).then(d => setTemplates(d.templates)).catch(() => {});
    refreshAppointmentCount();
  }, [notify]);

  useEffect(() => setDraft(selected ? { ...selected } : null), [selected]);
  useEffect(() => { if (!toast) return; const id = setTimeout(() => setToast(null), 3400); return () => clearTimeout(id); }, [toast]);

  function refreshAppointmentCount() {
    fetch('/api/appointments?upcoming=1').then(async r => (await r.json()) as { appointments: Appointment[] }).then(d => setUpcomingApptCount(d.appointments.length)).catch(() => {});
  }

  const filtered = useMemo(() => leads.filter(lead => {
    const hay = [lead.name, lead.category, lead.phone, lead.email, lead.zip].join(' ').toLowerCase();
    return (!query || hay.includes(query.toLowerCase()))
      && (websiteFilter === 'Alle' || lead.websiteStatus === websiteFilter)
      && (priorityFilter === 'Alle' || lead.priority === priorityFilter)
      && (statusFilter === 'Alle' || lead.status === statusFilter);
  }), [leads, query, websiteFilter, priorityFilter, statusFilter]);
  const recommendation = useMemo(() => leads.find(l => l.websiteStatus !== 'Ja' && l.email && ['Neu', 'Recherche offen'].includes(l.status)) || leads.find(l => l.status === 'Neu') || leads[0], [leads]);
  const visible = view === 'checks' ? filtered.filter(l => l.websiteStatus === 'Prüfen') : view === 'tasks' ? filtered.filter(l => l.nextAction || l.followUp) : filtered;
  const dueCount = leads.filter(l => (l.nextAction || l.followUp)).length;

  function updateLocal(lead: Lead) { setLeads(old => old.map(item => item.id === lead.id ? lead : item)); if (selected?.id === lead.id) setSelected(lead); }
  async function saveLead() {
    if (!draft) return;
    const response = await fetch(`/api/leads/${draft.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(draft) });
    const data = (await response.json()) as { lead?: Lead; error?: string };
    if (response.ok && data.lead) { updateLocal(data.lead); notify('Änderungen gespeichert.'); }
    else notify(data.error || 'Speichern fehlgeschlagen.', 'err');
  }

  async function sendEmail(subject: string, html: string): Promise<string | undefined> {
    if (!draft) return 'Kein Lead ausgewählt.';
    const response = await fetch('/api/email/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ leadId: draft.id, to: draft.email || undefined, subject, html }) });
    const data = (await response.json()) as { ok?: boolean; to?: string; error?: string };
    if (data.ok) {
      const now = new Date().toISOString();
      updateLocal({ ...draft, lastContact: now });
      setActivities(old => [{ id: Date.now(), lead_id: draft.id, type: 'email_sent', detail: `${subject} → ${data.to}`, created_at: now, name: draft.name }, ...old]);
      setStatusCounts(s => ({ ...s, 'E Mail gesendet': (s['E Mail gesendet'] ?? 0) + 1 }));
      notify(`E-Mail an ${data.to} gesendet.`);
      return undefined;
    }
    notify(data.error || 'Versand fehlgeschlagen.', 'err');
    return data.error;
  }

  async function deleteLead(id: string) {
    setPendingDelete(null); setSelected(null);
    const lead = leads.find(l => l.id === id);
    const response = await fetch(`/api/leads/${id}`, { method: 'DELETE' });
    if (response.ok) {
      setLeads(old => old.filter(l => l.id !== id));
      setStats(s => ({ ...s, total: Math.max(0, s.total - 1) }));
      setActivities(old => old.filter(a => a.lead_id !== id));
      notify(`${lead ? lead.name : id} wurde gelöscht.`);
    } else notify('Löschen fehlgeschlagen.', 'err');
  }

  async function createLead(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const fd = new FormData(event.currentTarget), payload = Object.fromEntries(fd.entries());
    const response = await fetch('/api/leads', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = (await response.json()) as { lead?: Lead; error?: string };
    if (response.ok && data.lead) { setLeads(old => [data.lead!, ...old]); setStats(old => ({ ...old, total: old.total + 1 })); setCreating(false); setSelected(data.lead); notify('Neuer Lead angelegt.'); }
    else notify(data.error || 'Anlegen fehlgeschlagen.', 'err');
  }

  const openView = (next: View) => { setView(next); setQuery(''); setWebsiteFilter('Alle'); setPriorityFilter('Alle'); setStatusFilter('Alle'); };

  return (
    <main className="app-shell">
      <aside className="sidebar">
        <button className="brand" onClick={() => openView('dashboard')}><span className="brand-mark">R</span><span>Reinickendorf<br /><small>Akquise OS</small></span></button>
        <nav aria-label="Hauptnavigation">
          {views.map(item => (
            <button key={item.id} className={`nav-item ${view === item.id ? 'active' : ''}`} onClick={() => openView(item.id)}>
              <span>{item.icon}</span>{item.label}
              {item.id === 'leads' ? <b>{stats.total}</b>
                : item.id === 'tasks' ? <b>{dueCount}</b>
                : item.id === 'appointments' && upcomingApptCount ? <b>{upcomingApptCount}</b>
                : item.id === 'checks' && stats.checking ? <b className="warn">{stats.checking}</b>
                : null}
            </button>
          ))}
        </nav>
        <div className="sidebar-note"><span>●</span><div><strong>{loading ? 'Daten werden geladen' : 'Daten dauerhaft gespeichert'}</strong><small>{stats.total || 952} Unternehmen im CRM</small></div></div>
      </aside>

      <section className="workspace">
        <header className="topbar">
          <div><p className="eyebrow">REINICKENDORF · AKQUISEZENTRALE</p><h1>{view === 'dashboard' ? 'Guten Tag, Vincent.' : views.find(v => v.id === view)?.label}</h1></div>
          <div className="top-actions">
            <label className="search"><span>⌕</span><input value={query} onChange={e => setQuery(e.target.value)} aria-label="Unternehmen suchen" placeholder="Unternehmen, Telefon, PLZ suchen …" /></label>
            <button className="primary" onClick={() => setCreating(true)}>＋ Neuer Lead</button>
          </div>
        </header>

        {loading ? <Loading /> :
          view === 'settings' ? <SettingsPage onToast={msg => notify(msg)} /> :
          view === 'templates' ? <TemplatesPage onToast={notify} /> :
          view === 'appointments' ? <AppointmentsPage leads={leads} onOpenLead={setSelected} onToast={notify} /> :
          view === 'dashboard' ? <Dashboard leads={leads} stats={stats} statusCounts={statusCounts} activities={activities} recommendation={recommendation} onOpen={setSelected} onNavigate={v => openView(v as View)} /> :
          view === 'pipeline' ? <Pipeline leads={filtered} onOpen={setSelected} /> :
          <LeadWorkspace title={view === 'checks' ? 'Website-Angaben verifizieren' : view === 'tasks' ? 'Nächste Aktionen' : 'Alle Unternehmen'}
            subtitle={view === 'checks' ? `${visible.length} Kandidaten brauchen eine eindeutige Prüfung` : view === 'tasks' ? `${visible.length} geplante oder empfohlene Schritte` : `${visible.length} von ${stats.total} Unternehmen`}
            leads={visible} websiteFilter={websiteFilter} setWebsiteFilter={setWebsiteFilter} priorityFilter={priorityFilter} setPriorityFilter={setPriorityFilter} statusFilter={statusFilter} setStatusFilter={setStatusFilter} onOpen={setSelected} onAskDelete={setPendingDelete} />}
      </section>

      {draft && (
        <LeadDrawer
          lead={draft}
          setLead={setDraft}
          onClose={() => setSelected(null)}
          onSave={saveLead}
          onSendEmail={sendEmail}
          onDelete={() => { const id = draft.id; setPendingDelete(leads.find(l => l.id === id) || draft); }}
          templates={templates}
          onAfterAppointment={refreshAppointmentCount}
        />
      )}

      {creating && <CreateModal onClose={() => setCreating(false)} onSubmit={createLead} />}
      {pendingDelete && <ConfirmDelete lead={pendingDelete} onCancel={() => setPendingDelete(null)} onConfirm={() => deleteLead(pendingDelete.id)} />}
      {toast && <div className={`toast ${toast.kind}`}>{toast.kind === 'ok' ? '✓ ' : '⚠ '}{toast.msg}</div>}
    </main>
  );
}

function Loading() { return <div className="loading"><i /><h2>Dein CRM wird vorbereitet</h2><p>Bereinigte Unternehmensprofile werden geladen.</p></div>; }

function ConfirmDelete({ lead, onCancel, onConfirm }: { lead: Lead; onCancel: () => void; onConfirm: () => void }) {
  return (
    <div className="overlay center" onMouseDown={e => { if (e.target === e.currentTarget) onCancel(); }}>
      <div className="confirm-modal">
        <span className="confirm-icon">!</span>
        <h2>„{lead.name}" löschen?</h2>
        <p>Der Lead und sein gesamter Aktivitätsverlauf werden endgültig entfernt. Diese Aktion kann nicht rückgängig gemacht werden.</p>
        <footer><button className="ghost-btn" onClick={onCancel}>Abbrechen</button><button className="danger-btn solid" onClick={onConfirm}>Endgültig löschen</button></footer>
      </div>
    </div>
  );
}

function CreateModal({ onClose, onSubmit }: { onClose: () => void; onSubmit: (e: FormEvent<HTMLFormElement>) => void }) {
  return (
    <div className="overlay center">
      <form className="create-modal" onSubmit={onSubmit}>
        <header><div><span className="eyebrow">NEUES UNTERNEHMEN</span><h2>Lead anlegen</h2></div><button type="button" className="close" onClick={onClose}>×</button></header>
        <div className="form-grid">
          <label className="full">Unternehmensname<input name="name" required autoFocus placeholder="Unternehmen GmbH" /></label>
          <label>Branche<input name="category" placeholder="z. B. Gebäudereinigung" /></label>
          <label>Priorität<select name="priority" defaultValue="Mittel"><option>Hoch</option><option>Mittel</option><option>Niedrig</option></select></label>
          <label>Telefon<input name="phone" placeholder="030 …" /></label>
          <label>E-Mail<input name="email" type="email" placeholder="info@…" /></label>
          <label>PLZ<input name="zip" placeholder="13409" /></label>
          <label>Webseite<select name="websiteStatus" defaultValue="Prüfen"><option>Prüfen</option><option value="Nein">Keine Webseite</option><option value="Ja">Vorhanden</option></select></label>
          <label className="full">Nächste Aktion<input name="nextAction" placeholder="Erstkontakt vorbereiten" /></label>
        </div>
        <footer><button type="button" className="ghost-btn" onClick={onClose}>Abbrechen</button><button className="primary" type="submit">Lead anlegen</button></footer>
      </form>
    </div>
  );
}
