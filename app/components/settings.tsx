'use client';

import { FormEvent, useEffect, useState } from 'react';
import CompanySettings from '@/app/components/company-settings';
import type { SettingsView } from '@/lib/types';

const blank: SettingsView = {
  smtp_host: 'smtp.hostinger.com', smtp_port: 465, smtp_user: '', smtp_from: '', smtp_sender_name: '', smtp_pass_set: false,
  agent_key_set: false, google_connected: false, google_calendar_id: 'primary',
};

export default function SettingsPage({ onToast }: { onToast: (msg: string) => void }) {
  const [settings, setSettings] = useState<SettingsView>(blank);
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [testTo, setTestTo] = useState('');
  const [newAgentKey, setNewAgentKey] = useState<string | null>(null);
  const [rotating, setRotating] = useState(false);
  const [calendarId, setCalendarId] = useState('primary');

  useEffect(() => {
    fetch('/api/settings').then(async r => (await r.json()) as { settings: SettingsView }).then(d => { setSettings(d.settings); setCalendarId(d.settings.google_calendar_id || 'primary'); setLoading(false); }).catch(() => { onToast('Einstellungen konnten nicht geladen werden.'); setLoading(false); });
    const params = new URLSearchParams(window.location.search);
    const google = params.get('google');
    if (google === 'connected') onToast('Google-Kalender verbunden.');
    else if (google === 'error') onToast(`Google-Verbindung fehlgeschlagen: ${params.get('detail') || 'unbekannter Fehler'}`);
    if (google) { params.delete('google'); params.delete('detail'); params.delete('email'); const url = params.toString() ? `?${params.toString()}` : window.location.pathname; window.history.replaceState({}, '', url); }
  }, []);

  const set = (key: keyof SettingsView, value: string | number | boolean) => setSettings(s => ({ ...s, [key]: value }));

  async function save(event: FormEvent) {
    event.preventDefault(); setSaving(true);
    const payload: { [key: string]: string | number } = {
      smtp_host: settings.smtp_host, smtp_port: settings.smtp_port, smtp_user: settings.smtp_user,
      smtp_from: settings.smtp_from, smtp_sender_name: settings.smtp_sender_name,
      google_calendar_id: calendarId,
    };
    if (password) payload.smtp_pass = password;
    const response = await fetch('/api/settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    const data = (await response.json()) as { ok?: boolean; error?: string };
    setSaving(false);
    onToast(data.ok ? 'Einstellungen gespeichert.' : data.error || 'Speichern fehlgeschlagen.');
  }

  async function sendTest() {
    if (!testTo) return; setTesting(true);
    const response = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ to: testTo }) });
    const data = (await response.json()) as { ok?: boolean; error?: string };
    setTesting(false);
    onToast(data.ok ? 'Testmail gesendet – prüfe dein Postfach.' : data.error || 'Test fehlgeschlagen.');
  }

  async function rotateAgentKey() {
    if (settings.agent_key_set && !confirm('Neuen Agent-Key erzeugen? Der alte Key ist danach ungültig — Hermes muss den neuen Key bekommen.')) return;
    setRotating(true);
    const response = await fetch('/api/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'rotate_agent_key' }) });
    const data = (await response.json()) as { ok?: boolean; agent_key?: string; error?: string };
    setRotating(false);
    if (!response.ok || !data.agent_key) return onToast(data.error || 'Rotation fehlgeschlagen.');
    setNewAgentKey(data.agent_key);
    setSettings(s => ({ ...s, agent_key_set: true, agent_key_preview: `${data.agent_key!.slice(0, 4)}…${data.agent_key!.slice(-4)}` }));
    onToast('Neuer Agent-Key erzeugt. Bitte gleich sicher speichern.');
  }

  async function disconnectGoogle() {
    if (!confirm('Google-Kalender-Verknüpfung entfernen?')) return;
    const response = await fetch('/api/auth/google/disconnect', { method: 'POST' });
    if (response.ok) { setSettings(s => ({ ...s, google_connected: false, google_email: undefined })); onToast('Google-Kalender getrennt.'); }
    else onToast('Trennen fehlgeschlagen.');
  }

  if (loading) return <div className="panel settings-panel"><p className="muted">Lade Einstellungen …</p></div>;

  return (
    <form className="settings-grid" onSubmit={save}>
      <CompanySettings onToast={onToast} />

      <article className="panel settings-panel">
        <div className="panel-head">
          <div><span className="eyebrow">E-MAIL-KONFIGURATION</span><h2>Dein Hostinger-Postfach</h2></div>
          <span className={`conn-badge ${settings.smtp_pass_set && settings.smtp_user ? 'ok' : ''}`}>{settings.smtp_pass_set && settings.smtp_user ? '● eingerichtet' : '○ nicht konfiguriert'}</span>
        </div>
        <p className="muted">Versende E-Mails direkt aus dem CRM über dein Postfach bei Hostinger (IMAP/SMTP mit deiner Domain). Zugangsdaten findest du im Hostinger-Panel unter <em>E-Mails → Konto verwalten → Konfiguration</em>.</p>
        <div className="form-grid">
          <label>SMTP-Server<input value={settings.smtp_host} onChange={e => set('smtp_host', e.target.value)} placeholder="smtp.hostinger.com" /></label>
          <label>Port<select value={String(settings.smtp_port)} onChange={e => set('smtp_port', Number(e.target.value))}><option value="465">465 (empfohlen, TLS)</option><option value="587">587 (STARTTLS)</option></select></label>
          <label>Benutzer / E-Mail<input value={settings.smtp_user} onChange={e => set('smtp_user', e.target.value)} placeholder="kontakt@deine-domain.de" /></label>
          <label>Passwort{settings.smtp_pass_set && <small className="set-hint"> · gespeichert</small>}<input type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder={settings.smtp_pass_set ? '•••••••• (unverändert)' : 'Passwort'} /></label>
          <label>Absenderadresse<input value={settings.smtp_from} onChange={e => set('smtp_from', e.target.value)} placeholder="kontakt@deine-domain.de" /></label>
          <label>Absendername<input value={settings.smtp_sender_name} onChange={e => set('smtp_sender_name', e.target.value)} placeholder="Vincent Schnetzer" /></label>
        </div>
        <footer className="settings-actions"><button className="primary" type="submit" disabled={saving}>{saving ? <span className="btn-spin" /> : 'Speichern'}</button></footer>
      </article>

      <article className="panel settings-panel">
        <div className="panel-head"><div><span className="eyebrow">VERBINDUNGSTEST</span><h2>Test-E-Mail senden</h2></div></div>
        <p className="muted">Prüft Server, Anmeldung und Versand in einem Schritt. Die Testmail landet im angegebenen Postfach.</p>
        <label className="field">Empfänger für Testmail<input type="email" value={testTo} onChange={e => setTestTo(e.target.value)} placeholder="du@example.de" /></label>
        <footer className="settings-actions"><button type="button" className="dark" disabled={testing || !testTo || !settings.smtp_user || !settings.smtp_pass_set} onClick={sendTest}>{testing ? <span className="btn-spin" /> : 'Testmail senden'}</button></footer>
      </article>

      <article className="panel settings-panel">
        <div className="panel-head">
          <div><span className="eyebrow">GOOGLE-KALENDER</span><h2>Termine mit Google synchronisieren</h2></div>
          <span className={`conn-badge ${settings.google_connected ? 'ok' : ''}`}>{settings.google_connected ? `● ${settings.google_email || 'verbunden'}` : '○ nicht verbunden'}</span>
        </div>
        <p className="muted">Wenn verbunden, wird jeder im CRM angelegte Termin automatisch als Google-Event angelegt. Falls der Lead eine E-Mail hat, erhält er eine Einladung. Zugangsdaten (Client-ID, Client-Secret) werden als Railway-Env-Variablen erwartet.</p>
        <label className="field">Kalender-ID (Standard „primary")<input value={calendarId} onChange={e => setCalendarId(e.target.value)} placeholder="primary" /></label>
        <footer className="settings-actions">
          {settings.google_connected
            ? <>
                <a className="dark" href="/api/auth/google/start">Neu autorisieren</a>
                <button type="button" className="danger-btn" onClick={disconnectGoogle}>Trennen</button>
              </>
            : <a className="primary" href="/api/auth/google/start">Mit Google verbinden</a>}
        </footer>
      </article>

      <article className="panel settings-panel">
        <div className="panel-head">
          <div><span className="eyebrow">AGENT-API (HERMES)</span><h2>Fern-Zugriff für Recherche-Agent</h2></div>
          <span className={`conn-badge ${settings.agent_key_set ? 'ok' : ''}`}>{settings.agent_key_set ? `● Key gesetzt (${settings.agent_key_preview})` : '○ noch kein Key'}</span>
        </div>
        <p className="muted">Der Hermes-Agent auf deinem VPS ruft die CRM-API mit einem Bearer-Token auf. Endpunkte: <code>/api/agent/leads</code> (POST), <code>/api/agent/leads/&lt;id&gt;</code> (PATCH), <code>/api/agent/leads/&lt;id&gt;/activities</code> (POST), <code>/api/agent/leads/search</code> (GET), <code>/api/agent/ping</code> (GET).</p>
        {newAgentKey && (
          <div className="agent-key-box">
            <span className="eyebrow">EINMALIG SICHTBAR — JETZT IN HERMES SPEICHERN</span>
            <code>{newAgentKey}</code>
            <button type="button" className="ghost-btn" onClick={() => { navigator.clipboard?.writeText(newAgentKey); }}>Kopieren</button>
          </div>
        )}
        <footer className="settings-actions">
          <button type="button" className="dark" disabled={rotating} onClick={rotateAgentKey}>{rotating ? <span className="btn-spin" /> : settings.agent_key_set ? 'Neuen Key erzeugen' : 'Agent-Key erzeugen'}</button>
        </footer>
      </article>
    </form>
  );
}
