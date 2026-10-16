'use client';

import { useRef, useState } from 'react';
import { leadAnalysisStatusMessage, mapLeadAnalysisResponse, type LeadAnalysisUiStatus } from './lead-drawer-utils';

export default function LeadAnalysisPreview({ leadId }: { leadId: string }) {
  const [status, setStatus] = useState<LeadAnalysisUiStatus>('idle');
  const requestInFlight = useRef(false);

  async function requestAnalysisStatus() {
    if (requestInFlight.current) return;
    requestInFlight.current = true;
    setStatus('loading');
    try {
      const response = await fetch(`/api/leads/${encodeURIComponent(leadId)}/analysis`, {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        redirect: 'error',
        headers: { Accept: 'application/json' },
      });
      const payload: unknown = await response.json().catch(() => null);
      setStatus(mapLeadAnalysisResponse(response.status, payload));
    } catch {
      setStatus('unavailable');
    } finally {
      requestInFlight.current = false;
    }
  }

  return (
    <section className="smart-box" aria-labelledby="lead-analysis-title">
      <span>WEBSITE-ANALYSE · MANUELLER START</span>
      <strong id="lead-analysis-title">Website analysieren</strong>
      <p>
        Verwendet wird ausschließlich die serverseitig gespeicherte Lead-Website. In Phase A ist der
        PXAPI-Aufruf hart deaktiviert; es wird keine Website besucht und keine echte Analyse ausgeführt.
      </p>
      <div className="quick-buttons">
        <button type="button" className="ghost-btn" disabled={status === 'loading'} onClick={requestAnalysisStatus}>
          {status === 'loading' ? <><span className="btn-spin" /> Status wird geprüft …</> : 'Website analysieren'}
        </button>
      </div>
      <p role="status" aria-live="polite" aria-atomic="true">
        {leadAnalysisStatusMessage(status)}
      </p>
    </section>
  );
}
