'use client';

import type { Lead } from '@/lib/types';

const label=(value:string|null)=>value?value.replaceAll('_',' ').replace(/\b\w/g,c=>c.toUpperCase()):'—';
const websiteTone=(value:string)=>value==='Ja'?'yes':value==='Nein'?'no':'check';
const websiteLabel=(value:string)=>value==='Ja'?'Bestätigt':value==='Nein'?'Keine':'Prüfen';

export default function Pipeline({leads,onOpen}:{leads:Lead[];onOpen:(l:Lead)=>void}){
  const columns:[string,string][]=[['Neu','Neu'],['E Mail gesendet','Angeschrieben'],['Recherche offen','Recherche'],['Erstgespräch geplant','Gespräch'],['Angebot gesendet','Angebot'],['Gewonnen','Gewonnen']];
  const excluded=leads.filter(l=>['Ausgeschlossen','Verloren'].includes(l.status)).length;
  return <div className="pipeline">
    <div className="pipeline-intro"><h2>Akquise-Pipeline</h2><p>Vom neuen Unternehmen bis zum gewonnenen Kunden. Statusänderungen passieren in der Detailansicht.{excluded>0?` · ${excluded} ausgeschlossene oder verlorene Unternehmen sind nicht im Funnel (Filter „Status: Ausgeschlossen").`:''}</p></div>
    <div className="pipeline-grid">
      {columns.map(([status,title])=>{
        const items=leads.filter(l=>l.status===status);
        return <section className="pipeline-column" key={status}>
          <header><span>{title}</span><b>{items.length}</b></header>
          {items.slice(0,15).map(lead=><button key={lead.id} onClick={()=>onOpen(lead)}>
            <strong>{lead.name}</strong><small>{label(lead.category)}</small>
            <span><i>{lead.score}</i><em className={websiteTone(lead.websiteStatus)}>● {websiteLabel(lead.websiteStatus)}</em></span>
          </button>)}
          {!items.length&&<p>Noch keine Leads</p>}
        </section>;})}
    </div>
  </div>;
}
