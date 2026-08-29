'use client';

import { FormEvent, useState } from 'react';

export default function LoginForm({ next }: { next: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
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
        body: JSON.stringify({ email, password }),
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
        <span className="brand-mark">R</span>
        <p className="eyebrow">REINICKENDORF · AKQUISEZENTRALE</p>
        <h1>Anmelden</h1>
        <p className="login-hint">Dieser Bereich ist privat. Bitte mit deinen Zugangsdaten anmelden.</p>

        <label>
          E-Mail-Adresse
          <input
            name="email"
            type="email"
            autoComplete="username"
            required
            autoFocus
            value={email}
            onChange={event => setEmail(event.target.value)}
            placeholder="name@firma.de"
          />
        </label>

        <label>
          Passwort
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            value={password}
            onChange={event => setPassword(event.target.value)}
            placeholder="••••••••"
          />
        </label>

        {error && <p className="login-error" role="alert">⚠ {error}</p>}

        <button className="primary" type="submit" disabled={busy}>
          {busy ? <><i className="btn-spin" /> Anmelden …</> : 'Anmelden'}
        </button>
      </form>
    </main>
  );
}
