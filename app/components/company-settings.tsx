'use client';

import { useEffect, useState } from 'react';

type Company = Record<string, string>;

const FIELDS: Array<{ key: string; label: string; placeholder?: string; wide?: boolean }> = [
  { key: 'company_name', label: 'Firmenname', placeholder: 'Pixelkiez', wide: true },
  { key: 'company_contact', label: 'Ansprechpartner', placeholder: 'Vincent Schnetzer' },
  { key: 'company_street', label: 'Straße und Hausnummer', placeholder: 'Musterstraße 1' },
  { key: 'company_zip', label: 'PLZ', placeholder: '13409' },
  { key: 'company_city', label: 'Ort', placeholder: 'Berlin' },
  { key: 'company_phone', label: 'Telefon', placeholder: '030 …' },
  { key: 'company_email', label: 'E-Mail', placeholder: 'kontakt@…' },
  { key: 'company_tax_number', label: 'Steuernummer', placeholder: '12/345/67890' },
  { key: 'company_vat_id', label: 'USt-IdNr.', placeholder: 'DE123456789' },
  { key: 'company_bank', label: 'Bank', placeholder: 'Musterbank' },
  { key: 'company_iban', label: 'IBAN', placeholder: 'DE00 0000 0000 0000 0000 00' },
  { key: 'company_bic', label: 'BIC', placeholder: 'XXXXDEXXXXX' },
  { key: 'invoice_prefix', label: 'Rechnungsnummer-Präfix', placeholder: 'PK-2026-' },
  { key: 'invoice_next_number', label: 'Nächste Rechnungsnummer', placeholder: '1' },
  { key: 'invoice_vat_rate', label: 'Umsatzsteuersatz in Prozent', placeholder: '19' },
  { key: 'invoice_service_label', label: 'Standard-Leistungsbezeichnung', placeholder: 'Erstellung einer Webseite', wide: true },
];

/**
 * Firmenstammdaten für Vertrag und Rechnung.
 * Bewusst kein eigenes <form>: die Einstellungsseite ist selbst eines,
 * verschachtelte Formulare sind ungültiges HTML.
 */
export default function CompanySettings({ onToast }: { onToast: (msg: string) => void }) {
  const [company, setCompany] = useState<Company>({});
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/settings')
      .then(async r => (await r.json()) as { company?: Company })
      .then(d => { setCompany(d.company ?? {}); setLoading(false); })
      .catch(() => { onToast('Firmendaten konnten nicht geladen werden.'); setLoading(false); });
  }, [onToast]);

  async function save() {
    setSaving(true);
    try {
      const response = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(company),
      });
      const data = (await response.json()) as { company?: Company; error?: string };
      if (!response.ok) onToast(data.error || 'Speichern fehlgeschlagen.');
      else {
        if (data.company) setCompany(data.company);
        onToast('Firmendaten gespeichert.');
      }
    } catch {
      onToast('Der Server ist nicht erreichbar.');
    }
    setSaving(false);
  }

  const complete = Boolean(company.company_name && company.company_street && company.company_city);

  return (
    <article className="panel settings-panel">
      <div className="panel-head">
        <div><span className="eyebrow">STAMMDATEN</span><h2>Firmenangaben für Vertrag und Rechnung</h2></div>
        <span className={`conn-badge ${complete ? 'ok' : ''}`}>{complete ? '● vollständig' : '○ unvollständig'}</span>
      </div>
      <p className="muted">Diese Angaben werden automatisch in jeden Vertrag und jede Rechnung übernommen. Rechnungen weisen die Umsatzsteuer gesondert aus — Steuernummer oder USt-IdNr. sind dafür Pflicht.</p>
      {loading ? <p className="muted">Wird geladen …</p> : (
        <div className="form-grid">
          {FIELDS.map(field => (
            <label key={field.key} className={field.wide ? 'full' : undefined}>
              {field.label}
              <input
                value={company[field.key] ?? ''}
                placeholder={field.placeholder}
                onChange={e => setCompany(c => ({ ...c, [field.key]: e.target.value }))}
              />
            </label>
          ))}
        </div>
      )}
      <footer className="settings-actions">
        <button type="button" className="primary" disabled={saving || loading} onClick={save}>
          {saving ? <span className="btn-spin" /> : 'Firmendaten speichern'}
        </button>
      </footer>
    </article>
  );
}
