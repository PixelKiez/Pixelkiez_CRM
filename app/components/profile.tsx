'use client';

import { useEffect, useState } from 'react';
import type { UserProfile } from '@/lib/types';

/**
 * Persönliche Einstellungen.
 * Das CRM und seine Daten sind gemeinsam — Name, Signatur und Kalender sind es nicht.
 */
export default function ProfilePage({ onToast }: { onToast: (msg: string, kind?: 'ok' | 'err') => void }) {
  const [profile, setProfile] = useState<UserProfile | null>(null);
  const [team, setTeam] = useState<UserProfile[]>([]);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    fetch('/api/profile')
      .then(async r => {
        if (r.status === 401) { window.location.assign('/login'); return null; }
        return (await r.json()) as { profile: UserProfile; users: UserProfile[] };
      })
      .then(d => { if (d) { setProfile(d.profile); setTeam(d.users); } })
      .catch(() => onToast('Profil konnte nicht geladen werden.', 'err'));
  }, [onToast]);

  const set = (key: keyof UserProfile, value: string) =>
    setProfile(p => (p ? { ...p, [key]: value } : p));

  async function save() {
    if (!profile) return;
    setSaving(true);
    try {
      const response = await fetch('/api/profile', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          displayName: profile.displayName,
          phone: profile.phone,
          signature: profile.signature,
          googleCalendarId: profile.googleCalendarId,
        }),
      });
      const data = (await response.json()) as { profile?: UserProfile; error?: string };
      if (!response.ok || !data.profile) onToast(data.error || 'Speichern fehlgeschlagen.', 'err');
      else { setProfile(data.profile); onToast('Profil gespeichert.'); }
    } catch {
      onToast('Der Server ist nicht erreichbar.', 'err');
    }
    setSaving(false);
  }

  async function disconnect() {
    await fetch('/api/auth/google/disconnect', { method: 'POST' }).catch(() => {});
    setProfile(p => (p ? { ...p, googleConnected: false, googleEmail: null } : p));
    onToast('Kalender getrennt.');
  }

  if (!profile) return <div className="loading"><i /><h2>Profil wird geladen</h2><p>Deine persönlichen Einstellungen werden abgerufen.</p></div>;

  return (
    <div className="settings-grid">
      <article className="panel settings-panel">
        <div className="panel-head">
          <div><span className="eyebrow">MEIN PROFIL</span><h2>Name und Signatur</h2></div>
          <span className="conn-badge ok">● {profile.email}</span>
        </div>
        <p className="muted">Dieser Name erscheint als Absender in jeder E-Mail, die du verschickst, und füllt den Platzhalter <code>{'{{absender}}'}</code> in allen Vorlagen. Versendet wird weiterhin über das gemeinsame Pixelkiez-Postfach, damit Antworten bei euch beiden ankommen.</p>
        <div className="form-grid">
          <label>Anzeigename<input value={profile.displayName} onChange={e => set('displayName', e.target.value)} placeholder="Vor- und Nachname" /></label>
          <label>Telefon<input value={profile.phone} onChange={e => set('phone', e.target.value)} placeholder="030 …" /></label>
          <label className="full">Signatur<textarea rows={3} value={profile.signature} onChange={e => set('signature', e.target.value)} placeholder="Erscheint als {{signatur}} in Vorlagen" /></label>
        </div>
        <footer className="settings-actions">
          <button type="button" className="primary" disabled={saving} onClick={save}>{saving ? <span className="btn-spin" /> : 'Profil speichern'}</button>
        </footer>
      </article>

      <article className="panel settings-panel">
        <div className="panel-head">
          <div><span className="eyebrow">MEIN KALENDER</span><h2>Google-Kalender verbinden</h2></div>
          <span className={`conn-badge ${profile.googleConnected ? 'ok' : ''}`}>
            {profile.googleConnected ? `● ${profile.googleEmail || 'verbunden'}` : '○ nicht verbunden'}
          </span>
        </div>
        <p className="muted">Termine, die du im CRM anlegst, landen in <strong>deinem</strong> Kalender. Jeder verbindet sein eigenes Google-Konto — ihr seht dadurch getrennte Kalender, arbeitet aber auf denselben Kundendaten.</p>
        <label className="field">Kalender-ID (Standard „primary")<input value={profile.googleCalendarId} onChange={e => set('googleCalendarId', e.target.value)} placeholder="primary" /></label>
        <footer className="settings-actions">
          {profile.googleConnected
            ? <>
                <a className="dark" href="/api/auth/google/start">Neu autorisieren</a>
                <button type="button" className="danger-btn" onClick={disconnect}>Trennen</button>
              </>
            : <a className="primary" href="/api/auth/google/start">Mit Google verbinden</a>}
        </footer>
      </article>

      {team.length > 1 && (
        <article className="panel settings-panel">
          <div className="panel-head"><div><span className="eyebrow">TEAM</span><h2>Wer sonst noch Zugang hat</h2></div></div>
          <ul className="team-list">
            {team.map(member => (
              <li key={member.email}>
                <span><strong>{member.displayName}</strong><small>{member.email}</small></span>
                <em className={member.googleConnected ? 'ok' : ''}>{member.googleConnected ? 'Kalender verbunden' : 'kein Kalender'}</em>
              </li>
            ))}
          </ul>
        </article>
      )}
    </div>
  );
}
