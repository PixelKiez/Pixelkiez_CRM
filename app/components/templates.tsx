'use client';

import { FormEvent, useEffect, useMemo, useState } from 'react';
import type { EmailTemplate } from '@/lib/types';
import { extractPlaceholders } from '@/lib/template-render';

const KINDS: Array<{ value: string; label: string }> = [
  { value: 'general', label: 'Allgemein' },
  { value: 'termin_confirm', label: 'Terminbestätigung' },
  { value: 'praesentation', label: 'Präsentation' },
  { value: 'diagnose', label: 'Diagnose' },
  { value: 'vertrag', label: 'Vertrag' },
  { value: 'rechnung', label: 'Rechnung' },
];
const KIND_LABEL = (k: string) => KINDS.find(x => x.value === k)?.label || k;

export default function TemplatesPage({ onToast }: { onToast: (msg: string, kind?: 'ok' | 'err') => void }) {
  const [templates, setTemplates] = useState<EmailTemplate[]>([]);
  const [loading, setLoading] = useState(true);
  const [selectedId, setSelectedId] = useState<number | 'new' | null>(null);
  const [draft, setDraft] = useState<Partial<EmailTemplate>>({ name: '', kind: 'general', subject: '', bodyHtml: '' });
  const [saving, setSaving] = useState(false);

  const active = useMemo(() => (typeof selectedId === 'number' ? templates.find(t => t.id === selectedId) ?? null : null), [templates, selectedId]);

  useEffect(() => {
    fetch('/api/templates')
      .then(async r => (await r.json()) as { templates: EmailTemplate[] })
      .then(d => { setTemplates(d.templates); setLoading(false); if (d.templates.length && selectedId === null) setSelectedId(d.templates[0].id); })
      .catch(() => { onToast('Vorlagen konnten nicht geladen werden.', 'err'); setLoading(false); });

  }, []);

  useEffect(() => {
    if (selectedId === 'new') setDraft({ name: '', kind: 'general', subject: '', bodyHtml: '<p>Guten Tag {{ansprechpartner}},</p><p></p>' });
    else if (active) setDraft({ id: active.id, name: active.name, kind: active.kind, subject: active.subject, bodyHtml: active.bodyHtml });
  }, [selectedId, active]);

  const placeholders = useMemo(() => extractPlaceholders((draft.subject || '') + ' ' + (draft.bodyHtml || '')), [draft.subject, draft.bodyHtml]);
  const set = (key: keyof EmailTemplate, value: string) => setDraft(d => ({ ...d, [key]: value }));

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft.name?.trim() || !draft.subject?.trim() || !draft.bodyHtml?.trim())
      return onToast('Name, Betreff und Inhalt sind erforderlich.', 'err');
    setSaving(true);
    const isNew = selectedId === 'new';
    const url = isNew ? '/api/templates' : `/api/templates/${draft.id}`;
    const method = isNew ? 'POST' : 'PATCH';
    const response = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: draft.name, kind: draft.kind, subject: draft.subject, bodyHtml: draft.bodyHtml }),
    });
    const data = (await response.json()) as { template?: EmailTemplate; error?: string };
    setSaving(false);
    if (!response.ok || !data.template) return onToast(data.error || 'Speichern fehlgeschlagen.', 'err');
    setTemplates(list => (isNew ? [...list, data.template!] : list.map(t => (t.id === data.template!.id ? data.template! : t))));
    setSelectedId(data.template.id);
    onToast(isNew ? 'Vorlage angelegt.' : 'Vorlage gespeichert.');
  }

  async function remove() {
    if (typeof selectedId !== 'number') return;
    if (!confirm('Vorlage endgültig löschen?')) return;
    const response = await fetch(`/api/templates/${selectedId}`, { method: 'DELETE' });
    const data = (await response.json()) as { ok?: boolean; error?: string };
    if (!response.ok) return onToast(data.error || 'Löschen fehlgeschlagen.', 'err');
    setTemplates(list => list.filter(t => t.id !== selectedId));
    setSelectedId(templates.find(t => t.id !== selectedId)?.id ?? null);
    onToast('Vorlage gelöscht.');
  }

  if (loading) return <div className="panel settings-panel"><p className="muted">Lade Vorlagen …</p></div>;

  return (
    <div className="templates-grid">
      <aside className="panel templates-list">
        <div className="panel-head">
          <div><span className="eyebrow">VORLAGEN</span><h2>E-Mail-Vorlagen</h2></div>
          <button className="primary" onClick={() => setSelectedId('new')}>＋ Neu</button>
        </div>
        <ul>
          {templates.map(t => (
            <li key={t.id}>
              <button className={selectedId === t.id ? 'active' : ''} onClick={() => setSelectedId(t.id)}>
                <strong>{t.name}</strong>
                <small>{KIND_LABEL(t.kind)}</small>
              </button>
            </li>
          ))}
          {!templates.length && <li className="muted" style={{ padding: '10px 12px' }}>Noch keine Vorlagen.</li>}
        </ul>
      </aside>

      <form className="panel templates-editor" onSubmit={save}>
        <div className="panel-head">
          <div><span className="eyebrow">{selectedId === 'new' ? 'NEUE VORLAGE' : 'BEARBEITEN'}</span><h2>{draft.name || 'Neue Vorlage'}</h2></div>
          {typeof selectedId === 'number' && active?.kind !== 'termin_confirm' && (
            <button type="button" className="danger-btn" onClick={remove}>Löschen</button>
          )}
        </div>
        <div className="form-grid">
          <label>Name<input value={draft.name || ''} onChange={e => set('name', e.target.value)} placeholder="z. B. Erstkontakt Dachdecker" required /></label>
          <label>Typ
            <select value={draft.kind || 'general'} onChange={e => set('kind', e.target.value)}>
              {KINDS.map(k => <option key={k.value} value={k.value}>{k.label}</option>)}
            </select>
          </label>
          <label className="full">Betreff<input value={draft.subject || ''} onChange={e => set('subject', e.target.value)} placeholder="{{firma}} – kurzer Vorschlag" required /></label>
          <label className="full">Inhalt (HTML)
            <textarea rows={12} value={draft.bodyHtml || ''} onChange={e => set('bodyHtml', e.target.value)} placeholder="<p>Guten Tag {{ansprechpartner}},</p>" required />
          </label>
        </div>
        <section className="placeholder-help">
          <strong>Verfügbare Platzhalter</strong>
          <p className="muted">In Betreff und Inhalt kannst du beliebig viele <code>{'{{platzhalter}}'}</code> setzen. Vorbelegt aus dem Lead:</p>
          <div className="chip-row">
            {['firma', 'branche', 'stadt', 'plz', 'strasse', 'telefon', 'email', 'website', 'ansprechpartner', 'website_hinweis', 'probleme', 'pitch', 'status', 'prioritaet', 'absender'].map(k => (
              <code key={k}>{`{{${k}}}`}</code>
            ))}
          </div>
          <p className="muted" style={{ marginTop: 10 }}>Nur bei Terminbestätigung zusätzlich:</p>
          <div className="chip-row">
            {['termin_titel', 'termin_datum', 'termin_zeit', 'termin_bis', 'termin_ort', 'termin_notiz', 'termin_link'].map(k => (
              <code key={k}>{`{{${k}}}`}</code>
            ))}
          </div>
          {placeholders.length ? (
            <p className="muted" style={{ marginTop: 10 }}>In dieser Vorlage benutzt: {placeholders.map(p => <code key={p} style={{ marginRight: 6 }}>{`{{${p}}}`}</code>)}</p>
          ) : null}
        </section>
        <footer className="settings-actions">
          <button className="primary" type="submit" disabled={saving}>{saving ? <span className="btn-spin" /> : 'Speichern'}</button>
        </footer>
      </form>
    </div>
  );
}
