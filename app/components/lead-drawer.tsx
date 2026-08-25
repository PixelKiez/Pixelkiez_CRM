'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import type { Activity, Appointment, EmailTemplate, Lead } from '@/lib/types';
import { buildLeadContext, renderTemplate } from '@/lib/template-render';

const statusOptions = ['Neu','E Mail gesendet','Recherche offen','Telefonat geplant','Erstgespräch geplant','Angebot gesendet','Gewonnen','Verloren','Ausgeschlossen'];
const label = (value: string | null) => value ? value.replaceAll('_', ' ').replace(/\b\w/g, c => c.toUpperCase()) : 'Nicht angegeben';
const contactHref = (kind: string, value: string) => kind === 'phone' ? `tel:${value.replace(/\s/g, '')}` : kind === 'email' ? `mailto:${value}` : value.startsWith('http') ? value : `https://${value}`;
const smartAction = (lead: Lead) => lead.websiteStatus === 'Nein' && lead.phone ? 'Telefonischer Erstkontakt: lokales Webseiten-Paket anbieten' : lead.websiteStatus === 'Prüfen' ? 'Website und Firmenidentität vor der Ansprache verifizieren' : lead.email ? 'Kurze personalisierte E-Mail mit konkretem Verbesserungsvorschlag senden' : 'Kontaktdaten ergänzen und Ansprechpartner recherchieren';

type Tab = 'overview' | 'call' | 'email' | 'appointment' | 'activity';

function fmtLocalDatetime(d: Date) {
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
function defaultStart(): string {
  const d = new Date(); d.setMinutes(0, 0, 0); d.setDate(d.getDate() + 1); d.setHours(10); return fmtLocalDatetime(d);
}
function addMinutes(iso: string, minutes: number): string {
  const d = new Date(iso); d.setMinutes(d.getMinutes() + minutes); return fmtLocalDatetime(d);
}

export default function LeadDrawer({
  lead, setLead, onClose, onSave, onSendEmail, onDelete, templates, onAfterAppointment,
}: {
  lead: Lead;
  setLead: (l: Lead) => void;
  onClose: () => void;
  onSave: () => void;
  onSendEmail: (subject: string, html: string) => Promise<string | undefined>;
  onDelete: () => void;
  templates: EmailTemplate[];
  onAfterAppointment?: () => void;
}) {
  const [tab, setTab] = useState<Tab>('overview');
  const [activities, setActivities] = useState<Activity[]>([]);
  const [appointments, setAppointments] = useState<Appointment[]>([]);
  const [mailSubject, setMailSubject] = useState('');
  const [mailBody, setMailBody] = useState('');
  const [sending, setSending] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const [selectedTplId, setSelectedTplId] = useState<number | ''>('');
  const [ansprechpartner, setAnsprechpartner] = useState('');

  // Termin-Formular
  const [apptTitle, setApptTitle] = useState('Erstgespräch');
  const [apptStart, setApptStart] = useState(defaultStart());
  const [apptEnd, setApptEnd] = useState(addMinutes(defaultStart(), 30));
  const [apptLocation, setApptLocation] = useState('Telefon');
  const [apptNotes, setApptNotes] = useState('');
  const [apptSendMail, setApptSendMail] = useState(true);
  const [apptBusy, setApptBusy] = useState(false);

  const set = (key: keyof Lead, value: string | number) => setLead({ ...lead, [key]: value });

  useEffect(() => {
    fetch(`/api/leads/${lead.id}`).then(async r => (await r.json()) as { activities?: Activity[] }).then(d => setActivities(d.activities ?? [])).catch(() => {});
    fetch(`/api/appointments?leadId=${encodeURIComponent(lead.id)}`).then(async r => (await r.json()) as { appointments?: Appointment[] }).then(d => setAppointments(d.appointments ?? [])).catch(() => {});
  }, [lead.id]);

  const generalTemplates = useMemo(() => templates.filter(t => t.kind !== 'termin_confirm'), [templates]);

  async function save() { setSaving(true); await onSave(); setSaving(false); }

  async function send() {
    if (!mailSubject.trim() || !mailBody.trim()) return;
    setSending(true);
    const error = await onSendEmail(mailSubject, mailBody);
    setSending(false);
    if (!error) setTab('overview');
  }

  function applyTemplate(id: number) {
    const template = templates.find(t => t.id === id);
    if (!template) return;
    setSelectedTplId(id);
    const ctx = buildLeadContext(lead, { ansprechpartner });
    setMailSubject(renderTemplate(template.subject, ctx));
    setMailBody(renderTemplate(template.bodyHtml, ctx));
  }

  async function createAppointment(event: FormEvent) {
    event.preventDefault();
    setApptBusy(true);
    const response = await fetch('/api/appointments', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        leadId: lead.id,
        title: apptTitle,
        startTs: new Date(apptStart).toISOString(),
        endTs: new Date(apptEnd).toISOString(),
        location: apptLocation,
        notes: apptNotes,
        sendConfirmation: apptSendMail,
        ansprechpartner,
      }),
    });
    const data = (await response.json()) as { appointment?: Appointment; warnings?: string[]; error?: string };
    setApptBusy(false);
    if (!response.ok || !data.appointment) {
      alert(data.error || 'Termin konnte nicht angelegt werden.');
      return;
    }
    setAppointments(list => [...list, data.appointment!]);
    onAfterAppointment?.();
    setTab('overview');
    if (data.warnings?.length) alert(data.warnings.join('\n'));
  }

  const problems = (lead.problems || '').split(/\n|·|;|,\s*(?=[A-ZÄÖÜ])/).map(s => s.trim()).filter(Boolean);

  return (
    <div className="overlay" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
      <aside className="drawer">
        <header>
          <div className="drawer-title">
            <i>{lead.name[0]}</i>
            <div>
              <span>{lead.id} · Score {lead.score}</span>
              <h2>{lead.name}</h2>
              <p>{label(lead.category)} · {lead.zip} {lead.city}</p>
            </div>
          </div>
          <button className="close" onClick={onClose} aria-label="Schließen">×</button>
        </header>

        <nav className="tabs" role="tablist">
          {(['overview', 'call', 'email', 'appointment', 'activity'] as Tab[]).map(id => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}>
              {id === 'overview' ? 'Übersicht'
                : id === 'call' ? `Anrufen${lead.phone ? '' : ' (fehlt)'}`
                : id === 'email' ? `E-Mail${lead.email ? '' : ' (fehlt)'}`
                : id === 'appointment' ? 'Termin'
                : 'Aktivität'}
            </button>
          ))}
        </nav>

        {tab === 'overview' && <>
          {lead.phone || lead.email || lead.website ? (
            <div className="contact-row">
              {lead.phone && <a href={contactHref('phone', lead.phone)}>☎ Anrufen</a>}
              {lead.email && <a href={contactHref('email', lead.email)}>✉ E-Mail</a>}
              {lead.website && <a href={contactHref('website', lead.website)} target="_blank" rel="noreferrer">↗ Webseite</a>}
            </div>
          ) : null}
          <section className="smart-box">
            <span>EMPFOHLENER NÄCHSTER SCHRITT</span>
            <strong>{smartAction(lead)}</strong>
            <p>{lead.pitch || 'Nutze die vorhandenen Kontaktdaten für eine konkrete, lokale Ansprache.'}</p>
          </section>
          <div className="form-grid">
            <label>Status<select value={lead.status} onChange={e => set('status', e.target.value)}>{statusOptions.map(x => <option key={x}>{x}</option>)}</select></label>
            <label>Priorität<select value={lead.priority} onChange={e => set('priority', e.target.value)}><option>Hoch</option><option>Mittel</option><option>Niedrig</option></select></label>
            <label>Website-Status<select value={lead.websiteStatus} onChange={e => set('websiteStatus', e.target.value)}><option>Ja</option><option>Nein</option><option>Prüfen</option></select></label>
            <label>Wiedervorlage<input type="date" value={lead.followUp || ''} onChange={e => set('followUp', e.target.value)} /></label>
            <label className="full">Nächste Aktion<input value={lead.nextAction || ''} onChange={e => set('nextAction', e.target.value)} placeholder="Zum Beispiel: Dienstag anrufen" /></label>
            <label className="full">Webseite<input value={lead.website || ''} onChange={e => set('website', e.target.value)} placeholder="https://…" /></label>
            <label className="full">Notizen<textarea rows={3} value={lead.notes || ''} onChange={e => set('notes', e.target.value)} placeholder="Gesprächsverlauf, Absagen, Besonderheiten …" /></label>
          </div>
          <section className="danger-zone">
            <div><h3>Lead löschen</h3><small>Entfernt den Lead samt Aktivitätsverlauf endgültig. Diese Aktion kann nicht rückgängig gemacht werden.</small></div>
            {!confirmDelete
              ? <button className="danger-btn" onClick={() => setConfirmDelete(true)}>Löschen</button>
              : <div className="danger-confirm"><span>Sicher? Endgültig entfernen.</span><button className="danger-btn solid" onClick={onDelete}>Endgültig löschen</button><button className="ghost-btn" onClick={() => setConfirmDelete(false)}>Abbrechen</button></div>}
          </section>
        </>}

        {tab === 'call' && (
          <section className="call-guide">
            <div className="call-header">
              <div>
                <span className="eyebrow">COLD-CALL-LEITFADEN</span>
                <h3>{lead.name}</h3>
                <p className="muted">{label(lead.category)}{lead.city ? ` · ${lead.city}` : ''}</p>
              </div>
              {lead.phone
                ? <a href={contactHref('phone', lead.phone)} className="primary big-call">☎ {lead.phone}</a>
                : <span className="muted">Keine Nummer hinterlegt</span>}
            </div>

            <div className="call-columns">
              <article>
                <span className="eyebrow">WEBSITE-STATUS</span>
                <p>
                  <strong>{lead.websiteStatus}</strong>
                  {lead.website ? <> · <a href={contactHref('website', lead.website)} target="_blank" rel="noreferrer">{lead.website}</a></> : null}
                </p>
              </article>
              <article>
                <span className="eyebrow">SCORE / PRIORITÄT</span>
                <p><strong>{lead.score}</strong> · {lead.priority}</p>
              </article>
            </div>

            {problems.length > 0 && (
              <article className="call-block">
                <span className="eyebrow">PROBLEME · AUFHÄNGER FÜRS GESPRÄCH</span>
                <ul className="problem-list">
                  {problems.map((p, i) => <li key={i}>{p}</li>)}
                </ul>
              </article>
            )}

            <article className="call-block pitch-block">
              <span className="eyebrow">PITCH · WAS DU SAGST</span>
              <textarea
                rows={10}
                value={lead.pitch || ''}
                onChange={e => set('pitch', e.target.value)}
                placeholder="Kurzer, spezifischer Gesprächsleitfaden — Hermes trägt hier normalerweise die Recherche-Erkenntnisse ein."
              />
              <div className="composer-actions">
                <button className="ghost-btn" type="button" onClick={() => navigator.clipboard?.writeText(lead.pitch || '')}>Pitch kopieren</button>
                <button className="primary" type="button" disabled={saving} onClick={save}>{saving ? <span className="btn-spin" /> : 'Speichern'}</button>
              </div>
            </article>

            {lead.nextAction && (
              <article className="call-block">
                <span className="eyebrow">GEPLANTE NÄCHSTE AKTION</span>
                <p>{lead.nextAction}</p>
              </article>
            )}
          </section>
        )}

        {tab === 'email' && (
          <section className="composer">
            {!lead.email ? (
              <div className="empty tall"><strong>Keine E-Mail hinterlegt</strong><span>Ergänze die Adresse im Tab „Übersicht", um direkt zu versenden.</span></div>
            ) : <>
              <p className="composer-meta">Absender: dein Hostinger-Postfach (siehe Einstellungen) · Empfänger: <strong>{lead.email}</strong></p>
              <div className="template-row">
                <label style={{ flex: 1 }}>
                  Vorlage
                  <select value={selectedTplId} onChange={e => { const id = Number(e.target.value); if (id) applyTemplate(id); else { setSelectedTplId(''); setMailSubject(''); setMailBody(''); } }}>
                    <option value="">– leer –</option>
                    {generalTemplates.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                  </select>
                </label>
                <label style={{ flex: 1 }}>
                  Ansprechpartner
                  <input value={ansprechpartner} onChange={e => setAnsprechpartner(e.target.value)} placeholder="Herr Müller (optional)" />
                </label>
              </div>
              <label className="field">Betreff<input value={mailSubject} onChange={e => setMailSubject(e.target.value)} placeholder="Betreff …" /></label>
              <label className="field">Nachricht (HTML)<textarea rows={12} value={mailBody} onChange={e => setMailBody(e.target.value)} placeholder="<p>Guten Tag, …" /></label>
              <div className="composer-actions">
                <button className="primary" disabled={sending || !mailSubject.trim() || !mailBody.trim()} onClick={send}>{sending ? <span className="btn-spin" /> : '✉ Jetzt senden'}</button>
              </div>
            </>}
          </section>
        )}

        {tab === 'appointment' && (
          <section className="composer">
            <form onSubmit={createAppointment} className="form-grid">
              <label className="full">Titel<input value={apptTitle} onChange={e => setApptTitle(e.target.value)} required /></label>
              <label>Start<input type="datetime-local" value={apptStart} onChange={e => { setApptStart(e.target.value); setApptEnd(addMinutes(e.target.value, 30)); }} required /></label>
              <label>Ende<input type="datetime-local" value={apptEnd} onChange={e => setApptEnd(e.target.value)} required /></label>
              <label className="full">Ort / Kanal<input value={apptLocation} onChange={e => setApptLocation(e.target.value)} placeholder="Telefon, Zoom, vor Ort …" /></label>
              <label className="full">Notiz<textarea rows={3} value={apptNotes} onChange={e => setApptNotes(e.target.value)} /></label>
              <label className="full checkbox">
                <input type="checkbox" checked={apptSendMail} onChange={e => setApptSendMail(e.target.checked)} />
                Terminbestätigung per E-Mail senden {lead.email ? `an ${lead.email}` : '(keine E-Mail hinterlegt)'}
              </label>
              <div className="composer-actions full">
                <button className="primary" disabled={apptBusy} type="submit">{apptBusy ? <span className="btn-spin" /> : 'Termin anlegen'}</button>
              </div>
            </form>

            {appointments.length > 0 && (
              <div className="existing-appointments">
                <h4>Bereits geplant</h4>
                <ul>
                  {appointments.map(a => (
                    <li key={a.id}>
                      <strong>{new Date(a.startTs).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })}</strong>
                      <span>{a.title}</span>
                      {a.gcalLink && <a href={a.gcalLink} target="_blank" rel="noreferrer">Google →</a>}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </section>
        )}

        {tab === 'activity' && (
          <section className="timeline-wrap">
            {activities.length ? (
              <ol className="timeline">
                {activities.map(a => (
                  <li key={a.id}>
                    <span className={`dot t-${a.type}`} />
                    <div>
                      <strong>{
                        a.type === 'email_sent' ? 'E-Mail gesendet'
                          : a.type === 'email_failed' ? 'Versand fehlgeschlagen'
                          : a.type === 'created' ? 'Lead angelegt'
                          : a.type === 'enriched' ? 'Angereichert (Agent)'
                          : a.type === 'agent_note' ? 'Agent-Notiz'
                          : a.type === 'appointment_created' ? 'Termin angelegt'
                          : a.type === 'appointment_cancelled' ? 'Termin abgesagt'
                          : 'Bearbeitet'
                      }</strong>
                      {a.detail && <small>{a.detail}</small>}
                      <time>{new Date(a.created_at).toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' })}</time>
                    </div>
                  </li>
                ))}
              </ol>
            ) : (
              <div className="empty tall"><strong>Noch keine Aktivitäten</strong><span>Änderungen und E-Mail-Versände werden hier protokolliert.</span></div>
            )}
          </section>
        )}

        <footer>
          {tab !== 'overview' && <button className="ghost-btn" onClick={() => setTab('overview')}>Zurück zur Übersicht</button>}
          <button className="primary" disabled={saving} onClick={save}>{saving ? <span className="btn-spin" /> : 'Speichern'}</button>
        </footer>
      </aside>
    </div>
  );
}
