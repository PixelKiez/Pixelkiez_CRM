'use client';

import { FormEvent, useState } from 'react';

export default function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [reveal, setReveal] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        // Randständige Leerzeichen entstehen beim Einfügen aus Passwortmanagern
        // und beim Tippen auf Mobilgeräten — sie sind nie beabsichtigt.
        body: JSON.stringify({ email: email.trim(), password: password.trim() }),
      });
      const data = (await response.json()) as { ok?: boolean; error?: string };
      if (response.ok && data.ok) {
        // Vollständiger Reload, damit die Serverkomponenten die neue Session sehen.
        window.location.assign(next);
        return;
      }
      setError(data.error || 'Anmeldung fehlgeschlagen.');
    } catch {
      setError('Der Server ist nicht erreichbar.');
    }
    setBusy(false);
  }

  return (
    <main className="login-shell">
      <form className="login-card" onSubmit={submit}>
        <span className="brand-mark">P</span>
        <p className="eyebrow">PIXELKIEZ · CRM</p>
        <h1>Anmelden</h1>
        <p className="login-hint">Dieser Bereich ist privat. Bitte mit deinen Zugangsdaten anmelden.</p>

        <label>
          E-Mail-Adresse
          <input
            name="email"
            type="email"
            autoComplete="username"
            // Mobile Tastaturen schreiben sonst gross und korrigieren die Adresse.
            autoCapitalize="none"
            autoCorrect="off"
            spellCheck={false}
            required
            autoFocus
            value={email}
            onChange={event => setEmail(event.target.value)}
            placeholder="name@firma.de"
          />
        </label>

        <label>
          Passwort
          <span className="pw-field">
            <input
              name="password"
              type={reveal ? 'text' : 'password'}
              autoComplete="current-password"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              required
              value={password}
              onChange={event => setPassword(event.target.value)}
              placeholder="••••••••"
            />
            <button type="button" onClick={() => setReveal(v => !v)} aria-label={reveal ? 'Passwort verbergen' : 'Passwort anzeigen'}>
              {reveal ? 'verbergen' : 'anzeigen'}
            </button>
          </span>
        </label>

        {error && <p className="login-error" role="alert">⚠ {error}</p>}

        <button className="primary" type="submit" disabled={busy}>
          {busy ? <><i className="btn-spin" /> Anmelden …</> : 'Anmelden'}
        </button>
      </form>
    </main>
  );
}
