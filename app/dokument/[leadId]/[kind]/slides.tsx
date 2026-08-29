'use client';

import { useCallback, useEffect, useState } from 'react';

/**
 * Bildschirmpräsentation fürs Verkaufsgespräch.
 * Pfeiltasten und Leertaste blättern, F schaltet auf Vollbild.
 */
export default function Slides({ slides, title, leadName }: { slides: string[]; title: string; leadName: string }) {
  const [index, setIndex] = useState(0);
  const count = slides.length;

  const go = useCallback((delta: number) => {
    setIndex(current => Math.min(count - 1, Math.max(0, current + delta)));
  }, [count]);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'ArrowRight' || event.key === ' ' || event.key === 'PageDown') { event.preventDefault(); go(1); }
      else if (event.key === 'ArrowLeft' || event.key === 'PageUp') { event.preventDefault(); go(-1); }
      else if (event.key === 'Home') { event.preventDefault(); setIndex(0); }
      else if (event.key === 'End') { event.preventDefault(); setIndex(count - 1); }
      else if (event.key.toLowerCase() === 'f') { event.preventDefault(); toggleFullscreen(); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, count, toggleFullscreen]);

  if (!count) {
    return (
      <main className="doc-shell">
        <div className="doc-empty">
          <h1>Präsentation ist leer</h1>
          <p>Die Vorlage enthält keinen Inhalt. Folien werden im Vorlagen-Editor mit <code>&lt;!-- folie --&gt;</code> voneinander getrennt.</p>
          <a className="primary" href="/">Zurück zum CRM</a>
        </div>
      </main>
    );
  }

  return (
    <main className="slides-shell">
      <header className="slides-bar">
        <div><span className="eyebrow">PRÄSENTATION</span><strong>{leadName}</strong></div>
        <div className="slides-actions">
          <span className="slides-count">{index + 1} / {count}</span>
          <button type="button" className="ghost-btn" onClick={toggleFullscreen}>Vollbild (F)</button>
          <button type="button" className="ghost-btn" onClick={() => window.print()}>Drucken</button>
          <button type="button" className="ghost-btn" onClick={() => window.close()}>Schließen</button>
        </div>
      </header>

      <section className="slide-stage" aria-label={title}>
        <button type="button" className="slide-nav prev" onClick={() => go(-1)} disabled={index === 0} aria-label="Vorherige Folie">‹</button>
        <article className="slide" key={index} dangerouslySetInnerHTML={{ __html: slides[index] }} />
        <button type="button" className="slide-nav next" onClick={() => go(1)} disabled={index === count - 1} aria-label="Nächste Folie">›</button>
      </section>

      <footer className="slides-dots">
        {slides.map((_, i) => (
          <button key={i} type="button" className={i === index ? 'active' : ''} onClick={() => setIndex(i)} aria-label={`Folie ${i + 1}`} />
        ))}
      </footer>

      {/* Beim Drucken alle Folien untereinander ausgeben. */}
      <div className="slides-print">
        {slides.map((slide, i) => <article key={i} className="slide" dangerouslySetInnerHTML={{ __html: slide }} />)}
      </div>
    </main>
  );
}
