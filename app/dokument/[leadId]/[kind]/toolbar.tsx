'use client';

/** Kopfleiste über Vertrag, Rechnung und Diagnose — wird beim Drucken ausgeblendet. */
export default function DocumentToolbar({ title }: { title: string }) {
  return (
    <header className="doc-bar">
      <div>
        <span className="eyebrow">PIXELKIEZ CRM</span>
        <h1>{title}</h1>
      </div>
      <div className="doc-bar-actions">
        <button type="button" className="ghost-btn" onClick={() => window.close()}>Schließen</button>
        <button type="button" className="primary" onClick={() => window.print()}>Drucken / als PDF sichern</button>
      </div>
    </header>
  );
}
